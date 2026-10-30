import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import {
  JobStore,
  lastAttempt,
  newAttempt,
  publicJob,
} from '../src/jobs/store.js';
import { AnalysisWorker } from '../src/jobs/worker.js';
import { AppError } from '../src/lib/errors.js';
import { createVisionStages } from '../src/services/vision.js';
import { prepareImage } from '../src/services/image.js';
import { partialAnalysis } from '../src/services/partial-analysis.js';
import { museInput } from '../src/services/muse-image.js';
import { createReasoningService } from '../src/services/reasoning.js';
import { createMetaClient } from '../src/lib/meta-client.js';
import { AnalysisTrace } from '../src/lib/diagnostics.js';
import { randomUUID } from 'node:crypto';
import {
  completion,
  imageBytes,
  multipartBody,
  samEnvelope,
  samWireRecord,
  testConfig,
} from './helpers.js';

async function until(predicate: () => boolean, timeout = 3500) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Job did not reach expected state');
    await delay(5);
  }
}
const review = {
  objects: [{ id: 'jumper_wire_1', decision: 'confirmed', color: 'red' }],
  breadboardCandidates: [],
  breadboardGroups: [],
  missingWires: [],
};

test('202 upload commits first; Muse timeout retains SAM, duplicate retry conflicts, retry sends zero SAM calls', async (t) => {
  const config = testConfig();
  const store = new JobStore(config, ':memory:');
  let samCalls = 0,
    museCalls = 0;
  const stages = createVisionStages(config, {
    async post(path, body, _signal, operation) {
      if (path === 'responses') {
        samCalls++;
        const prompt = (body.input as { content: { text: string }[] }[])[0]!
          .content[0]!.text;
        return samEnvelope(prompt === 'wire' ? samWireRecord() : '');
      }
      museCalls++;
      assert.equal(operation!.maxRetries, 0);
      if (museCalls === 1)
        throw new AppError(504, 'PROVIDER_TIMEOUT', 'Deadline');
      // A missed wire must remain a region, not secretly trigger SAM during a Muse-only retry.
      return completion({
        ...review,
        missingWires: [
          {
            box: [200, 200, 500, 500],
            color: null,
            positivePoints: [[300, 300]],
            negativePoints: [],
          },
        ],
      });
    },
  });
  const app = await buildApp(config, undefined, () => undefined, undefined, {
    store,
    stages,
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/analyses',
    ...multipartBody(await imageBytes()),
  });
  assert.equal(response.statusCode, 202);
  const id = response.json().analysisId as string;
  assert.equal(store.image(id).length > 0, true);
  await until(() => store.get(id).muse.status === 'timed_out');
  const partial = store.get(id);
  assert.equal(samCalls, 4);
  assert.equal(museCalls, 1);
  assert.equal(partial.sam.status, 'succeeded');
  assert.equal(partial.status, 'partial');
  assert.equal(
    partial.sam.snapshot!.candidates[0]!.encodedMask!.payload.length > 0,
    true,
  );
  assert.equal(partial.sam.result!.objects[0]!.reviewStatus, 'sam_unverified');
  assert.equal(partial.sam.result!.objects[0]!.mask!.path.length > 0, true);
  assert.equal(lastAttempt(partial, 'muse')!.upstreamOutcome, 'unknown');
  assert.equal(lastAttempt(partial, 'muse')!.retryPolicy, 'manual_only');
  const exposed = publicJob(partial);
  assert.equal('snapshot' in exposed.sam, false);
  const retries = await Promise.all(
    [1, 2].map(() =>
      app.inject({ method: 'POST', url: `/api/analyses/${id}/retry-muse` }),
    ),
  );
  assert.deepEqual(retries.map((r) => r.statusCode).sort(), [202, 409]);
  await until(() => store.get(id).status === 'completed');
  assert.equal(samCalls, 4);
  assert.equal(museCalls, 2);
  assert.equal(store.get(id).muse.attempts.length, 2);
  assert.equal(store.get(id).muse.attempts[0]!.status, 'timed_out');
  assert.notEqual(
    store.get(id).muse.attempts[0]!.attemptId,
    store.get(id).muse.attempts[1]!.attemptId,
  );
  assert.equal(
    store.get(id).muse.result!.proposals![0]!.reason,
    'budget_exhausted',
  );
  assert.equal(
    (await app.inject(`/api/analyses/${id}/image`)).rawPayload.equals(
      store.image(id),
    ),
    true,
  );
});

test('stopping observation does not stop a server job; shutdown interrupts adapters that ignore abort', async (t) => {
  const config = testConfig();
  const store = new JobStore(config, ':memory:');
  const image = await prepareImage(await imageBytes(), config);
  const job = store.create(await imageBytes(), image);
  let release!: (value: ReturnType<typeof partialAnalysis>) => void;
  const worker = new AnalysisWorker(store, config, () => undefined, {
    async segment(image) {
      return { image, candidates: [] };
    },
    interpret() {
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  t.after(async () => {
    await worker.close();
    store.close();
  });
  worker.start();
  await until(() => store.get(job.analysisId).muse.status === 'running');
  // No HTTP observer is attached; the independently executing worker reached Muse.
  await worker.close();
  assert.equal(store.get(job.analysisId).muse.status, 'interrupted');
  assert.equal(
    lastAttempt(store.get(job.analysisId), 'muse')!.retryPolicy,
    'manual_only',
  );
  release(partialAnalysis({ image, candidates: [] }, config));
  await delay(5);
  assert.equal(store.get(job.analysisId).muse.status, 'interrupted');
});

test('disk restart preserves the checkpoint; expired running attempts become interrupted without redispatch', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-jobs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = testConfig();
  let store = new JobStore(config, directory);
  const bytes = await imageBytes(),
    image = await prepareImage(bytes, config);
  const job = store.create(bytes, image);
  job.sam.status = 'succeeded';
  lastAttempt(job, 'sam')!.status = 'succeeded';
  job.sam.result = partialAnalysis(job.sam.snapshot!, config);
  job.muse.status = 'queued';
  job.muse.attempts.push(newAttempt());
  store.save(job);
  const claim = store.claim('dead-worker')!;
  assert.equal(claim.stage, 'muse');
  const running = store.get(job.analysisId);
  running.leaseUntil = Date.now() - 1;
  store.save(running);
  store.close();
  store = new JobStore(config, directory);
  let calls = 0;
  const worker = new AnalysisWorker(store, config, () => undefined, {
    async segment() {
      calls++;
      throw new Error();
    },
    async interpret() {
      calls++;
      throw new Error();
    },
  });
  t.after(async () => {
    await worker.close();
    store.close();
  });
  worker.start();
  assert.equal(store.get(job.analysisId).muse.status, 'interrupted');
  assert.equal(calls, 0);
  assert.equal(store.get(job.analysisId).sam.status, 'succeeded');
  assert.equal(store.image(job.analysisId).equals(bytes), true);
  assert.equal(
    statSync(join(directory, 'analyses.sqlite')).mode & 0o777,
    0o600,
  );
  // An old attempt cannot write after recovery, even after a new attempt is claimed.
  store.retry(job.analysisId, 'muse');
  const next = store.claim('new-worker')!;
  assert.notEqual(next.attemptId, claim.attemptId);
  assert.equal(
    store.renewLease(job.analysisId, 'dead-worker', 'muse', claim.attemptId),
    false,
  );
  assert.equal(
    store.owned(job.analysisId, 'dead-worker', 'muse', claim.attemptId, (j) => {
      j.status = 'completed';
    }),
    false,
  );
  assert.equal(store.get(job.analysisId).muse.status, 'running');
});

test('claims enforce global capacity across SQLite connections and preserve queued non-dispatch', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-jobs-'));
  const config = testConfig({ MAX_CONCURRENT_ANALYSES: '1' });
  const a = new JobStore(config, directory),
    b = new JobStore(config, directory);
  t.after(() => {
    a.close();
    b.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const bytes = await imageBytes(),
    image = await prepareImage(bytes, config);
  const first = a.create(bytes, image),
    second = a.create(bytes, image);
  const claim = a.claim('first')!;
  assert.equal(claim.job.analysisId, first.analysisId);
  assert.equal(b.claim('second'), undefined);
  assert.equal(
    lastAttempt(b.get(second.analysisId), 'sam')!.upstreamOutcome,
    'not_sent',
  );
  assert.equal(lastAttempt(b.get(second.analysisId), 'sam')!.status, 'queued');
});

test('retention and capacity bound persisted photographs; active jobs cannot be deleted', async (t) => {
  const config = testConfig({ MAX_STORED_JOBS: '1' }),
    store = new JobStore(config, ':memory:');
  t.after(() => store.close());
  const bytes = await imageBytes(),
    image = await prepareImage(bytes, config),
    job = store.create(bytes, image);
  assert.throws(() => store.create(bytes, image), /capacity/);
  store.claim('worker');
  assert.throws(() => store.remove(job.analysisId), /active attempt/);
  const j = store.get(job.analysisId);
  j.leaseUntil = 0;
  j.expiresAt = 0;
  store.save(j);
  store.recover();
  store.cleanup();
  assert.throws(() => store.get(job.analysisId), /not found/);
  assert.ok(store.create(bytes, image));
});

test('Muse resizing scales candidate boxes only; normalized output maps into original geometry', async () => {
  const config = testConfig({
    MUSE_MAX_DIMENSION: '1280',
    MUSE_MINIMAL_PROMPT: 'true',
  });
  const image = await prepareImage(await imageBytes(2048, 1352), config);
  const c = {
    id: 'led_1',
    type: 'led' as const,
    bbox: [1024, 676, 200, 100] as [number, number, number, number],
  };
  const input = await museInput(image, [c], 1280);
  assert.equal(input.image.width, 1280);
  assert.equal(input.image.height, 845);
  assert.deepEqual(input.candidates[0]!.bbox, [640, 422, 125, 63]);
  assert.deepEqual(c.bbox, [1024, 676, 200, 100]);
  let prompt = '';
  const reasoning = createReasoningService(config, {
    async post(_path, body, _signal, operation) {
      const messages = body.messages as { content: { text?: string }[] }[];
      prompt = messages[1]!.content[0]!.text!;
      assert.equal(operation!.maxRetries, 0);
      assert.deepEqual(operation!.imageDimensions, [
        { width: 1280, height: 845 },
      ]);
      return completion({
        ...review,
        objects: [{ id: 'led_1', decision: 'confirmed', color: null }],
      });
    },
  });
  await reasoning.interpret(image, [c], new AbortController().signal);
  assert.match(prompt, /1280x845/);
  assert.match(prompt, /640,422,125,63/);
  assert.doesNotMatch(prompt, /Then independently inspect/);
  assert.match(prompt, /Never treat a single part as a complete board/);
});

test('initial Muse deadline has one provider call, with safe payload and header diagnostics', async () => {
  const config = testConfig({
    PROVIDER_TIMEOUT_MS: '10',
    PROVIDER_MAX_RETRIES: '2',
  });
  let calls = 0;
  const client = createMetaClient(config, async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) =>
      init!.signal!.addEventListener(
        'abort',
        () => reject(init!.signal!.reason),
        { once: true },
      ),
    );
  });
  const image = await prepareImage(await imageBytes(), config),
    trace = new AnalysisTrace(randomUUID(), () => undefined);
  // Keep the event loop alive because provider deadline timers are intentionally unref'd.
  const keepAlive = setInterval(() => undefined, 100);
  try {
    await assert.rejects(
      createReasoningService(config, client).interpret(
        image,
        [],
        new AbortController().signal,
        trace,
      ),
      /timed out/,
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(calls, 1);
  const timing = trace.snapshot().timings.find((t) => t.kind === 'request')!;
  assert.equal(timing.timeoutType, 'local_deadline');
  assert.ok(timing.payloadBytes! > timing.encodedImageBytes!);
  assert.ok(timing.promptChars! > 0);
  assert.equal(timing.imageCount, 1);
  assert.ok(timing.outputSchemaBytes! > 0);
  assert.ok(
    trace
      .snapshot()
      .timings.some(
        (t) => t.stage === 'muse.prepare' && t.status === 'completed',
      ),
  );
  assert.equal(timing.headersMs, undefined);
  assert.deepEqual(timing.imageDimensions, [{ width: 100, height: 80 }]);
  const successTrace = new AnalysisTrace(randomUUID(), () => undefined);
  await createMetaClient(testConfig(), async () =>
    Response.json(
      { ok: true },
      { headers: { 'x-request-id': 'provider-123' } },
    ),
  ).post('chat/completions', { model: 'test' }, new AbortController().signal, {
    stage: 'muse.interpret',
    trace: successTrace,
    maxRetries: 0,
  });
  assert.equal(
    successTrace.snapshot().timings.find((t) => t.kind === 'request')!
      .providerRequestId,
    'provider-123',
  );
  assert.equal(
    typeof successTrace.snapshot().timings.find((t) => t.kind === 'request')!
      .headersMs,
    'number',
  );
});
