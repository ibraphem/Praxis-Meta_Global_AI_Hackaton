import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore, newAttempt, publicJob } from '../src/jobs/store.js';
import { publishRecoveredCandidates } from '../src/jobs/candidates.js';
import { partialAnalysis } from '../src/services/partial-analysis.js';
import { prepareImage } from '../src/services/image.js';
import { AnalysisWorker } from '../src/jobs/worker.js';
import { auditWireCoverage } from '../src/services/wire-coverage.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalysisTrace } from '../src/lib/diagnostics.js';
import { AppError } from '../src/lib/errors.js';
import {
  runMuseExperiment,
  type MuseExperimentReport,
} from '../src/jobs/muse-experiment.js';
import { RUNTIME } from '../src/lib/runtime.js';
import type { Candidate } from '../src/schemas/vision.js';
import { maskFixture, imageBytes, testConfig, completion } from './helpers.js';
const wire = (id: number, x: number): Candidate => ({
  id: `jumper_wire_${id}`,
  type: 'jumper_wire',
  bbox: [x, 30, 100, 100],
  localizationSource: 'sam',
  encodedMask: maskFixture('wire'),
});
async function saved(store: JobStore) {
  const bytes = await imageBytes(600, 400),
    image = await prepareImage(bytes, store.config);
  let job = store.create(bytes, image);
  job.sam.snapshot = { image, candidates: [wire(1, 30)] };
  job.sam.status = 'succeeded';
  job.sam.attempts[0]!.status = 'succeeded';
  job.sam.result = partialAnalysis(job.sam.snapshot, store.config);
  job.muse.status = 'timed_out';
  job.muse.attempts = [
    {
      ...newAttempt(),
      status: 'timed_out',
      retryPolicy: 'manual_only',
      upstreamOutcome: 'unknown',
    },
  ];
  job.status = 'partial';
  store.save(job);
  job = store.get(job.analysisId);
  Object.assign(job.sam.result!.provenance, {
    samSnapshotId: job.sam.snapshotRef!.samSnapshotId,
    samSnapshotHash: job.sam.snapshotRef!.samSnapshotHash,
  });
  job.candidateResult = job.sam.result!;
  store.save(job);
  return store.get(job.analysisId);
}
test('new recovered geometry publishes without a Muse result, survives restart, and keeps source revisions and restrictions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-candidates-'));
  const store = new JobStore(testConfig(), dir);
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const job = await saved(store),
    originalSam = JSON.stringify(job.sam.result),
    originalRef = job.sam.snapshotRef!;
  const snapshot = {
    image: job.sam.snapshot!.image,
    candidates: [
      ...job.sam.snapshot!.candidates,
      { ...wire(2, 250), cropOrigin: [250, 30, 100, 100] },
    ],
  };
  const attemptId = randomUUID();
  const ref = store.checkpointSnapshot(
    job,
    snapshot,
    attemptId,
    'recorded',
    originalRef,
  );
  job.recovery.snapshotRef = ref;
  const trace = new AnalysisTrace(randomUUID());
  publishRecoveredCandidates(
    store,
    job,
    snapshot,
    ref,
    attemptId,
    store.config,
    trace,
  );
  store.save(job);
  const published = publicJob(store.get(job.analysisId));
  assert.equal(published.result!.objects.length, 2);
  assert.equal(published.result!.objects[0]!.id, 'jumper_wire_1');
  assert.equal(
    published.result!.provenance.candidateLayer!.snapshotId,
    ref.samSnapshotId,
  );
  assert.equal(published.revision, ref.samSnapshotId);
  assert.equal(published.muse.status, 'timed_out');
  assert.equal(job.muse.result, undefined);
  assert.equal(JSON.stringify(job.sam.result), originalSam);
  assert.ok(
    published.result!.objects.every(
      (c) => c.identityStatus === 'unverified' && c.guidanceEligible === false,
    ),
  );
  assert.equal(trace.snapshot().timings[0]!.stage, 'wire.selection');
  const id = job.analysisId;
  store.close();
  const restarted = new JobStore(testConfig(), dir);
  t.after(() => restarted.close());
  assert.deepEqual(publicJob(restarted.get(id)).result, published.result);
});
test('local observation retains earlier semantic evidence without mislabeling SAM uncertainty as a Muse disagreement', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  const job = await saved(store);
  job.candidateResult = {
    ...job.sam.result!,
    provenance: { ...job.sam.result!.provenance, mode: 'combined' },
    objects: job.sam.result!.objects.map((c) => ({
      ...c,
      interpretation: 'confirmed',
      color: 'yellow',
    })),
  };
  const snapshot = {
    image: job.sam.snapshot!.image,
    candidates: [...job.sam.snapshot!.candidates, wire(2, 250)],
  };
  const attemptId = randomUUID(),
    ref = store.checkpointSnapshot(
      job,
      snapshot,
      attemptId,
      'recorded',
      job.sam.snapshotRef!,
    );
  publishRecoveredCandidates(
    store,
    job,
    snapshot,
    ref,
    attemptId,
    store.config,
    new AnalysisTrace(randomUUID()),
  );
  assert.equal(job.candidateResult.objects[0]!.interpretation, 'confirmed');
  assert.equal(job.candidateResult.objects[0]!.color, 'yellow');
  assert.equal(
    job.candidateResult.objects[0]!.selectionEvidence!.reasons.includes(
      'changed_interpretation',
    ),
    false,
  );
  assert.equal(job.candidateResult.objects[1]!.interpretation, 'uncertain');
});
test('focused experiments bind the latest recovery checkpoint, save independent identity-only responses, and never modify live results', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  const job = await saved(store),
    attemptId = randomUUID();
  const snapshot = {
    image: job.sam.snapshot!.image,
    candidates: [...job.sam.snapshot!.candidates, wire(2, 250)],
  };
  const ref = store.checkpointSnapshot(
    job,
    snapshot,
    attemptId,
    'recorded',
    job.sam.snapshotRef!,
  );
  job.recovery.snapshotRef = ref;
  store.save(job);
  const before = JSON.stringify(store.get(job.analysisId));
  let calls = 0,
    savedFirst = false;
  const report = await runMuseExperiment(store, job.analysisId, store.config, {
    variants: ['focused-candidates'],
    candidateIds: ['jumper_wire_1', 'jumper_wire_2'],
    verificationClient: {
      async post(_path, body, _signal, op) {
        calls++;
        assert.equal(op!.maxRetries, 0);
        assert.equal(op!.imageDimensions!.length, 2);
        assert.equal(
          JSON.stringify(body).includes('Return LOCAL CROP pixel positions'),
          false,
        );
        if (calls === 2) assert.ok(savedFirst);
        return completion({
          decision: calls === 1 ? 'one_visible_wire' : 'uncertain',
        });
      },
    },
    onProgress: (report) => {
      if (report.measurements.length === 1) savedFirst = true;
    },
  });
  assert.equal(calls, 2);
  assert.equal(report.snapshotRef.samSnapshotId, ref.samSnapshotId);
  assert.equal(report.focusedPlan.length, 2);
  assert.equal(
    report.measurements[0]!.modelReview!.decision,
    'one_visible_wire',
  );
  assert.ok(
    report.measurements.every((m) =>
      m.modelReview!.endpoints.every((e) => e.position === null),
    ),
  );
  assert.deepEqual(report.runtime, RUNTIME);
  assert.equal(JSON.stringify(store.get(job.analysisId)), before);
});
test('a later focused timeout preserves the first result and stops all remaining checks and scene variants', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  const job = await saved(store),
    attemptId = randomUUID();
  const snapshot = {
    image: job.sam.snapshot!.image,
    candidates: [wire(1, 30), wire(2, 250), wire(3, 450)],
  };
  job.recovery.snapshotRef = store.checkpointSnapshot(
    job,
    snapshot,
    attemptId,
    'recorded',
    job.sam.snapshotRef!,
  );
  store.save(job);
  let calls = 0;
  await assert.rejects(
    () =>
      runMuseExperiment(store, job.analysisId, store.config, {
        variants: ['focused-candidates', '1280-minimal'],
        candidateIds: ['jumper_wire_1', 'jumper_wire_2', 'jumper_wire_3'],
        verificationClient: {
          async post() {
            calls++;
            if (calls === 2)
              throw new AppError(504, 'PROVIDER_TIMEOUT', 'Timeout');
            return completion({ decision: 'one_visible_wire' });
          },
        },
      }),
    /interrupted/,
  );
  assert.equal(calls, 2);
  const report = store.experiments.active()!.report as MuseExperimentReport;
  assert.deepEqual(
    report.measurements.map((m) => m.status),
    ['succeeded', 'timed_out'],
  );
  assert.equal(
    report.measurements[0]!.modelReview!.decision,
    'one_visible_wire',
  );
});

test('a recovery timeout after a checkpoint and a later Muse timeout both retain the newly selectable candidate view', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  const job = await saved(store);
  job.recovery.report = await auditWireCoverage(
    job.sam.snapshot!,
    job.sam.snapshotRef!,
  );
  store.save(job);
  const worker = new AnalysisWorker(
    store,
    store.config,
    () => undefined,
    {
      async segment() {
        assert.fail('No SAM rerun');
      },
      async interpret() {
        throw new AppError(504, 'PROVIDER_TIMEOUT', 'Scene timeout');
      },
    },
    () => async (input, _signal, _trace, progress) => {
      const snapshot = {
        image: input.snapshot.image,
        candidates: [...input.snapshot.candidates, wire(2, 250)],
      };
      const ref = progress!({
        snapshot,
        report: input.previous!,
        budget: { ...input.budget, requests: 1 },
        visited: [],
        cropAttempts: [],
        changed: true,
      })!;
      progress!({
        snapshot,
        report: await auditWireCoverage(snapshot, ref),
        budget: { ...input.budget, requests: 1 },
        visited: [],
        cropAttempts: [],
        changed: false,
      });
      throw new AppError(504, 'PROVIDER_TIMEOUT', 'Later crop timeout');
    },
  );
  t.after(async () => {
    await worker.close();
    store.close();
  });
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (f()) return;
      await delay(5);
    }
    assert.fail('Worker did not settle');
  };
  store.requestRecovery(job.analysisId, 'recover');
  worker.start();
  await until(() => store.get(job.analysisId).recovery.status === 'timed_out');
  const recovered = store.get(job.analysisId),
    selected = JSON.stringify(recovered.candidateResult);
  assert.equal(recovered.candidateResult!.objects.length, 2);
  assert.equal(recovered.sam.result!.objects.length, 1);
  assert.equal(recovered.muse.result, undefined);
  store.interpretRecovery(job.analysisId);
  worker.tick();
  await until(() => store.get(job.analysisId).muse.status === 'timed_out');
  assert.equal(
    JSON.stringify(store.get(job.analysisId).candidateResult),
    selected,
  );
  assert.equal(store.get(job.analysisId).revision, recovered.revision);
});

test('one focused phase budget covers all checks and retains completed checks when a later request reaches that budget', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  const job = await saved(store),
    attemptId = randomUUID();
  const snapshot = {
    image: job.sam.snapshot!.image,
    candidates: [wire(1, 30), wire(2, 250)],
  };
  job.recovery.snapshotRef = store.checkpointSnapshot(
    job,
    snapshot,
    attemptId,
    'recorded',
    job.sam.snapshotRef!,
  );
  store.save(job);
  let calls = 0;
  await assert.rejects(
    () =>
      runMuseExperiment(store, job.analysisId, store.config, {
        variants: ['focused-candidates'],
        candidateIds: ['jumper_wire_1', 'jumper_wire_2'],
        phaseBudgetMs: 300,
        verificationClient: {
          async post(_path, _body, signal) {
            calls++;
            if (calls === 1)
              return completion({ decision: 'one_visible_wire' });
            return new Promise((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else
                signal.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                });
            });
          },
        },
      }),
    /interrupted/,
  );
  assert.equal(calls, 2);
  const report = store.experiments.active()!.report as MuseExperimentReport;
  assert.equal(report.phaseBudgetMs, 300);
  assert.deepEqual(
    report.measurements.map((m) => m.status),
    ['succeeded', 'timed_out'],
  );
  assert.ok(report.phaseTimings[0]!.elapsedMs >= 280);
});

test('local audit publishes an already-saved recovered checkpoint even after its crop budget is exhausted', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  const job = await saved(store);
  const snapshot = {
    image: job.sam.snapshot!.image,
    candidates: [...job.sam.snapshot!.candidates, wire(2, 250)],
  };
  job.recovery.snapshotRef = store.checkpointSnapshot(
    job,
    snapshot,
    randomUUID(),
    'recorded',
    job.sam.snapshotRef!,
  );
  job.recovery.budget = {
    requests: 4,
    pixels: 5000000,
    rounds: 2,
    verificationRequests: 0,
  };
  store.save(job);
  const originalSam = JSON.stringify(job.sam.result);
  const worker = new AnalysisWorker(store, store.config, () => undefined, {
    async segment() {
      assert.fail('No SAM request');
    },
    async interpret() {
      assert.fail('No Muse request');
    },
  });
  t.after(async () => {
    await worker.close();
    store.close();
  });
  store.requestRecovery(job.analysisId, 'audit');
  worker.start();
  for (
    let i = 0;
    i < 500 && store.get(job.analysisId).recovery.status !== 'succeeded';
    i++
  )
    await delay(5);
  const audited = store.get(job.analysisId);
  assert.equal(audited.recovery.status, 'succeeded');
  assert.equal(audited.candidateResult!.objects.length, 2);
  assert.equal(
    audited.candidateResult!.provenance.samSnapshotHash,
    job.recovery.snapshotRef.samSnapshotHash,
  );
  assert.equal(audited.recovery.budget.requests, 4);
  assert.equal(audited.muse.status, 'timed_out');
  assert.equal(JSON.stringify(audited.sam.result), originalSam);
});
