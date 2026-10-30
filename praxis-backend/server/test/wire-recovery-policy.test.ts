import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { imageBytes, testConfig, samEnvelope, completion } from './helpers.js';
import { prepareImage } from '../src/services/image.js';
import type { Candidate } from '../src/schemas/vision.js';
import type { EncodedMask } from '../src/schemas/geometry.js';
import { snapshotHash, type SnapshotRef } from '../src/jobs/snapshots.js';
import { type SamSnapshot } from '../src/services/vision.js';
import { auditWireCoverage } from '../src/services/wire-coverage.js';
import { partialAnalysis } from '../src/services/partial-analysis.js';
import {
  createWireRecovery,
  duplicateWire,
  type RecoveryProgress,
} from '../src/services/wire-recovery.js';
import { eligibleCandidateCount } from '../src/services/wire-evidence-policy.js';
import { continuationRegions } from '../src/services/wire-continuation.js';
import { uncertainContinuationAnchor } from '../src/services/continuation-anchor.js';
import { recoveryPlan } from '../src/services/wire-recovery-plan.js';
import { cropWorkKey } from '../src/services/crop-attempts.js';
import { retryCropWork } from '../src/services/crop-retry.js';
import { createExtensionVerifier } from '../src/services/wire-extension-verification.js';
import { JobStore, lastAttempt } from '../src/jobs/store.js';
import { AnalysisWorker } from '../src/jobs/worker.js';
import type { CropAttempt, CropRetry } from '../src/schemas/wire-recovery.js';
const masks = JSON.parse(
  readFileSync(
    new URL('./fixtures/continuation-masks.json', import.meta.url),
    'utf8',
  ),
) as Record<string, EncodedMask>;
const budget = () => ({
  requests: 0,
  pixels: 0,
  verificationRequests: 0,
  rounds: 0,
});
function wire(id = 1, kind = 'fragment'): Candidate {
  return {
    id: `jumper_wire_${id}`,
    type: 'jumper_wire',
    bbox: [110, 130, 90, kind === 'fragment' ? 10 : 20],
    encodedMask: masks[kind]!,
    cropOrigin: [100, 100, 100, 80],
  };
}
function full(): Candidate {
  return {
    ...wire(2),
    bbox: [110, 130, 150, 10],
    encodedMask: masks.extended!,
    cropOrigin: [50, 80, 280, 160],
    recoveryPromptMatched: true,
  };
}
function ref(snapshot: SamSnapshot): SnapshotRef {
  const context = {
    imageHash: 'a'.repeat(64),
    model: 'sam',
    processingVersion: 'test',
  };
  return {
    ...context,
    samSnapshotId: randomUUID(),
    samSnapshotHash: snapshotHash(snapshot, context),
    sourceAttemptId: randomUUID(),
    createdAt: 1,
    origin: 'recorded',
  };
}
async function sample(candidates: Candidate[] = [wire()]) {
  return {
    image: await prepareImage(await imageBytes(400, 300), testConfig()),
    candidates,
  };
}
const checkpoint = (v: RecoveryProgress) =>
  v.changed ? ref(v.snapshot) : undefined;
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error('Worker did not settle');
}

test('quarantined raw masks cannot consume eligible slots, suppress a valid duplicate, or explain coverage', async () => {
  const bad = Array.from({ length: 100 }, (_, i) => ({
    ...wire(i + 1),
    recoveryPromptMatched: false,
  }));
  const good = { ...wire(101), recoveryPromptMatched: true },
    snapshot = await sample([...bad, good]),
    before = JSON.stringify(snapshot);
  assert.equal(eligibleCandidateCount(snapshot.candidates), 1);
  assert.equal(duplicateWire(good, bad[0]!), false);
  const report = await auditWireCoverage(snapshot, ref(snapshot));
  assert.equal(report.quarantinedCandidates!.length, 100);
  assert.equal(report.summary.rawSamCandidates, 101);
  assert.equal(
    report.candidates.filter((c) => c.source !== 'cv_trace').length,
    1,
  );
  assert.equal(partialAnalysis(snapshot, testConfig()).objects.length, 1);
  assert.equal(JSON.stringify(snapshot), before);
  // Even an old human review of excluded evidence cannot make it explain current coverage.
  const review = {
    reviewId: randomUUID(),
    reportId: report.reportId,
    candidateIds: ['jumper_wire_1'],
    state: 'verified' as const,
    note: 'old review',
    reviewSource: 'human' as const,
    reviewedAt: 1,
    electricalConnectionStatus: 'unestablished' as const,
  };
  const audited = await auditWireCoverage(snapshot, ref(snapshot), [review]);
  assert.ok(audited.candidates.every((c) => c.verifiedCoverage === 0));
});

test('100 earlier prompt mismatches do not block a fresh matching observation of the same pixels', async () => {
  const snapshot = await sample(
      Array.from({ length: 100 }, (_, i) => ({
        ...wire(i + 1),
        recoveryPromptMatched: false,
      })),
    ),
    reference = ref(snapshot);
  const seed: [number, number] = [140, 134];
  let calls = 0;
  const result = await createWireRecovery(testConfig(), {
    async post(_path, _body, _signal, op) {
      calls++;
      const size = op!.imageDimensions![0]!,
        crop = [68, 62],
        m = masks.fragment!;
      return samEnvelope(
        `<0f>1<|box;x1=${110 - crop[0]!};y1=${130 - crop[1]!};x2=${199 - crop[0]!};y2=${139 - crop[1]!};w=${size.width};h=${size.height}|><|mask;x=0;y=0;data=${m.height},${m.width},${m.payload}|>`,
      );
    },
  })(
    {
      snapshot,
      ref: reference,
      reviews: [],
      budget: budget(),
      visited: [],
      operation: 'recover_short',
      target: { pitchPx: 12, gridPoints: [], manualPoint: seed },
    },
    new AbortController().signal,
    undefined,
    checkpoint,
  );
  assert.equal(calls, 1);
  assert.equal(result.snapshot.candidates.length, 101);
  assert.equal(eligibleCandidateCount(result.snapshot.candidates), 1);
  assert.equal(result.snapshot.candidates.at(-1)!.recoveryPromptMatched, true);
});

test('uncertain topology can request a new observation using one connected boundary component; equally plausible components abstain', async () => {
  const source = wire(1, 'uncertain'),
    snapshot = await sample([source]),
    report = await auditWireCoverage(snapshot, ref(snapshot));
  assert.notEqual(report.candidates[0]!.metrics.ends, 2);
  const diagnostics: NonNullable<typeof report.continuationDiagnostics> = [],
    targets = continuationRegions(snapshot, report, 2_000_000, diagnostics);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.mode, 'continuation_uncertain');
  assert.equal(targets[0]!.positivePoints.length, 1);
  assert.ok(
    targets[0]!.positivePoints[0]![1] >= 134 &&
      targets[0]!.positivePoints[0]![1] <= 136,
  );
  assert.equal(
    report.candidates[0]!.geometryAccepted,
    false,
    'request eligibility does not relax mask acceptance',
  );
  assert.deepEqual(uncertainContinuationAnchor(wire(1, 'ambiguous')), {
    reason: 'ambiguous_boundary_components',
  });
  const next = await sample([wire(1, 'ambiguous')]),
    nextReport = await auditWireCoverage(next, ref(next)),
    decisions: typeof diagnostics = [];
  assert.deepEqual(
    continuationRegions(next, nextReport, 2_000_000, decisions),
    [],
  );
  assert.equal(decisions[0]!.reason, 'ambiguous_boundary_components');
  const supported = {
    ...targets[0]!,
    mode: 'continuation' as const,
    positivePoints: [[120, 135]] as [number, number][],
  };
  assert.equal(
    recoveryPlan([supported, ...targets], [], [], [], true)[0]!.mode,
    'continuation_uncertain',
  );
});

test('the uncertain-topology request allowance is cumulative, including unsuccessful normal dispatches', async () => {
  const snapshot = await sample([wire(1, 'uncertain')]);
  let calls = 0,
    saved: RecoveryProgress | undefined;
  const recover = createWireRecovery(
    { ...testConfig(), WIRE_RECOVERY_REQUESTS_PER_ROUND: 4 },
    {
      async post() {
        calls++;
        return samEnvelope('');
      },
    },
  );
  const first = await recover(
    {
      snapshot,
      ref: ref(snapshot),
      reviews: [],
      budget: budget(),
      visited: [],
      operation: 'recover',
    },
    new AbortController().signal,
    undefined,
    (v) => {
      saved = v;
      return checkpoint(v);
    },
  );
  assert.equal(calls, 1);
  assert.equal(first.cropAttempts[0]!.mode, 'continuation_uncertain');
  const exhausted = await recover(
    {
      snapshot,
      ref: ref(snapshot),
      reviews: [],
      budget: first.budget,
      visited: first.visited,
      cropAttempts: first.cropAttempts,
      operation: 'recover',
    },
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(exhausted.report.stopReason, 'request_budget');
  assert.equal(saved!.budget.requests, 1);
});

function failedCrop(): CropAttempt {
  const region: [number, number, number, number] = [0, 0, 200, 200];
  return {
    attemptId: randomUUID(),
    region,
    mode: 'tiles',
    workKeys: [cropWorkKey(region)],
    status: 'timed_out',
    upstreamOutcome: 'unknown',
    startedAt: 1,
    finishedAt: 2,
  };
}
function permission(a: CropAttempt): CropRetry {
  return {
    attemptId: a.attemptId,
    authorization: 'accept_unknown_upstream',
    reason: 'Explicit test retry after inspecting saved evidence',
    authorizedAt: 3,
  };
}

test('explicit retry keeps the original work identity and timeout, requires unknown-outcome acknowledgement, and permits no retry chain', () => {
  const a = failedCrop(),
    auth = permission(a),
    before = JSON.stringify(a);
  assert.throws(
    () => retryCropWork([a], { ...auth, authorization: 'known_outcome' }),
    /upstream/,
  );
  const work = retryCropWork([a], auth);
  assert.deepEqual(work.workKeys, a.workKeys);
  assert.equal(JSON.stringify(a), before);
  const child = {
    ...a,
    attemptId: randomUUID(),
    retryOf: a.attemptId,
    retryAuthorization: auth,
  };
  assert.throws(() => retryCropWork([a, child], auth), /already/);
  assert.throws(() => retryCropWork([a, child], permission(child)), /only one/);
  assert.throws(
    () => retryCropWork([{ ...a, status: 'running' }], auth),
    /Retry a failed/,
  );
  assert.throws(
    () => retryCropWork([{ ...a, status: 'succeeded' }], auth),
    /Retry a failed/,
  );
  assert.doesNotThrow(() =>
    retryCropWork(
      [{ ...a, status: 'failed', upstreamOutcome: 'response_received' }],
      { ...auth, authorization: 'known_outcome' },
    ),
  );
});

test('explicit retry dispatches once, charges a new request, persists its authorization, and never overwrites the original attempt', async () => {
  const snapshot = await sample(),
    a = failedCrop(),
    auth = permission(a),
    original = JSON.stringify(a);
  let calls = 0;
  const result = await createWireRecovery(testConfig(), {
    async post() {
      calls++;
      return samEnvelope('');
    },
  })(
    {
      snapshot,
      ref: ref(snapshot),
      reviews: [],
      budget: { ...budget(), requests: 1, pixels: 40000, rounds: 1 },
      visited: [a.region],
      cropAttempts: [a],
      operation: 'retry_crop',
      cropRetry: auth,
    },
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(result.budget.requests, 2);
  assert.equal(result.budget.pixels, 80000);
  assert.equal(JSON.stringify(result.cropAttempts[0]), original);
  assert.equal(result.cropAttempts[1]!.retryOf, a.attemptId);
  assert.deepEqual(result.cropAttempts[1]!.retryAuthorization, auth);
  assert.deepEqual(result.cropAttempts[1]!.workKeys, a.workKeys);
});

test('durable retry admission rejects concurrent authorization and fences a late retry response after lease takeover', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-crop-retry-')),
    config = testConfig(),
    store = new JobStore(config, dir),
    other = new JobStore(config, dir),
    snapshot = await sample(),
    job = store.create(await imageBytes(400, 300), snapshot.image);
  job.sam.status = 'succeeded';
  lastAttempt(job, 'sam')!.status = 'succeeded';
  job.sam.snapshot = snapshot;
  job.sam.result = partialAnalysis(snapshot, config);
  job.status = 'partial';
  store.save(job);
  const saved = store.get(job.analysisId),
    original = failedCrop();
  saved.recovery.cropAttempts = [original];
  saved.recovery.visited = [original.region];
  saved.recovery.budget = {
    requests: 1,
    pixels: 40000,
    rounds: 1,
    verificationRequests: 0,
  };
  store.save(saved);
  assert.throws(
    () =>
      store.requestRecovery(job.analysisId, 'retry_crop', undefined, {
        ...permission(original),
        authorizedAt: undefined,
      }),
    /authorization/,
  );
  const request = {
    attemptId: original.attemptId,
    authorization: 'accept_unknown_upstream',
    reason: 'Operator inspected the timed-out request',
  };
  assert.throws(
    () =>
      store.requestRecovery(job.analysisId, 'retry_crop', undefined, {
        ...request,
        authorization: 'known_outcome',
      }),
    /upstream/,
  );
  store.requestRecovery(job.analysisId, 'retry_crop', undefined, request);
  assert.throws(
    () =>
      other.requestRecovery(job.analysisId, 'retry_crop', undefined, request),
    /active/,
  );
  let entered = false,
    release!: (value: unknown) => void;
  const worker = new AnalysisWorker(
    store,
    config,
    () => undefined,
    undefined,
    (settings) =>
      createWireRecovery(settings, {
        async post() {
          entered = true;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      }),
  );
  t.after(async () => {
    await worker.close();
    store.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  });
  worker.start();
  await until(() => entered);
  const stale = store.get(job.analysisId);
  stale.leaseUntil = Date.now() - 1;
  store.save(stale);
  other.recover();
  const protectedJob = other.get(job.analysisId);
  assert.equal(protectedJob.recovery.cropAttempts[1]!.status, 'interrupted');
  assert.equal(protectedJob.recovery.budget.requests, 2);
  const before = JSON.stringify(protectedJob.recovery);
  release(samEnvelope(''));
  await delay(60);
  assert.equal(JSON.stringify(other.get(job.analysisId).recovery), before);
  assert.equal(
    other.get(job.analysisId).recovery.cropAttempts[0]!.status,
    'timed_out',
  );
  assert.throws(
    () =>
      other.requestRecovery(job.analysisId, 'retry_crop', undefined, request),
    /budget|already/i,
  );
});

test('extension verification compares original pixels and both masks; favorable model evidence cannot establish human identity or a connection', async () => {
  const snapshot = await sample([wire(), full()]),
    reference = ref(snapshot),
    report = await auditWireCoverage(snapshot, reference),
    request = {
      reportId: report.reportId,
      sourceCandidateId: 'jumper_wire_1',
      candidateId: 'jumper_wire_2',
    };
  assert.ok(
    report.hypotheses.some((h) => h.kind === 'mask_extension_proposal'),
  );
  let calls = 0;
  const proposal = {
    decision: 'same_physical_wire',
    continuity: 'visible',
    adjacentWires: 'distinguished',
    crossings: 'none_visible',
    componentLeads: 'excluded',
  };
  const review = await createExtensionVerifier(testConfig(), {
    async post(_path, body, _signal, options) {
      calls++;
      assert.equal(options!.maxRetries, 0);
      assert.equal(options!.imageDimensions!.length, 4);
      assert.match(JSON.stringify(body.messages), /original fragment overlay/);
      return completion(proposal);
    },
  })(snapshot, report, request, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(review.evidenceStatus, 'supports_same_wire');
  assert.equal(review.reviewSource, 'muse');
  assert.equal(review.electricalConnectionStatus, 'unestablished');
  assert.equal(review.sourceSnapshotHash, reference.samSnapshotHash);
  const result = await createWireRecovery(testConfig(), {
    async post() {
      return completion(proposal);
    },
  })(
    {
      snapshot,
      ref: reference,
      reviews: [],
      budget: budget(),
      visited: [],
      operation: 'verify_extension',
      extensionVerification: request,
      previous: report,
    },
    new AbortController().signal,
  );
  assert.equal(result.budget.verificationRequests, 1);
  assert.equal(result.report.extensionReviews!.length, 1);
  assert.ok(
    result.report.candidates.every(
      (c) => c.identityStatus === 'unverified' && c.verifiedCoverage === 0,
    ),
  );
  const again = await auditWireCoverage(
    snapshot,
    reference,
    [],
    1280,
    result.report,
  );
  assert.deepEqual(again.extensionReviews, result.report.extensionReviews);
});

test('ambiguous crossings or hidden continuity cannot accompany a same-wire verdict; stale, quarantined and truncated extension requests do not dispatch', async () => {
  const snapshot = await sample([wire(), full()]),
    report = await auditWireCoverage(snapshot, ref(snapshot)),
    request = {
      reportId: report.reportId,
      sourceCandidateId: 'jumper_wire_1',
      candidateId: 'jumper_wire_2',
    };
  const base = {
    decision: 'same_physical_wire',
    continuity: 'visible',
    adjacentWires: 'none_visible',
    crossings: 'none_visible',
    componentLeads: 'none_visible',
  };
  for (const bad of [
    { ...base, crossings: 'ambiguous' },
    { ...base, continuity: 'occluded' },
    { ...base, componentLeads: 'ambiguous' },
    { ...base, adjacentWires: 'ambiguous' },
  ])
    await assert.rejects(
      () =>
        createExtensionVerifier(testConfig(), {
          async post() {
            return completion(bad);
          },
        })(snapshot, report, request, new AbortController().signal),
      /invalid/i,
    );
  const abstention = await createExtensionVerifier(testConfig(), {
    async post() {
      return completion({
        ...base,
        decision: 'crossing_ambiguous',
        crossings: 'ambiguous',
      });
    },
  })(snapshot, report, request, new AbortController().signal);
  assert.equal(abstention.evidenceStatus, 'insufficient');
  let calls = 0;
  const verify = createExtensionVerifier(testConfig(), {
    async post() {
      calls++;
      throw new Error('No dispatch');
    },
  });
  await assert.rejects(
    () =>
      verify(
        snapshot,
        report,
        { ...request, reportId: 'f'.repeat(64) },
        new AbortController().signal,
      ),
    /current report/,
  );
  await assert.rejects(
    () =>
      verify(
        {
          ...snapshot,
          candidates: [
            snapshot.candidates[0]!,
            { ...snapshot.candidates[1]!, recoveryPromptMatched: false },
          ],
        },
        report,
        request,
        new AbortController().signal,
      ),
    /Quarantined/,
  );
  await assert.rejects(
    () =>
      verify(
        {
          ...snapshot,
          candidates: [
            snapshot.candidates[0]!,
            { ...snapshot.candidates[1]!, cropOrigin: [110, 130, 150, 10] },
          ],
        },
        report,
        request,
        new AbortController().signal,
      ),
    /remaining crop/,
  );
  assert.equal(calls, 0);
});

test('recovery HTTP actions validate retry authorization and current extension binding before queueing any work', async (t) => {
  const { default: Fastify } = await import('fastify');
  const { registerAnalysisRoutes } = await import('../src/routes/analyses.js');
  const config = testConfig(),
    store = new JobStore(config, ':memory:'),
    app = Fastify();
  let kicks = 0;
  registerAnalysisRoutes(app, config, store, () => {
    kicks++;
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  async function saved(candidates: Candidate[]) {
    const snapshot = await sample(candidates),
      job = store.create(await imageBytes(400, 300), snapshot.image);
    job.sam.status = 'succeeded';
    lastAttempt(job, 'sam')!.status = 'succeeded';
    job.sam.snapshot = snapshot;
    job.sam.result = partialAnalysis(snapshot, config);
    job.status = 'partial';
    store.save(job);
    const loaded = store.get(job.analysisId);
    loaded.recovery.report = await auditWireCoverage(
      snapshot,
      loaded.sam.snapshotRef!,
    );
    loaded.recovery.status = 'succeeded';
    store.save(loaded);
    return loaded;
  }
  const job = await saved([wire()]),
    a = failedCrop();
  job.recovery.cropAttempts = [a];
  job.recovery.visited = [a.region];
  store.save(job);
  const url = `/api/analyses/${job.analysisId}/retry-wire-crop`,
    request = {
      attemptId: a.attemptId,
      authorization: 'accept_unknown_upstream',
      reason: 'Operator checked the previous timeout',
    };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url,
        payload: { ...request, reason: '' },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url,
        payload: { ...request, authorization: 'known_outcome' },
      })
    ).statusCode,
    409,
  );
  const response = await app.inject({ method: 'POST', url, payload: request });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().recovery.operation, 'retry_crop');
  assert.equal(response.json().recovery.cropAttempts[0].status, 'timed_out');
  assert.equal(
    (await app.inject({ method: 'POST', url, payload: request })).statusCode,
    409,
  );
  const extensionJob = await saved([wire(), full()]),
    report = extensionJob.recovery.report!,
    extensionUrl = `/api/analyses/${extensionJob.analysisId}/verify-wire-extension`,
    selection = {
      reportId: report.reportId,
      sourceCandidateId: 'jumper_wire_1',
      candidateId: 'jumper_wire_2',
    };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: extensionUrl,
        payload: { ...selection, reportId: 'f'.repeat(64) },
      })
    ).statusCode,
    409,
  );
  const queued = await app.inject({
    method: 'POST',
    url: extensionUrl,
    payload: selection,
  });
  assert.equal(queued.statusCode, 202);
  assert.equal(queued.json().recovery.operation, 'verify_extension');
  assert.deepEqual(queued.json().wireIdentities, []);
  await delay(5);
  assert.equal(kicks, 2, 'only two valid requests queued work');
});
