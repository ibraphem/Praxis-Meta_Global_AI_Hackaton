import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  maskFixture,
  imageBytes,
  testConfig,
  samEnvelope,
  samWireRecord,
} from './helpers.js';
import { prepareImage } from '../src/services/image.js';
import { auditWireCoverage } from '../src/services/wire-coverage.js';
import {
  createWireRecovery,
  type RecoveryProgress,
} from '../src/services/wire-recovery.js';
import { snapshotHash, type SnapshotRef } from '../src/jobs/snapshots.js';
import {
  effectiveIdentityReviews,
  type WireIdentity,
} from '../src/schemas/wire-recovery.js';
import { JobStore, lastAttempt } from '../src/jobs/store.js';
import { AnalysisWorker } from '../src/jobs/worker.js';
import { partialAnalysis } from '../src/services/partial-analysis.js';
import { AppError } from '../src/lib/errors.js';
import type { SamSnapshot } from '../src/services/vision.js';

const budget = () => ({
  requests: 0,
  pixels: 0,
  verificationRequests: 0,
  rounds: 0,
});
function ref(snapshot: SamSnapshot): SnapshotRef {
  const context = {
    imageHash: 'a'.repeat(64),
    model: 'sam',
    processingVersion: 'sam-checkpoint-v1',
  };
  return {
    ...context,
    samSnapshotId: randomUUID(),
    sourceAttemptId: randomUUID(),
    samSnapshotHash: snapshotHash(snapshot, context),
    createdAt: 1,
    origin: 'recorded',
  };
}
async function fixture() {
  const snapshot: SamSnapshot = {
    image: await prepareImage(await imageBytes(400, 300), testConfig()),
    candidates: [
      {
        id: 'jumper_wire_1',
        type: 'jumper_wire',
        bbox: [20, 20, 100, 100],
        encodedMask: maskFixture('blob'),
      },
    ],
  };
  const reference = ref(snapshot),
    report = await auditWireCoverage(snapshot, reference);
  const review: WireIdentity = {
    reviewId: randomUUID(),
    reportId: report.reportId,
    candidateIds: ['jumper_wire_1'],
    state: 'verified',
    note: 'physical inspection',
    reviewSource: 'human',
    reviewedAt: 1,
    electricalConnectionStatus: 'unestablished',
  };
  return { snapshot, reference, report, review };
}
const checkpoint = (value: RecoveryProgress) =>
  value.changed ? ref(value.snapshot) : undefined;

test('a successful empty crop preserves same-snapshot review context and model proposals', async () => {
  const { snapshot, reference, report, review } = await fixture();
  report.modelReviews = [
    {
      candidateId: 'jumper_wire_1',
      decision: 'uncertain',
      endpoints: [
        { role: 'A', position: null, evidence: 'insufficient' },
        { role: 'B', position: null, evidence: 'occluded_insertion' },
      ],
      elapsedMs: 1,
    },
  ];
  const result = await createWireRecovery(testConfig(), {
    async post() {
      return samEnvelope('');
    },
  })(
    {
      snapshot,
      ref: reference,
      reviews: [review],
      previous: report,
      budget: budget(),
      visited: [],
      operation: 'recover',
    },
    new AbortController().signal,
    undefined,
    checkpoint,
  );
  assert.equal(result.report.reportId, report.reportId);
  assert.equal(result.report.candidates[0]!.verifiedCoverage, 1);
  assert.deepEqual(result.report.modelReviews, report.modelReviews);
  assert.equal(result.cropAttempts[0]!.status, 'succeeded');
  assert.equal(result.cropAttempts[0]!.upstreamOutcome, 'response_received');
});

test('two changed checkpoints carry unchanged, non-conflicting review evidence with original provenance', async () => {
  const { snapshot, review } = await fixture();
  snapshot.candidates.push({
    id: 'jumper_wire_2',
    type: 'jumper_wire',
    bbox: [300, 200, 60, 50],
    encodedMask: maskFixture('blob'),
  });
  const reference = ref(snapshot),
    report = await auditWireCoverage(snapshot, reference),
    original = { ...review, reportId: report.reportId },
    before = JSON.stringify(original);
  let calls = 0;
  const result = await createWireRecovery(testConfig(), {
    async post(_path, _body, _signal, op) {
      calls++;
      const d = op!.imageDimensions![0]!;
      return samEnvelope(
        samWireRecord()
          .replace('x1=10;y1=20;x2=29;y2=39', 'x1=125;y1=70;x2=144;y2=89')
          .replace('w=100;h=80', `w=${d.width};h=${d.height}`),
      );
    },
  })(
    {
      snapshot,
      ref: reference,
      reviews: [original],
      previous: report,
      budget: budget(),
      visited: [],
      operation: 'recover',
    },
    new AbortController().signal,
    undefined,
    checkpoint,
  );
  assert.equal(calls, 2);
  assert.notEqual(result.report.reportId, report.reportId);
  assert.equal(
    result.report.candidates.find((c) => c.id === 'jumper_wire_1')!
      .verifiedCoverage,
    1,
  );
  assert.equal(result.report.reviewReconciliation![0]!.status, 'carried');
  assert.equal(
    result.report.reviewReconciliation![0]!.sourceReviewId,
    original.reviewId,
  );
  assert.equal(
    result.report.reviewReconciliation![0]!.sourceReportId,
    original.reportId,
  );
  assert.equal(JSON.stringify(original), before);
  const effective = effectiveIdentityReviews([original], result.report);
  assert.equal(effective[0]!.inheritedFromReportId, original.reportId);
  assert.equal(effective[0]!.electricalConnectionStatus, 'unestablished');
  const correction = {
    ...original,
    reviewId: randomUUID(),
    reportId: result.report.reportId,
    state: 'uncertain' as const,
  };
  const audited = await auditWireCoverage(
    result.snapshot,
    {
      ...reference,
      samSnapshotId: result.report.sourceSnapshotId,
      samSnapshotHash: result.report.sourceSnapshotHash,
    },
    [original, correction],
    1280,
    result.report,
  );
  assert.equal(audited.candidates[0]!.verifiedCoverage, 0);
  assert.equal(
    effectiveIdentityReviews([original, correction], audited)[0]!.state,
    'uncertain',
  );
});

test('changed or newly conflicting evidence requires re-review and stays unresolved across later crops', async () => {
  const { snapshot, reference, report, review } = await fixture();
  const changed = structuredClone(snapshot);
  changed.candidates[0]!.bbox[0]++;
  const changedReport = await auditWireCoverage(
    changed,
    ref(changed),
    [review],
    1280,
    report,
  );
  assert.equal(
    changedReport.reviewReconciliation![0]!.reason,
    'changed_evidence',
  );
  assert.equal(changedReport.reviewReconciliation![0]!.status, 'needs_review');
  assert.equal(changedReport.candidates[0]!.verifiedCoverage, 0);
  const next = structuredClone(changed);
  next.candidates.push({
    id: 'jumper_wire_2',
    type: 'jumper_wire',
    bbox: [300, 200, 30, 30],
    encodedMask: maskFixture('wire'),
  });
  const later = await auditWireCoverage(
    next,
    ref(next),
    [review],
    1280,
    changedReport,
  );
  assert.equal(later.reviewReconciliation![0]!.status, 'needs_review');
  assert.equal(later.candidates[0]!.verifiedCoverage, 0);
  const conflicting = structuredClone(snapshot);
  conflicting.candidates.push({
    id: 'jumper_wire_2',
    type: 'jumper_wire',
    bbox: [30, 30, 60, 60],
    encodedMask: maskFixture('wire'),
  });
  const conflict = await auditWireCoverage(
    conflicting,
    ref(conflicting),
    [review],
    1280,
    report,
  );
  assert.equal(
    conflict.reviewReconciliation![0]!.reason,
    'conflicting_evidence',
  );
  assert.equal(conflict.candidates[0]!.verifiedCoverage, 0);
  assert.equal(reference.samSnapshotId, report.sourceSnapshotId);
});

test('reconciliation uses unique geometry fingerprints rather than candidate numbering', async () => {
  const { snapshot, report, review } = await fixture();
  const renumbered = structuredClone(snapshot);
  renumbered.candidates[0]!.id = 'jumper_wire_9';
  const carried = await auditWireCoverage(
    renumbered,
    ref(renumbered),
    [review],
    1280,
    report,
  );
  assert.deepEqual(carried.reviewReconciliation![0]!.candidateIds, [
    'jumper_wire_9',
  ]);
  assert.equal(carried.candidates[0]!.verifiedCoverage, 1);
  renumbered.candidates.push({
    ...renumbered.candidates[0]!,
    id: 'jumper_wire_10',
  });
  const ambiguous = await auditWireCoverage(
    renumbered,
    ref(renumbered),
    [review],
    1280,
    report,
  );
  assert.equal(
    ambiguous.reviewReconciliation![0]!.reason,
    'conflicting_evidence',
  );
  assert.ok(ambiguous.candidates.every((c) => c.verifiedCoverage === 0));
});

test('a partly missing reviewed group cannot verify its remaining fragments', async () => {
  const { snapshot } = await fixture();
  snapshot.candidates.push({
    id: 'jumper_wire_2',
    type: 'jumper_wire',
    bbox: [200, 150, 40, 40],
    encodedMask: maskFixture('wire'),
  });
  const previous = await auditWireCoverage(snapshot, ref(snapshot));
  const review: WireIdentity = {
    reviewId: randomUUID(),
    reportId: previous.reportId,
    candidateIds: ['jumper_wire_1', 'jumper_wire_2'],
    state: 'verified',
    note: 'one inspected physical wire',
    reviewSource: 'human',
    reviewedAt: 1,
    electricalConnectionStatus: 'unestablished',
  };
  const partial = structuredClone(snapshot);
  partial.candidates.pop();
  const next = await auditWireCoverage(
    partial,
    ref(partial),
    [review],
    1280,
    previous,
  );
  assert.equal(next.reviewReconciliation![0]!.reason, 'missing_evidence');
  assert.equal(next.reviewReconciliation![0]!.status, 'needs_review');
  assert.equal(next.candidates[0]!.verifiedCoverage, 0);
});

test('a timed-out crop stays uninspected and blocked without losing its durable request charge', async () => {
  const { snapshot, reference, report } = await fixture();
  let last: RecoveryProgress | undefined,
    calls = 0;
  const recover = createWireRecovery(testConfig(), {
    async post() {
      calls++;
      throw new AppError(504, 'PROVIDER_TIMEOUT', 'Deadline');
    },
  });
  await assert.rejects(
    () =>
      recover(
        {
          snapshot,
          ref: reference,
          reviews: [],
          previous: report,
          budget: budget(),
          visited: [],
          operation: 'recover',
        },
        new AbortController().signal,
        undefined,
        (value) => {
          last = value;
          return checkpoint(value);
        },
      ),
    /Deadline/,
  );
  assert.equal(last!.cropAttempts[0]!.status, 'timed_out');
  assert.equal(last!.cropAttempts[0]!.upstreamOutcome, 'unknown');
  assert.equal(last!.budget.requests, 1);
  const again = await recover(
    {
      snapshot,
      ref: reference,
      reviews: [],
      previous: last!.report,
      budget: last!.budget,
      visited: last!.visited,
      cropAttempts: last!.cropAttempts,
      operation: 'recover',
    },
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(again.report.stopReason, 'blocked_regions');
  assert.equal(again.cropAttempts[0]!.status, 'timed_out');
  assert.equal(again.budget.requests, 1);
});

test('legacy visited crops receive stable unknown records, never fabricated successful inspections', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  const { snapshot } = await fixture(),
    job = store.create(await imageBytes(400, 300), snapshot.image);
  job.recovery.visited = [[0, 0, 150, 113]];
  job.recovery.budget.requests = 1;
  store.save(job);
  const first = store.get(job.analysisId),
    second = store.get(job.analysisId);
  assert.equal(first.recovery.cropAttempts[0]!.status, 'legacy_unknown');
  assert.equal(first.recovery.cropAttempts[0]!.upstreamOutcome, 'unknown');
  assert.equal(first.recovery.budget.requests, 1);
  assert.deepEqual(first.recovery.cropAttempts, second.recovery.cropAttempts);
});

test('crop failure and its charge survive a worker restart and later recovery reports blocked inspection', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-crop-ledger-')),
    config = testConfig(),
    { snapshot } = await fixture();
  let calls = 0;
  const factory = (settings: ReturnType<typeof testConfig>) =>
    createWireRecovery(settings, {
      async post() {
        calls++;
        throw new AppError(504, 'PROVIDER_TIMEOUT', 'Deadline');
      },
    });
  let store = new JobStore(config, directory),
    worker = new AnalysisWorker(
      store,
      config,
      () => undefined,
      undefined,
      factory,
    );
  t.after(async () => {
    await worker.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const job = store.create(await imageBytes(400, 300), snapshot.image);
  job.sam.snapshot = snapshot;
  job.sam.status = 'succeeded';
  lastAttempt(job, 'sam')!.status = 'succeeded';
  job.sam.result = partialAnalysis(snapshot, config);
  job.status = 'partial';
  store.save(job);
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 400; i++) {
      if (check()) return;
      await delay(10);
    }
    throw new Error('Worker did not settle');
  };
  store.requestRecovery(job.analysisId, 'recover');
  worker.start();
  await wait(() => store.get(job.analysisId).recovery.status === 'timed_out');
  await worker.close();
  store.close();
  store = new JobStore(config, directory);
  worker = new AnalysisWorker(
    store,
    config,
    () => undefined,
    undefined,
    factory,
  );
  assert.equal(
    store.get(job.analysisId).recovery.cropAttempts[0]!.status,
    'timed_out',
  );
  assert.equal(store.get(job.analysisId).recovery.budget.requests, 1);
  store.requestRecovery(job.analysisId, 'recover');
  worker.start();
  await wait(() => store.get(job.analysisId).recovery.status === 'succeeded');
  const recovered = store.get(job.analysisId);
  assert.equal(recovered.recovery.report!.stopReason, 'blocked_regions');
  assert.equal(recovered.recovery.cropAttempts[0]!.status, 'timed_out');
  assert.equal(recovered.recovery.budget.requests, 1);
  assert.equal(calls, 1);
});
