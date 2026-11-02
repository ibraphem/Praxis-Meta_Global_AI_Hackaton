import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMetaClient } from '../src/lib/meta-client.js';
import { AnalysisTrace } from '../src/lib/diagnostics.js';
import { runTerminalStage } from '../src/jobs/terminal-worker.js';
import { ConnectorJunctionService } from '../src/jobs/connector-junctions.js';
import { resolveAcceptedConnectorMask } from '../src/jobs/accepted-connector-mask.js';
import { materializeAcceptedJunctionMask } from '../src/jobs/accepted-connector-mask.js';
import { decodeMaskToRaster } from '@meta-sam/parser';
import { junctionRaster } from '../src/services/connector-junctions.js';
import { canonicalHash } from '../src/lib/canonical-json.js';
import { exportJobEvidence } from '../src/jobs/evidence.js';
import { checkpointScene } from '../src/jobs/scene-snapshots.js';
import { syntheticConnectorFixture } from './fixtures/connector-workflow.js';
import {
  acceptedJunctionFixture,
  junctionApproval,
  syntheticJunctionResponse,
} from './fixtures/connector-junctions.js';
import {
  generateJunctionCandidates,
  evaluateJunctions,
} from '../src/services/connector-junctions.js';
import type {
  JunctionReference,
  JunctionRecord,
} from '../src/schemas/connector-junctions.js';
import { maskFixture } from './helpers.js';
import type { MetaClient } from '../src/lib/meta-client.js';
import { buildApp } from '../src/app.js';
test('handoff materializes the exact evaluated keep-ring subset without rewriting native SAM evidence', () => {
  const mask = {
      observationId: randomUUID(),
      bbox: [40, 40, 20, 20] as [number, number, number, number],
      encodedMask: maskFixture('blob'),
    },
    native = decodeMaskToRaster(mask.encodedMask),
    i = native.findIndex((v) => v === 1),
    x = i % 20,
    y = Math.floor(i / 20),
    ring = { crop: mask.bbox, runs: [[y, x, x + 1]] },
    before = canonicalHash(mask),
    accepted = materializeAcceptedJunctionMask(
      mask,
      { width: 100, height: 100 },
      'keep_dark_halo',
      ring,
    );
  assert.equal(
    junctionRaster(accepted.body).reduce((n, v) => n + v, 0),
    1,
  );
  assert.deepEqual(accepted.acceptedBounds, [40 + x, 40 + y, 1, 1]);
  assert.equal(accepted.scoredMask, 'keep_dark_halo');
  assert.equal(accepted.refinementHash, canonicalHash(ring));
  assert.equal(canonicalHash(mask), before);
  assert.notEqual(
    accepted.acceptedRasterHash,
    materializeAcceptedJunctionMask(
      mask,
      { width: 100, height: 100 },
      'native',
      undefined,
    ).acceptedRasterHash,
  );
  assert.throws(
    () =>
      materializeAcceptedJunctionMask(
        mask,
        { width: 100, height: 100 },
        'keep_dark_halo',
        undefined,
      ),
    /missing/,
  );
  assert.throws(
    () =>
      materializeAcceptedJunctionMask(
        mask,
        { width: 100, height: 100 },
        undefined,
        ring,
      ),
    /ambiguous/,
  );
});
async function run(
  f: Awaited<ReturnType<typeof acceptedJunctionFixture>>,
  planId: string,
  client: MetaClient,
) {
  const r = f.service.get(planId),
    job = f.service.admit(f.job.analysisId, junctionApproval(r.plan));
  const owner = randomUUID(),
    claim = f.store.claim(owner)!;
  assert.equal(claim.stage, 'scene');
  await runTerminalStage(
    f.store,
    claim.job,
    owner,
    claim.attemptId,
    f.config,
    client,
    new AbortController().signal,
    new AnalysisTrace(claim.attemptId),
  );
  return job;
}
test('missing or provisional C acceptance blocks preparation before any junction queue or charge', async (t) => {
  const f = await syntheticConnectorFixture(':memory:', false);
  t.after(() => f.store.close());
  const service = new ConnectorJunctionService(f.store);
  assert.throws(
    () =>
      resolveAcceptedConnectorMask(
        f.store,
        f.job.analysisId,
        f.prepareBody.objectId,
      ),
    /Strategy C/,
  );
  await assert.rejects(
    service.prepare(f.job.analysisId, {
      connectorObjectId: f.prepareBody.objectId,
      conductorObjectIds: [randomUUID(), randomUUID()],
      snapshotHash: f.job.scene!.snapshotRef!.snapshotHash,
      useMuse: true,
    }),
    /Strategy C/,
  );
  assert.equal(service.forAnalysis(f.job.analysisId).length, 0);
  assert.equal(
    f.store.get(f.job.analysisId).scene!.budget.terminalRequests ?? 0,
    0,
  );
});
test('boundary candidates cover every side, keep bbox searches unlocated and never establish attachment', () => {
  const body = {
      observationId: randomUUID(),
      bbox: [40, 40, 20, 20] as [number, number, number, number],
      encodedMask: maskFixture('blob'),
    },
    wires = [
      {
        objectId: randomUUID(),
        bbox: [35, 30, 30, 12] as [number, number, number, number],
        masks: [],
      },
      {
        objectId: randomUUID(),
        bbox: [25, 35, 12, 30] as [number, number, number, number],
        masks: [],
      },
    ];
  const result = generateJunctionCandidates(body, wires, [16, 16, 68, 68]);
  assert.ok(result.boundaryPixelCount > 0);
  assert.ok(result.candidates.length > 0);
  assert.ok(
    result.candidates.every(
      (c) =>
        c.position === null &&
        c.source === 'bbox_search_only' &&
        !c.physicalAttachmentEstablished,
    ),
  );
  assert.ok(result.candidates.some((c) => c.region[1] < body.bbox[1]));
});
test('one Muse attempt captures both images and raw provenance; housing entries never become hidden contacts', async (t) => {
  const f = await acceptedJunctionFixture(t),
    before = canonicalHash(f.store.get(f.job.analysisId).scene!.graph),
    r = await f.service.prepare(f.job.analysisId, f.prepareBody);
  let calls = 0;
  const client = createMetaClient(f.config, async (_url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string);
    assert.equal(
      body.messages[1].content.filter(
        (c: { type: string }) => c.type === 'image_url',
      ).length,
      2,
    );
    return Response.json(syntheticJunctionResponse(r.plan));
  });
  assert.equal(r.plan.budget.inputPixels, r.plan.crop[2] * r.plan.crop[3] * 2);
  await run(f, r.plan.planId, client);
  const result = f.service.publicRecord(r.plan.planId);
  assert.equal(calls, 1);
  assert.equal(result.phase, 'finished');
  assert.equal(result.accounting.dispatchAttempts, 1);
  assert.equal(result.accounting.responsesRecorded, 1);
  assert.ok(
    result.outcomes.every(
      (o) =>
        o.kind === 'housing_entry' &&
        o.associationStatus === 'proposed' &&
        o.contactPosition === null &&
        o.contactVisibility === 'occluded',
    ),
  );
  assert.ok(
    result.outcomes.every(
      (o) => o.electricalConnectionStatus === 'unestablished',
    ),
  );
  assert.equal(f.service.audit(r.plan.planId, f.job.analysisId).valid, true);
  assert.equal(
    canonicalHash(f.store.get(f.job.analysisId).scene!.graph),
    before,
  );
  assert.equal(f.store.get(f.job.analysisId).scene!.budget.requests, 0);
  assert.throws(
    () => f.service.admit(f.job.analysisId, junctionApproval(r.plan)),
    /already has an admitted/,
  );
  assert.equal(calls, 1);
});
test('offline completion emits exactly two unresolved outcomes and spends zero requests', async (t) => {
  const f = await acceptedJunctionFixture(t),
    r = await f.service.prepare(f.job.analysisId, {
      ...f.prepareBody,
      useMuse: false,
    });
  const never: MetaClient = {
    post: async () => {
      throw Error('No provider request is allowed.');
    },
  };
  await run(f, r.plan.planId, never);
  const result = f.service.publicRecord(r.plan.planId);
  assert.equal(result.phase, 'finished');
  assert.equal(result.accounting.reservedRequests, 0);
  assert.equal(result.accounting.dispatchAttempts, 0);
  assert.equal(result.outcomes.length, 2);
  assert.ok(
    result.outcomes.every(
      (o) => o.position === null && o.associationStatus === 'unresolved',
    ),
  );
  const other = await f.service.prepare(f.job.analysisId, f.prepareBody);
  assert.throws(
    () => f.service.admit(f.job.analysisId, junctionApproval(other.plan)),
    /already has an admitted/,
  );
});
test('occluded junctions abstain rather than exposing guessed contacts', async (t) => {
  const f = await acceptedJunctionFixture(t),
    r = await f.service.prepare(f.job.analysisId, f.prepareBody);
  let calls = 0;
  await run(
    f,
    r.plan.planId,
    createMetaClient(f.config, async () => {
      calls++;
      return Response.json(syntheticJunctionResponse(r.plan, true));
    }),
  );
  const result = f.service.publicRecord(r.plan.planId);
  assert.equal(result.phase, 'finished');
  assert.ok(
    result.outcomes.every(
      (o) => o.visibility === 'occluded' && o.position === null,
    ),
  );
  assert.equal(calls, 1);
  assert.throws(
    () =>
      f.service.review(f.job.analysisId, {
        planId: r.plan.planId,
        revision: result.revision,
        outcomeId: result.outcomes[0]!.id,
        decision: 'confirm',
        position: null,
        kind: 'exposed_contact',
        reason: 'Guess a hidden contact.',
        reviewer: 'Reviewer',
        originalImageOnly: true,
        visibleEvidence: false,
      }),
    /Hidden contacts/,
  );
});
test('malformed or foreign conductor claims stop after one captured response', async (t) => {
  for (const foreign of [true, false]) {
    const f = await acceptedJunctionFixture(t),
      r = await f.service.prepare(f.job.analysisId, f.prepareBody);
    let calls = 0;
    const response = syntheticJunctionResponse(r.plan),
      content = JSON.parse(response.choices[0]!.message.content);
    if (foreign) content.junctions[0].conductorObjectId = randomUUID();
    else content.junctions[0].position = [9999, 9999];
    response.choices[0]!.message.content = JSON.stringify(content);
    await run(
      f,
      r.plan.planId,
      createMetaClient(f.config, async () => {
        calls++;
        return Response.json(response);
      }),
    );
    const result = f.service.publicRecord(r.plan.planId);
    assert.equal(calls, 1);
    assert.equal(result.phase, 'failed');
    assert.equal(result.accounting.responsesRecorded, 1);
    assert.equal(result.accounting.unknownUsageRequests, 0);
    assert.ok(result.outcomes.every((o) => o.position === null));
    assert.ok(
      f.service.evidence(r.plan.planId, f.job.analysisId).request?.response,
    );
  }
});
test('five-pixel scoring compares original-image coordinates and junction kind without inventing hidden contacts', async (t) => {
  const f = await acceptedJunctionFixture(t),
    r = await f.service.prepare(f.job.analysisId, {
      ...f.prepareBody,
      useMuse: false,
    }),
    record = f.service.publicRecord(r.plan.planId);
  const outcomes: JunctionRecord['effectiveOutcomes'] =
    record.effectiveOutcomes.map((o, i) => ({
      ...o,
      kind: 'housing_entry',
      visibility: 'visible',
      position: [80 + i * 15, 50],
      conductorObjectId: o.expectedConductorObjectId,
      associationStatus: 'confirmed',
      evidenceSource: 'human_review',
      reviewId: randomUUID(),
    }));
  const reference: JunctionReference = {
    referenceHash: 'f'.repeat(64),
    planId: r.plan.planId,
    version: 1,
    frozenAt: 1,
    independent: false,
    content: {
      imageHash: r.plan.imageHash,
      connectorObjectId: r.plan.connectorObjectId,
      reviewer: 'Synthetic fixture',
      source: 'synthetic_fixture',
      annotationMethod: 'synthetic_fixture',
      predictionExposure: 'unknown',
      originalImageOnly: true,
      independentAttestation: false,
      junctions: outcomes.map((o, i) => ({
        conductorObjectId: o.expectedConductorObjectId,
        kind: 'housing_entry',
        visibility: 'visible',
        position: i ? [95, 50] : [83, 54],
      })),
    },
  };
  const score = evaluateJunctions(
    r.plan,
    outcomes,
    reference,
    true,
    'reviewed',
  );
  assert.equal(score.status, 'synthetic_pass');
  assert.equal(score.perConductor[0]!.errorPixels, 5);
  assert.equal(score.wrongConfirmedAssociations, 0);
  const wrong = structuredClone(reference);
  wrong.content.junctions[0]!.position = [86, 50];
  assert.equal(
    evaluateJunctions(r.plan, outcomes, wrong, true, 'reviewed').status,
    'failed',
  );
  assert.equal(
    evaluateJunctions(r.plan, outcomes, wrong, true, 'reviewed')
      .wrongConfirmedAssociations,
    1,
  );
  const hidden = structuredClone(reference);
  hidden.content.junctions = hidden.content.junctions.map((j) => ({
    ...j,
    kind: 'exposed_contact',
    visibility: 'occluded',
    position: null,
  }));
  const abstained = evaluateJunctions(r.plan, outcomes, hidden, true);
  assert.equal(abstained.appropriateAbstentions, 2);
  assert.equal(abstained.status, 'incomplete');
  assert.equal(abstained.visibleExpected, 0);
});
test('stale source and mismatched exact authorization reject before dispatch', async (t) => {
  const f = await acceptedJunctionFixture(t),
    r = await f.service.prepare(f.job.analysisId, f.prepareBody);
  assert.throws(
    () =>
      f.service.admit(f.job.analysisId, {
        ...junctionApproval(r.plan),
        pixels: 1,
      }),
    /exactly/,
  );
  const job = f.store.get(f.job.analysisId),
    graph = structuredClone(job.scene!.graph!);
  graph.objects[0]!.bbox[0]++;
  checkpointScene(f.store, job, graph, [], randomUUID());
  f.store.save(job);
  assert.throws(
    () => f.service.admit(f.job.analysisId, junctionApproval(r.plan)),
    /Strategy C|changed/,
  );
  assert.equal(f.service.get(r.plan.planId).admittedAt, null);
  assert.equal(
    f.store.get(f.job.analysisId).scene!.budget.terminalRequests ?? 0,
    0,
  );
});
test('reviews are append-only, stale revisions fail, corrections do not become independent truth, and evidence survives export', async (t) => {
  const f = await acceptedJunctionFixture(t),
    r = await f.service.prepare(f.job.analysisId, f.prepareBody);
  await run(
    f,
    r.plan.planId,
    createMetaClient(f.config, async () =>
      Response.json(syntheticJunctionResponse(r.plan)),
    ),
  );
  let result = f.service.publicRecord(r.plan.planId);
  const input = {
    planId: r.plan.planId,
    revision: result.revision,
    outcomeId: result.outcomes[0]!.id,
    decision: 'confirm',
    position: result.outcomes[0]!.position,
    kind: 'housing_entry',
    reason: 'Original fixture insulation visibly enters the housing.',
    reviewer: 'Exposed reviewer',
    originalImageOnly: true,
    visibleEvidence: true,
  };
  result = f.service.review(f.job.analysisId, input);
  assert.equal(result.effectiveOutcomes[0]!.associationStatus, 'confirmed');
  assert.equal(result.outcomes[0]!.associationStatus, 'proposed');
  assert.throws(() => f.service.review(f.job.analysisId, input), /Reload/);
  assert.throws(
    () =>
      f.store.db
        .prepare('UPDATE connector_junction_reviews SET data=?')
        .run('{}'),
    /immutable/,
  );
  const content = {
    imageHash: r.plan.imageHash,
    connectorObjectId: r.plan.connectorObjectId,
    reviewer: 'Exposed reviewer',
    source: 'human_review',
    annotationMethod: 'manual_point',
    predictionExposure: 'never_seen',
    originalImageOnly: true,
    independentAttestation: true,
    junctions: result.outcomes.map((o) => ({
      conductorObjectId: o.expectedConductorObjectId,
      kind: 'housing_entry',
      visibility: 'visible',
      position: o.position,
    })),
  };
  const reference = f.service.freezeReference(f.job.analysisId, {
    planId: r.plan.planId,
    content,
  });
  assert.equal(reference.independent, false);
  const diagnostic = f.service.evaluate(f.job.analysisId, {
    planId: r.plan.planId,
    referenceHash: reference.referenceHash,
  });
  assert.equal(diagnostic.status, 'diagnostic');
  assert.equal(diagnostic.localizedWithinTolerance, 2);
  const synthetic = f.service.freezeReference(f.job.analysisId, {
    planId: r.plan.planId,
    content: {
      ...content,
      reviewer: 'Synthetic reference',
      source: 'synthetic_fixture',
      annotationMethod: 'synthetic_fixture',
      predictionExposure: 'unknown',
      independentAttestation: false,
    },
  });
  const scored = f.service.evaluate(f.job.analysisId, {
    planId: r.plan.planId,
    referenceHash: synthetic.referenceHash,
  });
  assert.equal(scored.status, 'synthetic_pass');
  assert.equal(scored.independentGroundTruth, false);
  assert.equal(scored.wrongConfirmedAssociations, 0);
  const dir = mkdtempSync(join(tmpdir(), 'praxis-junction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = exportJobEvidence(
    f.store,
    f.job.analysisId,
    join(dir, 'archive'),
  );
  const file = manifest.files.find((f) =>
    f.path.startsWith('connector-junctions/'),
  )!;
  const evidence = JSON.parse(
    readFileSync(join(dir, 'archive', file.path), 'utf8'),
  );
  assert.equal(evidence.record.references.length, 2);
  assert.equal(evidence.record.evaluations.length, 2);
  assert.equal(evidence.request.request.path, 'chat/completions');
  assert.equal(evidence.privateEvidence.images.length, 2);
});
test('transport uncertainty remains charged, cannot replay, and missing provider provenance cannot pass', async (t) => {
  const f = await acceptedJunctionFixture(t),
    r = await f.service.prepare(f.job.analysisId, f.prepareBody);
  let calls = 0;
  await run(
    f,
    r.plan.planId,
    createMetaClient(f.config, async () => {
      calls++;
      throw new TypeError('Synthetic network loss');
    }),
  );
  const result = f.service.publicRecord(r.plan.planId);
  assert.equal(result.phase, 'interrupted');
  assert.equal(result.accounting.unknownUsageRequests, 1);
  assert.equal(result.accounting.reservedRequests, 1);
  assert.equal(calls, 1);
  assert.throws(
    () => f.service.admit(f.job.analysisId, junctionApproval(r.plan)),
    /already has an admitted/,
  );
  assert.throws(
    () => f.store.retry(f.job.analysisId, 'scene'),
    /retry|Retry|attempt/i,
  );
});
test('lease recovery preserves uncertain accounting and fences late responses without provider replay', async (t) => {
  const f = await acceptedJunctionFixture(t),
    r = await f.service.prepare(f.job.analysisId, f.prepareBody);
  let dispatch!: () => void, release!: (v: Response) => void;
  const sent = new Promise<void>((resolve) => (dispatch = resolve)),
    reply = new Promise<Response>((resolve) => (release = resolve));
  f.service.admit(f.job.analysisId, junctionApproval(r.plan));
  const owner = randomUUID(),
    claim = f.store.claim(owner)!;
  const task = runTerminalStage(
    f.store,
    claim.job,
    owner,
    claim.attemptId,
    f.config,
    createMetaClient(f.config, async () => {
      dispatch();
      return reply;
    }),
    new AbortController().signal,
    new AnalysisTrace(claim.attemptId),
  );
  await sent;
  f.store.db
    .prepare('UPDATE jobs SET lease_until=0 WHERE id=?')
    .run(f.job.analysisId);
  f.store.recover();
  assert.equal(f.service.publicRecord(r.plan.planId).phase, 'interrupted');
  assert.equal(
    f.service.publicRecord(r.plan.planId).accounting.unknownUsageRequests,
    1,
  );
  release(Response.json(syntheticJunctionResponse(r.plan)));
  await assert.rejects(task, /ownership|interrupted/i);
  assert.equal(
    f.service.publicRecord(r.plan.planId).accounting.responsesRecorded,
    0,
  );
});
test('failed durable dispatch transaction cannot leak a request into transport', async (t) => {
  const f = await acceptedJunctionFixture(t),
    r = await f.service.prepare(f.job.analysisId, f.prepareBody);
  let calls = 0;
  f.store.db.exec(
    "CREATE TRIGGER fail_junction_dispatch BEFORE UPDATE ON connector_junctions WHEN json_extract(NEW.data,'$.phase')='dispatching' BEGIN SELECT RAISE(ABORT,'injected dispatch failure'); END;",
  );
  await run(
    f,
    r.plan.planId,
    createMetaClient(f.config, async () => {
      calls++;
      return Response.json(syntheticJunctionResponse(r.plan));
    }),
  );
  const result = f.service.publicRecord(r.plan.planId);
  assert.equal(calls, 0);
  assert.equal(result.phase, 'failed');
  assert.equal(result.accounting.dispatchAttempts, 0);
  assert.equal(result.accounting.unknownUsageRequests, 0);
  const evidence = f.service.evidence(r.plan.planId, f.job.analysisId);
  assert.equal(evidence.request?.request, undefined);
});
test('HTTP preparation and offline run reuse the terminal worker and export accepted-mask provenance', async (t) => {
  const f = await acceptedJunctionFixture(t),
    app = await buildApp(f.config, undefined, () => {}, undefined, {
      store: f.store,
    });
  t.after(() => app.close());
  const base = `/api/analyses/${f.job.analysisId}`;
  const prepared = await app.inject({
    method: 'POST',
    url: `${base}/prepare-connector-junctions`,
    payload: { ...f.prepareBody, useMuse: false },
  });
  assert.equal(prepared.statusCode, 200);
  const record = prepared.json().connectorJunctions[0];
  assert.equal(record.plan.budget.museRequests, 0);
  const queued = await app.inject({
    method: 'POST',
    url: `${base}/run-connector-junctions`,
    payload: junctionApproval(record.plan),
  });
  assert.equal(queued.statusCode, 202);
  let current = f.service.publicRecord(record.plan.planId);
  for (let i = 0; i < 50 && current.phase !== 'finished'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    current = f.service.publicRecord(record.plan.planId);
  }
  assert.equal(current.phase, 'finished');
  assert.equal(current.accounting.dispatchAttempts, 0);
  const downloaded = await app.inject({
    method: 'GET',
    url: `${base}/connector-junction-evidence?planId=${record.plan.planId}`,
  });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.json().record.plan.planId, record.plan.planId);
  assert.ok(
    downloaded.json().privateEvidence.acceptanceEvidence.reference
      .referenceHash,
  );
  assert.equal(
    downloaded.json().privateEvidence.acceptanceEvidence.evaluation.strategy,
    'C-body-aware-v2',
  );
  const repeated = await app.inject({
    method: 'POST',
    url: `${base}/run-connector-junctions`,
    payload: junctionApproval(record.plan),
  });
  assert.equal(repeated.statusCode, 409);
  const generic = await app.inject({
    method: 'POST',
    url: `${base}/discover-terminals`,
    payload: {
      snapshotId: record.plan.inputSnapshotId,
      snapshotHash: record.plan.inputSnapshotHash,
      objectIds: [record.plan.connectorObjectId],
    },
  });
  assert.equal(generic.statusCode, 409);
  assert.equal(generic.json().error.code, 'TERMINAL_ALREADY_ATTEMPTED');
  await app.close();
});
