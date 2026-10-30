import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMaskToRaster } from '@meta-sam/parser';
import {
  maskFixture,
  imageBytes,
  testConfig,
  samEnvelope,
  samWireRecord,
  completion,
} from './helpers.js';
import { prepareImage } from '../src/services/image.js';
import { inspectWire } from '../src/services/wire-inspection.js';
import { WireGeometry } from '../src/services/wire-geometry.js';
import {
  auditWireCoverage,
  classicalTraces,
  selectRecoveryTiles,
} from '../src/services/wire-coverage.js';
import {
  duplicateWire,
  reprojectCrop,
  createWireRecovery,
} from '../src/services/wire-recovery.js';
import { createWireVerifier } from '../src/services/wire-verification.js';
import { snapshotHash, type SnapshotRef } from '../src/jobs/snapshots.js';
import { JobStore, lastAttempt } from '../src/jobs/store.js';
import { AnalysisWorker } from '../src/jobs/worker.js';
import { partialAnalysis } from '../src/services/partial-analysis.js';
import {
  latestIdentityReviews,
  type WireIdentity,
} from '../src/schemas/wire-recovery.js';
import { evaluateWires } from '../src/services/wire-evaluation.js';
import { AppError } from '../src/lib/errors.js';
import type { Candidate } from '../src/schemas/vision.js';
import type { SamSnapshot } from '../src/services/vision.js';

const wire = (
  kind: Parameters<typeof maskFixture>[0] = 'wire',
  id = 1,
): Candidate => ({
  id: `jumper_wire_${id}`,
  type: 'jumper_wire',
  bbox: [20, 20, 100, 100],
  encodedMask: maskFixture(kind),
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
async function sample() {
  return {
    image: await prepareImage(await imageBytes(400, 300), testConfig()),
    candidates: [wire('blob')],
  };
}
const budget = () => ({
  requests: 0,
  pixels: 0,
  verificationRequests: 0,
  rounds: 0,
});
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error('Worker did not settle');
}

test('diagnostics expose rejection causes while strict mask policy remains unchanged', () => {
  for (const kind of ['wire', 'blob', 'split', 'branch', 'empty'] as const) {
    const candidate = wire(kind),
      inspection = inspectWire(candidate),
      resolution = new WireGeometry({ width: 400, height: 300 }).resolve(
        candidate,
      );
    assert.equal(inspection.acceptedGeometry, resolution.ok, kind);
    if (kind === 'wire') assert.deepEqual(inspection.reasons, []);
    else assert.ok(inspection.reasons.length);
    if (kind === 'split')
      assert.ok(inspection.reasons.includes('disconnected_mask'));
    if (kind === 'blob') assert.ok(inspection.reasons.includes('broad_mask'));
    if (kind === 'branch')
      assert.ok(inspection.reasons.includes('branched_mask'));
  }
});

test('thin-line audit proposes traces without accepting identities or electrical connectivity', () => {
  const w = 100,
    h = 60,
    rgb = new Uint8Array(w * h * 3).fill(255);
  for (let y = 25; y < 28; y++)
    for (let x = 10; x < 85; x++) {
      rgb[(y * w + x) * 3] = 220;
      rgb[(y * w + x) * 3 + 1] = 30;
      rgb[(y * w + x) * 3 + 2] = 30;
    }
  const found = classicalTraces(rgb, w, h, { width: 1000, height: 600 });
  assert.equal(found.candidates.length, 1);
  const c = found.candidates[0]!;
  assert.equal(c.identityStatus, 'unverified');
  assert.equal(c.guidanceEligible, false);
  assert.equal(c.geometryAccepted, false);
  assert.ok(c.points.length > 8);
  assert.ok(c.points.every((p) => p[0] < 1000 && p[1] < 600));
  const tiles = selectRecoveryTiles([c], { width: 1000, height: 600 });
  assert.equal(tiles.length, 1);
  assert.ok(tiles[0]![2] > 1000 / 3);
  assert.deepEqual(
    selectRecoveryTiles([{ ...c, candidateCoverage: 1 }], {
      width: 1000,
      height: 600,
    }),
    [],
  );
});

test('candidate coverage cannot imply verified coverage; later uncertainty revokes a group', async () => {
  const snapshot = await sample(),
    reference = ref(snapshot);
  const report = await auditWireCoverage(snapshot, reference);
  const review: WireIdentity = {
    reviewId: randomUUID(),
    reportId: report.reportId,
    candidateIds: ['jumper_wire_1'],
    state: 'verified',
    note: 'human inspection',
    reviewSource: 'human',
    reviewedAt: 1,
    electricalConnectionStatus: 'unestablished',
  };
  const verified = await auditWireCoverage(snapshot, reference, [review]);
  assert.equal(verified.candidates[0]!.verifiedCoverage, 1);
  assert.equal(
    verified.candidates[0]!.candidateCoverage,
    0,
    'rejected blob cannot explain candidate coverage',
  );
  const uncertain = {
    ...review,
    reviewId: randomUUID(),
    state: 'uncertain' as const,
  };
  const revoked = await auditWireCoverage(snapshot, reference, [
    review,
    uncertain,
  ]);
  assert.equal(revoked.candidates[0]!.verifiedCoverage, 0);
  assert.equal(
    latestIdentityReviews([review, uncertain], report.reportId).length,
    1,
  );
  assert.equal(
    revoked.reportId,
    report.reportId,
    'annotations do not mutate evidence identity',
  );
});

test('crop projection preserves native mask resolution and dedup requires matching observed pixels', () => {
  const a = wire();
  const [b] = reprojectCrop([a], [100, 80, 200, 200], 2);
  assert.deepEqual(b!.bbox, [120, 100, 100, 100]);
  assert.deepEqual(b!.encodedMask, a.encodedMask);
  assert.equal(b!.id, 'jumper_wire_2');
  assert.equal(duplicateWire(a, { ...a, id: 'jumper_wire_2' }), true);
  assert.equal(
    duplicateWire(a, wire('branch', 2)),
    false,
    'overlapping boxes and crossings are not duplicate wires',
  );
  assert.equal(duplicateWire(a, b!), false);
  const raster = decodeMaskToRaster(a.encodedMask!);
  assert.ok(raster.some(Boolean));
});

test('recovery consumes a budget before dispatch, checkpoints derived masks, and never repeats a visited tile', async () => {
  const snapshot = await sample(),
    reference = ref(snapshot),
    before = JSON.stringify(snapshot);
  let calls = 0,
    checkpoints = 0;
  const recover = createWireRecovery(testConfig(), {
    async post(path, _body, _signal, op) {
      calls++;
      assert.equal(path, 'responses');
      assert.equal(op!.maxRetries, 0);
      assert.equal(op!.stage, 'sam.wire_crop');
      const dim = op!.imageDimensions![0]!;
      return samEnvelope(
        samWireRecord().replace('w=100;h=80', `w=${dim.width};h=${dim.height}`),
      );
    },
  });
  const result = await recover(
    {
      snapshot,
      ref: reference,
      reviews: [],
      budget: budget(),
      visited: [],
      operation: 'recover',
    },
    new AbortController().signal,
    undefined,
    (value) => {
      if (!value.changed) {
        assert.ok(value.budget.requests >= 0);
        return;
      }
      checkpoints++;
      const next = {
        ...reference,
        samSnapshotId: randomUUID(),
        processingVersion: 'wire-recovery-v1',
      };
      return { ...next, samSnapshotHash: snapshotHash(value.snapshot, next) };
    },
  );
  assert.equal(calls, 1);
  assert.equal(checkpoints, 1);
  assert.equal(result.budget.requests, 1);
  assert.ok(result.snapshot.candidates.length > snapshot.candidates.length);
  assert.equal(JSON.stringify(snapshot), before);
  const again = await recover(
    {
      snapshot: result.snapshot,
      ref: {
        ...reference,
        samSnapshotId: result.report.sourceSnapshotId,
        samSnapshotHash: result.report.sourceSnapshotHash,
      },
      reviews: [],
      budget: result.budget,
      visited: result.visited,
      cropAttempts: result.cropAttempts,
      operation: 'recover',
    },
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(again.report.stopReason, 'no_actionable_regions');
});

test('a timed-out crop is not automatically repeated and retains its charged budget and original evidence', async () => {
  const snapshot = await sample(),
    reference = ref(snapshot);
  let calls = 0,
    saved = budget(),
    visited: [number, number, number, number][] = [];
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
          budget: budget(),
          visited: [],
          operation: 'recover',
        },
        new AbortController().signal,
        undefined,
        (value) => {
          saved = value.budget;
          visited = value.visited;
        },
      ),
    /Deadline/,
  );
  assert.equal(saved.requests, 1);
  assert.equal(visited.length, 1);
  assert.equal(snapshot.candidates.length, 1);
  await recover(
    {
      snapshot,
      ref: reference,
      reviews: [],
      budget: saved,
      visited,
      operation: 'recover',
    },
    new AbortController().signal,
  );
  assert.equal(calls, 1);
});

test('a full candidate checkpoint stops recovery without spending a provider request', async () => {
  const snapshot = await sample();
  snapshot.candidates = Array.from({ length: 100 }, (_, i) =>
    wire('blob', i + 1),
  );
  let calls = 0;
  const recover = createWireRecovery(testConfig(), {
    async post() {
      calls++;
      throw new Error('No capacity');
    },
  });
  const result = await recover(
    {
      snapshot,
      ref: ref(snapshot),
      reviews: [],
      budget: budget(),
      visited: [],
      operation: 'recover',
    },
    new AbortController().signal,
  );
  assert.equal(calls, 0);
  assert.equal(result.budget.requests, 0);
  assert.equal(result.report.stopReason, 'candidate_budget');
});

test('focused identity verification transforms pixels and refuses hidden guessed endpoints', async () => {
  const snapshot = await sample(),
    report = await auditWireCoverage(snapshot, ref(snapshot)),
    candidate = {
      ...report.candidates[0]!,
      bbox: [100, 100, 100, 100] as [number, number, number, number],
    };
  const output = {
    decision: 'one_visible_wire',
    endpoints: [
      { role: 'A', position: [10, 12], evidence: 'visible_insertion' },
      { role: 'B', position: null, evidence: 'occluded_insertion' },
    ],
  };
  let requests = 0;
  const verify = createWireVerifier(testConfig(), {
    async post(_path, body, _signal, op) {
      requests++;
      assert.equal(op!.maxRetries, 0);
      assert.equal(op!.imageDimensions!.length, 3);
      assert.doesNotMatch(JSON.stringify(body), /holeId/);
      return completion(output);
    },
  });
  const result = await verify(
    snapshot.image,
    candidate,
    new AbortController().signal,
  );
  assert.deepEqual(result.endpoints[0]!.position, [86, 88]);
  assert.equal(result.endpoints[1]!.position, null);
  assert.equal(requests, 1);
  for (const bad of [
    { ...output, decision: 'multiple_wires' },
    {
      ...output,
      endpoints: [
        { ...output.endpoints[0], evidence: 'occluded_insertion' },
        output.endpoints[1],
      ],
    },
  ])
    await assert.rejects(
      () =>
        createWireVerifier(testConfig(), {
          async post() {
            return completion(bad);
          },
        })(snapshot.image, candidate, new AbortController().signal),
      /invalid/i,
    );
});

test('a recovery worker that loses its lease cannot checkpoint late masks after another process recovers the job', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-wire-race-')),
    config = testConfig(),
    a = new JobStore(config, dir),
    b = new JobStore(config, dir),
    snapshot = await sample(),
    job = a.create(await imageBytes(400, 300), snapshot.image);
  job.sam.status = 'succeeded';
  lastAttempt(job, 'sam')!.status = 'succeeded';
  job.sam.snapshot = snapshot;
  job.sam.result = partialAnalysis(snapshot, config);
  job.status = 'partial';
  a.save(job);
  a.requestRecovery(job.analysisId, 'recover');
  let entered = false,
    release!: (value: unknown) => void;
  let dimension: { width: number; height: number } | undefined;
  const stale = new AnalysisWorker(
      a,
      config,
      () => undefined,
      undefined,
      (settings) =>
        createWireRecovery(settings, {
          async post(_path, _body, _signal, op) {
            entered = true;
            dimension = op!.imageDimensions![0]!;
            return new Promise((resolve) => {
              release = resolve;
            });
          },
        }),
    ),
    fresh = new AnalysisWorker(b, config, () => undefined);
  t.after(async () => {
    await stale.close();
    await fresh.close();
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  stale.start();
  await until(() => entered);
  const old = a.get(job.analysisId),
    oldAttempt = lastAttempt(old, 'recovery')!.attemptId;
  old.leaseUntil = Date.now() - 1;
  a.save(old);
  b.recover();
  assert.equal(
    lastAttempt(b.get(job.analysisId), 'recovery')!.status,
    'interrupted',
  );
  b.requestRecovery(job.analysisId, 'audit');
  fresh.start();
  await until(() => b.get(job.analysisId).recovery.status === 'succeeded');
  const protectedReport = b.get(job.analysisId).recovery.report!;
  const protectedCandidates = JSON.stringify(
    b.get(job.analysisId).candidateResult,
  );
  release(
    samEnvelope(
      samWireRecord().replace(
        'w=100;h=80',
        `w=${dimension!.width};h=${dimension!.height}`,
      ),
    ),
  );
  await delay(75);
  assert.deepEqual(b.get(job.analysisId).recovery.report, protectedReport);
  assert.equal(
    JSON.stringify(b.get(job.analysisId).candidateResult),
    protectedCandidates,
  );
  assert.equal(b.snapshots(job.analysisId).length, 1);
  assert.equal(b.get(job.analysisId).recovery.budget.requests, 1);
  assert.equal(
    b.get(job.analysisId).recovery.cropAttempts[0]!.status,
    'interrupted',
  );
  assert.equal(
    a.renewLease(job.analysisId, stale.owner, 'recovery', oldAttempt),
    false,
  );
  assert.equal(
    a.owned(job.analysisId, stale.owner, 'recovery', oldAttempt, (j) => {
      j.status = 'failed';
    }),
    false,
  );
});

test('worker preserves original SAM and Muse results; interpretation of recovered evidence is explicit and review cannot create a connection', async (t) => {
  const config = testConfig(),
    store = new JobStore(config, ':memory:'),
    bytes = await imageBytes(400, 300),
    snapshot = await sample();
  let interpretations = 0,
    cropCalls = 0;
  const worker = new AnalysisWorker(
    store,
    config,
    () => undefined,
    {
      async segment() {
        return snapshot;
      },
      async interpret(input) {
        interpretations++;
        if (interpretations === 2)
          throw new AppError(504, 'PROVIDER_TIMEOUT', 'Deadline');
        return partialAnalysis(input, config);
      },
    },
    (settings) =>
      createWireRecovery(settings, {
        async post(_path, _body, _signal, op) {
          cropCalls++;
          const d = op!.imageDimensions![0]!;
          return samEnvelope(
            samWireRecord().replace('w=100;h=80', `w=${d.width};h=${d.height}`),
          );
        },
      }),
  );
  t.after(async () => {
    await worker.close();
    store.close();
  });
  const id = store.create(bytes, snapshot.image).analysisId;
  worker.start();
  await until(() => store.get(id).status === 'completed');
  const original = store.get(id),
    originalId = original.sam.snapshotRef!.samSnapshotId,
    revision = original.revision;
  assert.equal(cropCalls, 0, 'initial audit is local only');
  store.requestRecovery(id, 'recover');
  worker.tick();
  await until(() => store.get(id).recovery.status === 'succeeded');
  const recovered = store.get(id);
  assert.equal(cropCalls, 1);
  assert.equal(interpretations, 1);
  assert.equal(recovered.sam.snapshotRef!.samSnapshotId, originalId);
  assert.notEqual(recovered.revision, revision);
  assert.equal(
    recovered.candidateResult!.provenance.candidateLayer!.snapshotId,
    recovered.recovery.snapshotRef!.samSnapshotId,
  );
  assert.equal(
    recovered.candidateResult!.objects.filter((c) => c.type === 'jumper_wire')
      .length,
    1,
  );
  assert.deepEqual(recovered.muse.result, original.muse.result);
  assert.equal(store.getSnapshot(originalId).snapshot.candidates.length, 1);
  assert.ok(
    store.getSnapshot(recovered.recovery.snapshotRef!.samSnapshotId).snapshot
      .candidates.length > 1,
  );
  const review = {
    reportId: recovered.recovery.report!.reportId,
    candidateIds: ['jumper_wire_1'],
    state: 'verified',
    note: 'independent physical inspection',
  };
  assert.throws(
    () =>
      store.reviewWireIdentity(id, {
        ...review,
        electricalConnectionStatus: 'established',
      }),
    /review decision/,
  );
  const reviewed = store.reviewWireIdentity(id, review);
  assert.equal(
    reviewed.wireIdentities[0]!.electricalConnectionStatus,
    'unestablished',
  );
  assert.equal(reviewed.revision, recovered.revision);
  assert.throws(
    () => store.reviewWireIdentity(id, { ...review, reportId: '0'.repeat(64) }),
    /evidence changed/,
  );
  store.interpretRecovery(id);
  worker.tick();
  await until(() => store.get(id).muse.status === 'timed_out');
  assert.equal(store.get(id).revision, recovered.revision);
  assert.deepEqual(store.get(id).candidateResult, recovered.candidateResult);
  store.retry(id, 'muse');
  worker.tick();
  await until(() => store.get(id).muse.status === 'succeeded');
  assert.equal(interpretations, 3);
  assert.equal(cropCalls, 1);
  assert.equal(
    lastAttempt(store.get(id), 'muse')!.samSnapshotId,
    recovered.recovery.snapshotRef!.samSnapshotId,
  );
});

test('offline scoring penalizes unresolved and duplicate identities and rejects unbound or incomplete annotations', async () => {
  const snapshot = await sample(),
    report = await auditWireCoverage(snapshot, ref(snapshot));
  const truth = {
    version: 'wire-truth-v1',
    imageHash: report.imageHash,
    recordedBeforeInference: true,
    completeInventory: true,
    wires: [
      {
        id: 'wire-red',
        endpoints: [
          { visibility: 'visible', holeId: 'board1:a1', position: [20, 20] },
          { visibility: 'visible', holeId: 'board1:a10', position: [100, 20] },
        ],
      },
    ],
  };
  const evaluation = {
    version: 'wire-evaluation-v1',
    imageHash: report.imageHash,
    reportId: report.reportId,
    sourceSnapshotHash: report.sourceSnapshotHash,
    groups: [
      {
        candidateIds: ['jumper_wire_1'],
        truthWireId: 'wire-red',
        matchKind: 'whole_wire',
        identityAccepted: true,
        endpoints: [
          { holeId: 'board1:a1', position: [21, 20], accepted: true },
          { holeId: null, position: null, accepted: false },
        ],
      },
    ],
  };
  const score = evaluateWires(report, report.imageHash, truth, evaluation);
  assert.equal(score.metrics.wireDetectionRecall, 1);
  assert.equal(score.metrics.wireIdentityPrecision, 1);
  assert.equal(score.metrics.exactHoleAccuracy, 0.5);
  assert.equal(score.metrics.unresolvedEndpoints, 1);
  assert.equal(score.metrics.meanCoordinateErrorPx, 1);
  assert.equal(score.targetsMet, false);
  const perfect = structuredClone(evaluation);
  perfect.groups[0]!.endpoints[1] = {
    holeId: 'board1:a10',
    position: [100, 20],
    accepted: true,
  };
  assert.equal(
    evaluateWires(report, report.imageHash, truth, perfect).targetsMet,
    true,
  );
  const fragment = structuredClone(perfect);
  fragment.groups[0]!.matchKind = 'fragment';
  const fragmented = evaluateWires(report, report.imageHash, truth, fragment);
  assert.equal(fragmented.metrics.wireDetectionRecall, 0);
  assert.equal(fragmented.metrics.unsupportedAcceptedHoles, 2);
  assert.equal(fragmented.targetsMet, false);
  const duplicateReport = {
    ...report,
    candidates: [
      ...report.candidates,
      { ...report.candidates[0]!, id: 'jumper_wire_2' },
    ],
  };
  const duplicate = structuredClone(perfect);
  duplicate.groups.push({
    ...duplicate.groups[0]!,
    candidateIds: ['jumper_wire_2'],
  });
  const duplicated = evaluateWires(
    duplicateReport,
    report.imageHash,
    truth,
    duplicate,
  );
  assert.equal(duplicated.metrics.wireDetectionRecall, 1);
  assert.equal(duplicated.metrics.wireIdentityPrecision, 0);
  assert.equal(duplicated.metrics.correctAcceptedIdentities, 0);
  assert.equal(duplicated.metrics.duplicateGroups, 1);
  assert.equal(duplicated.metrics.correctEndpoints, 0);
  assert.equal(duplicated.targetsMet, false);
  duplicate.groups[1]!.identityAccepted = false;
  const competing = evaluateWires(
    duplicateReport,
    report.imageHash,
    truth,
    duplicate,
  );
  assert.equal(competing.metrics.acceptedIdentities, 1);
  assert.equal(competing.metrics.correctAcceptedIdentities, 0);
  assert.equal(competing.metrics.wireIdentityPrecision, 0);
  assert.equal(competing.version, 'wire-score-v2');
  const wrong = structuredClone(evaluation);
  wrong.groups[0]!.endpoints[0]!.holeId = 'board1:a2';
  const failed = evaluateWires(report, report.imageHash, truth, wrong);
  assert.equal(failed.metrics.wrongAcceptedHoles, 1);
  assert.equal(failed.targetsMet, false);
  assert.throws(
    () =>
      evaluateWires(report, report.imageHash, truth, {
        ...evaluation,
        groups: [],
      }),
    /every candidate/,
  );
  assert.throws(
    () => evaluateWires(report, 'b'.repeat(64), truth, evaluation),
    /provenance/,
  );
  assert.throws(() =>
    evaluateWires(
      report,
      report.imageHash,
      { ...truth, recordedBeforeInference: false },
      evaluation,
    ),
  );
});
