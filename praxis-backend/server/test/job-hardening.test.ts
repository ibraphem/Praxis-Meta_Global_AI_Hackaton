import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import {
  JobStore,
  newAttempt,
  lastAttempt,
  publicJob,
} from '../src/jobs/store.js';
import { AnalysisWorker } from '../src/jobs/worker.js';
import { runMuseExperiment } from '../src/jobs/muse-experiment.js';
import { exportJobEvidence } from '../src/jobs/evidence.js';
import { snapshotHash } from '../src/jobs/snapshots.js';
import { prepareImage } from '../src/services/image.js';
import { partialAnalysis } from '../src/services/partial-analysis.js';
import { AppError } from '../src/lib/errors.js';
import { buildApp } from '../src/app.js';
import type { PreparedImage, Analysis } from '../src/schemas/vision.js';
import { imageBytes, testConfig, multipartBody } from './helpers.js';

const fullResult = (image: PreparedImage): Analysis => ({
  image: { width: image.width, height: image.height },
  objects: [],
  provenance: {
    mode: 'combined',
    segmentationModel: 'sam-test',
    reasoningModel: 'muse-test',
  },
});
async function until(predicate: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end)
      throw new Error('Expected worker state was not reached.');
    await delay(5);
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function checkpointed(store: JobStore) {
  const bytes = await imageBytes(),
    image = await prepareImage(bytes, store.config),
    job = store.create(bytes, image);
  job.sam.status = 'succeeded';
  Object.assign(lastAttempt(job, 'sam')!, {
    status: 'succeeded',
    retryPolicy: 'not_retryable',
    upstreamOutcome: 'response_received',
  });
  job.sam.result = partialAnalysis(job.sam.snapshot!, store.config);
  const attempt = newAttempt();
  Object.assign(attempt, {
    status: 'timed_out',
    retryPolicy: 'manual_only',
    upstreamOutcome: 'unknown',
  });
  job.muse.status = 'timed_out';
  job.muse.attempts = [attempt];
  job.status = 'partial';
  store.save(job);
  return store.get(job.analysisId);
}

test('persisted queue defaults to one and its override is independent of legacy admission', async (t) => {
  const config = testConfig({ MAX_CONCURRENT_ANALYSES: '8' });
  assert.equal(config.JOB_WORKER_CONCURRENCY, 1);
  const dir = mkdtempSync(join(tmpdir(), 'praxis-queue-')),
    a = new JobStore(config, dir),
    b = new JobStore(config, dir);
  t.after(() => {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const bytes = await imageBytes(),
    image = await prepareImage(bytes, config);
  a.create(bytes, image);
  a.create(bytes, image);
  assert.ok(a.claim('one'));
  assert.equal(b.claim('two'), undefined);
  const override = new JobStore(
    testConfig({ MAX_CONCURRENT_ANALYSES: '1', JOB_WORKER_CONCURRENCY: '2' }),
    ':memory:',
  );
  try {
    override.create(bytes, image);
    override.create(bytes, image);
    override.create(bytes, image);
    assert.ok(override.claim('a'));
    assert.ok(override.claim('b'));
    assert.equal(override.claim('c'), undefined);
  } finally {
    override.close();
  }
});

test('a pending legacy request does not consume the separately configured job queue slot', async (t) => {
  const config = testConfig({ MAX_CONCURRENT_ANALYSES: '1' }),
    store = new JobStore(config, ':memory:'),
    pending = deferred<Analysis>();
  let legacyStarted = false;
  const app = await buildApp(
    config,
    async () => {
      legacyStarted = true;
      return pending.promise;
    },
    () => undefined,
    undefined,
    {
      store,
      stages: {
        async segment(image) {
          return { image, candidates: [] };
        },
        async interpret(snapshot) {
          return fullResult(snapshot.image);
        },
      },
    },
  );
  t.after(async () => {
    pending.resolve(fullResult(await prepareImage(await imageBytes(), config)));
    await app.close();
    store.close();
  });
  const bytes = await imageBytes(),
    legacy = app.inject({
      method: 'POST',
      url: '/api/vision/analyze',
      ...multipartBody(bytes),
    });
  void legacy.then(() => undefined);
  await until(() => legacyStarted);
  const queued = await app.inject({
    method: 'POST',
    url: '/api/analyses',
    ...multipartBody(bytes),
  });
  assert.equal(queued.statusCode, 202);
  await until(() => store.get(queued.json().analysisId).status === 'completed');
  pending.resolve(fullResult(await prepareImage(bytes, config)));
  assert.equal((await legacy).statusCode, 200);
});

for (const outcome of [
  'late_success',
  'late_failure',
  'heartbeat_loss',
] as const)
  test(`lease takeover fences a pending old provider request: ${outcome}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'praxis-lease-')),
      config = testConfig(),
      a = new JobStore(config, directory),
      b = new JobStore(config, directory);
    const job = await checkpointed(a);
    a.retry(job.analysisId, 'muse');
    const old = deferred<Analysis>(),
      next = deferred<Analysis>();
    let oldSignal: AbortSignal | undefined;
    const workerA = new AnalysisWorker(a, config, () => undefined, {
      async segment() {
        throw new Error('SAM must not rerun');
      },
      interpret(_snapshot, signal) {
        oldSignal = signal;
        return old.promise;
      },
    });
    const workerB = new AnalysisWorker(b, config, () => undefined, {
      async segment() {
        throw new Error('SAM must not rerun');
      },
      interpret() {
        return next.promise;
      },
    });
    t.after(async () => {
      await workerA.close();
      await workerB.close();
      a.close();
      b.close();
      rmSync(directory, { recursive: true, force: true });
    });
    workerA.start();
    await until(() => oldSignal !== undefined);
    const oldAttempt = lastAttempt(a.get(job.analysisId), 'muse')!.attemptId;
    const expired = a.get(job.analysisId);
    expired.leaseUntil = Date.now() - 1;
    a.save(expired);
    b.recover();
    assert.equal(b.get(job.analysisId).muse.status, 'interrupted');
    b.retry(job.analysisId, 'muse');
    workerB.start();
    await until(() => b.get(job.analysisId).owner === workerB.owner);
    const currentAttempt = lastAttempt(
      b.get(job.analysisId),
      'muse',
    )!.attemptId;
    assert.notEqual(currentAttempt, oldAttempt);
    assert.equal(
      a.renewLease(job.analysisId, workerA.owner, 'muse', oldAttempt),
      false,
    );
    assert.equal(
      a.renewLease(job.analysisId, workerB.owner, 'muse', oldAttempt),
      false,
    );
    if (outcome === 'heartbeat_loss')
      await until(() => oldSignal!.aborted, 4500);
    if (outcome === 'late_failure')
      old.reject(new AppError(502, 'PROVIDER_ERROR', 'Old provider failure'));
    else old.resolve(fullResult(job.sam.snapshot!.image));
    await delay(15);
    const after = b.get(job.analysisId);
    assert.equal(after.owner, workerB.owner);
    assert.equal(after.muse.status, 'running');
    assert.equal(after.muse.result, undefined);
    assert.equal(lastAttempt(after, 'muse')!.attemptId, currentAttempt);
    assert.equal(after.muse.attempts[1]!.status, 'interrupted');
    assert.equal(
      b.renewLease(job.analysisId, workerB.owner, 'muse', currentAttempt),
      true,
    );
    next.resolve(fullResult(job.sam.snapshot!.image));
    await until(() => b.get(job.analysisId).status === 'completed');
    assert.equal(b.get(job.analysisId).muse.resultAttemptId, currentAttempt);
    assert.equal(b.get(job.analysisId).revision, currentAttempt);
  });

test('immutable checkpoints bind retries and preserve historical predictions across new checkpoints', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  const job = await checkpointed(store),
    original = job.sam.snapshotRef!;
  assert.equal(
    snapshotHash(job.sam.snapshot!, original),
    original.samSnapshotHash,
  );
  assert.throws(
    () =>
      store.db
        .prepare('UPDATE sam_snapshots SET data=? WHERE id=?')
        .run('{}', original.samSnapshotId),
    /immutable/,
  );
  const changed = store.get(job.analysisId);
  changed.sam.snapshot!.candidates.push({
    id: 'led_1',
    type: 'led',
    bbox: [1, 1, 4, 4],
  });
  assert.throws(() => store.save(changed), /cannot be overwritten/);
  const current = store.get(job.analysisId);
  assert.equal(current.sam.snapshot!.candidates.length, 0);
  assert.throws(() => store.retry(job.analysisId, 'sam'), /not eligible/);
  const newSam = newAttempt();
  newSam.status = 'succeeded';
  current.sam.attempts.push(newSam);
  const replacement = structuredClone(current.sam.snapshot!);
  replacement.candidates.push({ id: 'led_1', type: 'led', bbox: [1, 1, 4, 4] });
  store.transaction(() => {
    store.checkpointSnapshot(current, replacement, newSam.attemptId);
    store.save(current);
  });
  const next = store.retry(job.analysisId, 'muse'),
    newRef = next.sam.snapshotRef!;
  assert.notEqual(newRef.samSnapshotId, original.samSnapshotId);
  assert.notEqual(newRef.samSnapshotHash, original.samSnapshotHash);
  assert.equal(next.muse.attempts[0]!.samSnapshotId, original.samSnapshotId);
  assert.equal(lastAttempt(next, 'muse')!.samSnapshotId, newRef.samSnapshotId);
  assert.equal(lastAttempt(next, 'muse')!.snapshotBinding, 'recorded');
  assert.equal(store.snapshots(job.analysisId).length, 2);
  assert.equal(
    store.getSnapshot(original.samSnapshotId).snapshot.candidates.length,
    0,
  );
});

test('legacy checkpoint migration preserves data and timestamps and labels historical bindings as inferred', async (t) => {
  const memory = new JobStore(testConfig(), ':memory:'),
    source = await checkpointed(memory);
  const legacy = structuredClone(source);
  delete legacy.sam.snapshotRef;
  for (const attempt of [...legacy.sam.attempts, ...legacy.muse.attempts]) {
    delete attempt.samSnapshotId;
    delete attempt.samSnapshotHash;
    delete attempt.snapshotBinding;
  }
  legacy.muse.result = fullResult(legacy.sam.snapshot!.image);
  legacy.muse.status = 'succeeded';
  legacy.status = 'completed';
  lastAttempt(legacy, 'muse')!.status = 'succeeded';
  legacy.revision = lastAttempt(legacy, 'muse')!.attemptId;
  legacy.updatedAt = 12345;
  memory.close();
  const directory = mkdtempSync(join(tmpdir(), 'praxis-migrate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const raw = new DatabaseSync(join(directory, 'analyses.sqlite'));
  raw.exec(
    'CREATE TABLE jobs (id TEXT PRIMARY KEY,data TEXT NOT NULL,image BLOB NOT NULL)',
  );
  raw
    .prepare('INSERT INTO jobs VALUES (?,?,?)')
    .run(legacy.analysisId, JSON.stringify(legacy), await imageBytes());
  raw.close();
  let store = new JobStore(testConfig(), directory);
  const migrated = store.get(legacy.analysisId),
    ref = migrated.sam.snapshotRef!;
  assert.equal(migrated.updatedAt, 12345);
  assert.deepEqual(migrated.sam.snapshot, legacy.sam.snapshot);
  assert.deepEqual(migrated.muse.result, legacy.muse.result);
  assert.equal(ref.origin, 'legacy_import');
  assert.equal(
    lastAttempt(migrated, 'muse')!.snapshotBinding,
    'legacy_inferred',
  );
  assert.equal(migrated.muse.resultAttemptId, legacy.revision);
  assert.deepEqual(lastAttempt(migrated, 'muse')!.result, legacy.muse.result);
  assert.equal('result' in publicJob(migrated).muse.attempts[0]!, false);
  store.close();
  store = new JobStore(testConfig(), directory);
  assert.deepEqual(store.get(legacy.analysisId).sam.snapshotRef, ref);
  store.close();
});

test('experiment reservation is exclusive, pauses jobs and legacy admission, and requires manual interrupted release', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-experiment-')),
    config = testConfig(),
    a = new JobStore(config, directory),
    b = new JobStore(config, directory);
  t.after(() => {
    a.close();
    b.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const job = await checkpointed(a);
  const legacyRelease = b.experiments.enterLegacyRequest();
  assert.throws(
    () => a.experiments.reserve(job.analysisId),
    /active job and legacy/,
  );
  legacyRelease();
  const reservation = a.experiments.reserve(job.analysisId);
  assert.throws(() => b.experiments.reserve(job.analysisId), /reservation/);
  assert.throws(() => b.retry(job.analysisId, 'muse'), /reserved/);
  assert.throws(() => b.experiments.enterLegacyRequest(), /reserved/);
  const queued = b.create(await imageBytes(), job.sam.snapshot!.image);
  assert.equal(b.claim('blocked'), undefined);
  assert.throws(() => b.remove(job.analysisId), /active attempt/);
  const expired = a.get(job.analysisId);
  expired.expiresAt = 0;
  a.save(expired);
  b.cleanup();
  assert.ok(b.get(job.analysisId));
  a.db
    .prepare('UPDATE experiments SET lease_until=? WHERE id=?')
    .run(Date.now() - 1, reservation.experimentId);
  b.recover();
  assert.equal(b.experiments.active()!.status, 'interrupted');
  assert.equal(
    a.experiments.renew(reservation.experimentId, reservation.owner!),
    false,
  );
  assert.equal(
    a.experiments.record(
      reservation.experimentId,
      reservation.owner!,
      { bad: 'late' },
      'completed',
    ),
    false,
  );
  assert.equal(b.claim('still-blocked'), undefined);
  b.experiments.releaseInterrupted(reservation.experimentId);
  assert.equal(b.claim('resumed')!.job.analysisId, queued.analysisId);
});

test('three-variant runner persists isolated results against one snapshot without changing source predictions', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  const job = await checkpointed(store);
  const before = store.db
    .prepare('SELECT data FROM jobs WHERE id=?')
    .get(job.analysisId)!.data;
  const seen: { dimension: number; minimal: boolean; hash: string }[] = [];
  const report = await runMuseExperiment(store, job.analysisId, store.config, {
    stagesFactory: (settings) => ({
      async segment() {
        throw new Error('SAM must not run');
      },
      async interpret(snapshot) {
        assert.throws(() => store.retry(job.analysisId, 'muse'), /reserved/);
        seen.push({
          dimension: settings.MUSE_MAX_DIMENSION,
          minimal: settings.MUSE_MINIMAL_PROMPT,
          hash: snapshotHash(snapshot, job.sam.snapshotRef!),
        });
        return fullResult(snapshot.image);
      },
    }),
  });
  assert.deepEqual(
    seen.map(({ dimension, minimal }) => [dimension, minimal]),
    [
      [0, false],
      [1280, false],
      [1280, true],
    ],
  );
  assert.ok(
    seen.every((item) => item.hash === job.sam.snapshotRef!.samSnapshotHash),
  );
  assert.deepEqual(
    report.measurements.map((m) => m.status),
    ['succeeded', 'succeeded', 'succeeded'],
  );
  assert.equal(report.measurements[1]!.upstreamOutcome, 'response_received');
  assert.equal(report.status, 'completed');
  assert.equal(store.experiments.active(), undefined);
  assert.deepEqual(store.experiments.get(report.experimentId).report, report);
  assert.equal(
    store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.analysisId)!
      .data,
    before,
  );
});

test('experiment cancellation fences ignored aborts and retains an interrupted reservation', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  const job = await checkpointed(store),
    pending = deferred<Analysis>(),
    controller = new AbortController();
  let started = false;
  const run = runMuseExperiment(store, job.analysisId, store.config, {
    signal: controller.signal,
    stagesFactory: () => ({
      async segment() {
        throw new Error();
      },
      interpret() {
        started = true;
        return pending.promise;
      },
    }),
  });
  await until(() => started);
  const reserved = store.experiments.active()!;
  controller.abort(new Error('Stop experiment'));
  await assert.rejects(run, /explicitly release/);
  assert.equal(store.experiments.active()!.status, 'interrupted');
  const before = store.experiments.get(reserved.experimentId);
  pending.resolve(fullResult(job.sam.snapshot!.image));
  await delay(10);
  assert.deepEqual(store.experiments.get(reserved.experimentId), before);
  store.experiments.releaseInterrupted(reserved.experimentId);
  assert.equal(store.experiments.active(), undefined);
});

test('offline evidence and exact annotation bytes survive job retention and never overwrite prior archives', async (t) => {
  const store = new JobStore(testConfig(), ':memory:'),
    dir = mkdtempSync(join(tmpdir(), 'praxis-evidence-'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const job = await checkpointed(store);
  const truth = join(dir, 'truth.json'),
    truthBytes = Buffer.from(
      JSON.stringify({
        imageHash: job.imageHash,
        analysisRunId: job.analysisId,
        wires: [],
      }) + '\n',
    );
  writeFileSync(truth, truthBytes);
  const output = join(dir, 'nested', 'archive'),
    manifest = exportJobEvidence(store, job.analysisId, output, { truth });
  for (const file of manifest.files) {
    const bytes = readFileSync(join(output, file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  assert.equal(
    readFileSync(join(output, 'ground-truth.json')).equals(truthBytes),
    true,
  );
  assert.equal(
    manifest.snapshots[0]!.samSnapshotId,
    job.sam.snapshotRef!.samSnapshotId,
  );
  assert.throws(
    () => exportJobEvidence(store, job.analysisId, output),
    /exist/,
  );
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ imageHash: '0'.repeat(64) }));
  assert.throws(
    () =>
      exportJobEvidence(store, job.analysisId, join(dir, 'rejected'), {
        truth: bad,
      }),
    /does not match/,
  );
  assert.equal(existsSync(join(dir, 'rejected')), false);
  const expired = store.get(job.analysisId);
  expired.expiresAt = 0;
  store.save(expired);
  store.cleanup();
  assert.throws(() => store.get(job.analysisId), /not found/);
  assert.ok(readFileSync(join(output, 'snapshots/1.json')).length);
  assert.ok(readFileSync(join(output, 'manifest.json')).length);
});

test('HTTP admission reserves legacy inference while leaving uploads queued and saved evidence readable', async (t) => {
  const config = testConfig(),
    store = new JobStore(config, ':memory:'),
    job = await checkpointed(store);
  let legacyCalls = 0,
    stageCalls = 0;
  const reservation = store.experiments.reserve(job.analysisId);
  const app = await buildApp(
    config,
    async () => {
      legacyCalls++;
      return fullResult(job.sam.snapshot!.image);
    },
    () => undefined,
    undefined,
    {
      store,
      stages: {
        async segment(image) {
          stageCalls++;
          return { image, candidates: [] };
        },
        async interpret(snapshot) {
          return fullResult(snapshot.image);
        },
      },
    },
  );
  t.after(async () => {
    await app.close();
    store.close();
  });
  for (const url of ['/api/vision/analyze', '/api/vision/endpoints']) {
    const response = await app.inject({
      method: 'POST',
      url,
      ...multipartBody(await imageBytes()),
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'EXPERIMENT_RESERVED');
  }
  const source = await app.inject(`/api/analyses/${job.analysisId}`);
  assert.equal(source.statusCode, 200);
  assert.equal(source.json().experiment.experimentId, reservation.experimentId);
  const retry = await app.inject({
    method: 'POST',
    url: `/api/analyses/${job.analysisId}/retry-muse`,
  });
  assert.equal(retry.statusCode, 409);
  const queued = await app.inject({
    method: 'POST',
    url: '/api/analyses',
    ...multipartBody(await imageBytes()),
  });
  assert.equal(queued.statusCode, 202);
  await delay(20);
  assert.equal(stageCalls, 0);
  assert.equal(legacyCalls, 0);
  assert.equal(
    store.experiments.record(
      reservation.experimentId,
      reservation.owner!,
      { status: 'completed' },
      'completed',
    ),
    true,
  );
  await until(() => store.get(queued.json().analysisId).status === 'completed');
  const completed = store.get(queued.json().analysisId);
  assert.equal(
    completed.muse.result!.provenance.samSnapshotId,
    completed.sam.snapshotRef!.samSnapshotId,
  );
  assert.equal(
    completed.muse.result!.provenance.jobAnalysisId,
    completed.analysisId,
  );
});

test('a late experiment response cannot publish or continue variants after its reservation is replaced', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  const job = await checkpointed(store),
    pending = deferred<Analysis>();
  let calls = 0;
  const run = runMuseExperiment(store, job.analysisId, store.config, {
    stagesFactory: () => ({
      async segment() {
        throw new Error();
      },
      interpret() {
        calls++;
        return pending.promise;
      },
    }),
  });
  await until(() => calls === 1);
  const old = store.experiments.active()!;
  store.db
    .prepare('UPDATE experiments SET lease_until=? WHERE id=?')
    .run(Date.now() - 1, old.experimentId);
  store.recover();
  store.experiments.releaseInterrupted(old.experimentId);
  const current = store.experiments.reserve(job.analysisId);
  pending.resolve(fullResult(job.sam.snapshot!.image));
  await assert.rejects(run, /interrupted/);
  assert.equal(calls, 1);
  assert.equal(store.experiments.active()!.experimentId, current.experimentId);
  const prior = store.experiments.get(old.experimentId);
  assert.equal(prior.status, 'released');
  assert.equal(
    (prior.report as { measurements: unknown[] }).measurements.length,
    0,
  );
  assert.equal(
    store.experiments.record(
      current.experimentId,
      current.owner!,
      { status: 'completed' },
      'completed',
    ),
    true,
  );
});

test('an unknown experiment outcome stops later variants and retains prior successful evidence and its reservation', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  const job = await checkpointed(store);
  let calls = 0;
  await assert.rejects(
    () =>
      runMuseExperiment(store, job.analysisId, store.config, {
        stagesFactory: () => ({
          async segment() {
            assert.fail('No SAM');
          },
          async interpret(snapshot) {
            calls++;
            if (calls === 2)
              throw new AppError(504, 'PROVIDER_TIMEOUT', 'Timeout');
            return fullResult(snapshot.image);
          },
        }),
      }),
    /interrupted/,
  );
  assert.equal(calls, 2);
  const reservation = store.experiments.active()!;
  assert.equal(reservation.status, 'interrupted');
  const report = reservation.report as {
    measurements: { status: string; result?: unknown }[];
  };
  assert.deepEqual(
    report.measurements.map((m) => m.status),
    ['succeeded', 'timed_out'],
  );
  assert.ok(report.measurements[0]!.result);
});
