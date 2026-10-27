import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { AnalysisTrace, type TraceEvent } from '../src/lib/diagnostics.js';
import { AppError } from '../src/lib/errors.js';
import { createMetaClient, type MetaClient } from '../src/lib/meta-client.js';
import { createSamService } from '../src/services/sam.js';
import { createVisionService } from '../src/services/vision.js';
import {
  imageBytes,
  multipartBody,
  samEnvelope,
  completion,
  testConfig,
} from './helpers.js';

const waitForAbort: typeof fetch = async (_url, options) =>
  new Promise((_resolve, reject) => {
    const signal = options!.signal!;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });

test('a later parent deadline cannot relabel an already-expired provider deadline', async () =>
  withKeepAlive(async () => {
    const parent = new AbortController();
    const client = createMetaClient(
      testConfig({ PROVIDER_TIMEOUT_MS: '15', PROVIDER_MAX_RETRIES: '0' }),
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            'abort',
            () => {
              parent.abort(
                new AppError(
                  504,
                  'ANALYSIS_TIMEOUT',
                  'Later overall deadline.',
                  { source: 'backend_analysis', elapsedMs: 15 },
                ),
              );
              reject(options!.signal!.reason);
            },
            { once: true },
          );
        }),
    );
    await assert.rejects(
      client.post('responses', { model: 'sam-3.1' }, parent.signal, {
        stage: 'sam.led',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'PROVIDER_TIMEOUT' &&
        error.details?.source === 'backend_provider',
    );
  }));

async function withKeepAlive(work: () => Promise<void>) {
  const timer = setTimeout(() => undefined, 2000);
  try {
    await work();
  } finally {
    clearTimeout(timer);
  }
}

test('provider deadline identifies model, stage, attempt, phase, budget, and retry timings without logging inputs', async () =>
  withKeepAlive(async () => {
    const events: TraceEvent[] = [];
    const requestId = randomUUID();
    const trace = new AnalysisTrace(requestId, (event) => events.push(event));
    const client = createMetaClient(
      testConfig({ PROVIDER_TIMEOUT_MS: '15' }),
      waitForAbort,
    );
    await assert.rejects(
      client.post(
        'responses',
        { model: 'sam-3.1', input: 'private-photograph-and-prompt' },
        new AbortController().signal,
        { stage: 'sam.led', trace },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'PROVIDER_TIMEOUT');
        assert.equal(error.details?.source, 'backend_provider');
        assert.equal(error.details?.stage, 'sam.led');
        assert.equal(error.details?.model, 'sam-3.1');
        assert.equal(error.details?.attempt, 2);
        assert.equal(error.details?.phase, 'awaiting_response');
        assert.equal(error.details?.timeoutMs, 15);
        assert.ok(error.details!.elapsedMs >= 10);
        return true;
      },
    );
    const timings = trace.snapshot().timings;
    assert.deepEqual(
      timings.map((timing) => timing.status),
      ['timed_out', 'completed', 'timed_out'],
    );
    assert.equal(timings[1]!.kind, 'retry_delay');
    assert.equal(
      events.filter((event) => event.event === 'vision.provider_retry').length,
      1,
    );
    assert.ok(events.every((event) => event.requestId === requestId));
    assert.doesNotMatch(
      JSON.stringify(events),
      /private-photograph|test-provider-key|input|Authorization/,
    );
  }));

test('Meta HTTP 504 is distinct from a backend timer and does not expose the upstream body', async () => {
  const client = createMetaClient(
    testConfig({ PROVIDER_MAX_RETRIES: '0' }),
    async () =>
      Response.json({ error: 'private-provider-response' }, { status: 504 }),
  );
  await assert.rejects(
    client.post(
      'chat/completions',
      { model: 'muse-spark-1.3' },
      new AbortController().signal,
      { stage: 'muse.interpret' },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'META_API_TIMEOUT');
      assert.equal(error.details?.source, 'meta_api');
      assert.equal(error.details?.stage, 'muse.interpret');
      assert.equal(error.details?.upstreamStatus, 504);
      assert.equal(error.details?.timeoutMs, undefined); // Meta's own deadline is unknown.
      assert.doesNotMatch(JSON.stringify(error), /private-provider-response/);
      return true;
    },
  );
});

test('a stalled response body reports the reading phase rather than a connection wait', async () =>
  withKeepAlive(async () => {
    const client = createMetaClient(
      testConfig({ PROVIDER_TIMEOUT_MS: '15', PROVIDER_MAX_RETRIES: '0' }),
      async (_url, options) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
              options!.signal!.addEventListener(
                'abort',
                () => controller.error(options!.signal!.reason),
                { once: true },
              );
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    await assert.rejects(
      client.post(
        'responses',
        { model: 'sam-3.1' },
        new AbortController().signal,
        { stage: 'sam.resistor' },
      ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'PROVIDER_TIMEOUT' &&
        error.details?.phase === 'reading_response',
    );
  }));

test('backend deadline preserves active stages and a single request ID through HTTP errors and logs', async (t) => {
  const config = testConfig({
    ANALYSIS_TIMEOUT_MS: '60',
    PROVIDER_TIMEOUT_MS: '500',
    PROVIDER_MAX_RETRIES: '0',
  });
  const events: TraceEvent[] = [];
  const client = createMetaClient(config, waitForAbort);
  const app = await buildApp(
    config,
    createVisionService(config, client),
    (event) => events.push(event),
  );
  t.after(() => app.close());
  const requestId = randomUUID();
  const upload = multipartBody(await imageBytes());
  await withKeepAlive(async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/vision/analyze',
      ...upload,
      headers: { ...upload.headers, 'x-request-id': requestId },
    });
    assert.equal(response.statusCode, 504, response.body);
    const error = response.json().error;
    assert.equal(error.requestId, requestId);
    assert.equal(response.headers['x-request-id'], requestId);
    assert.equal(error.code, 'ANALYSIS_TIMEOUT');
    assert.equal(error.details.source, 'backend_analysis');
    assert.equal(error.details.timeoutMs, 60);
    assert.deepEqual(error.details.activeStages, ['sam.breadboard']);
    assert.equal(error.details.timings.at(-1).status, 'timed_out');
    assert.equal(error.details.timings.at(-1).code, 'ANALYSIS_TIMEOUT');
    assert.ok(events.every((event) => event.requestId === requestId));
  });
});

test('successful analyses expose the same request ID and safe per-stage timings', async (t) => {
  const config = testConfig();
  const client: MetaClient = {
    async post(path) {
      return path === 'chat/completions'
        ? completion({ objects: [], missingWires: [] })
        : samEnvelope('');
    },
  };
  const app = await buildApp(config, createVisionService(config, client));
  t.after(() => app.close());
  assert.ok(
    (app.initialConfig.connectionTimeout ?? 0) > config.ANALYSIS_TIMEOUT_MS,
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/vision/analyze',
    ...multipartBody(await imageBytes()),
  });
  assert.equal(response.statusCode, 200);
  const diagnostics = response.json().diagnostics;
  assert.equal(diagnostics.requestId, response.headers['x-request-id']);
  assert.deepEqual(
    diagnostics.timings.map((timing: { stage: string }) => timing.stage),
    ['upload', 'image.prepare', 'response.validate'],
  );
  // A custom injected client owns its own instrumentation; production uses createMetaClient.
  assert.ok(
    diagnostics.timings.every(
      (timing: { status: string }) => timing.status === 'completed',
    ),
  );
});

test('SAM uses at most two requests concurrently while retaining all four categories', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const client: MetaClient = {
    async post() {
      active++;
      calls++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return samEnvelope('');
    },
  };
  const result = await createSamService(
    testConfig({ SAM_CONCURRENCY: '2' }),
    client,
  )({ width: 100, height: 80, dataUrl: 'test' }, new AbortController().signal);
  assert.deepEqual(result, []);
  assert.equal(peak, 2);
  assert.equal(calls, 4);
  assert.equal(active, 0);
});

test('a failed SAM call cancels and settles its sibling before returning the original failure', async () => {
  let calls = 0;
  let cancelled = false;
  const failure = new AppError(504, 'PROVIDER_TIMEOUT', 'Deadline exceeded.', {
    source: 'backend_provider',
    stage: 'sam.breadboard',
    elapsedMs: 10,
  });
  const client: MetaClient = {
    async post(_path, _body, signal) {
      const call = ++calls;
      if (call === 1) {
        await delay(5);
        throw failure;
      }
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
  };
  await assert.rejects(
    createSamService(testConfig({ SAM_CONCURRENCY: '2' }), client)(
      { width: 100, height: 80, dataUrl: 'test' },
      new AbortController().signal,
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(calls, 2);
  assert.equal(cancelled, true);
});
