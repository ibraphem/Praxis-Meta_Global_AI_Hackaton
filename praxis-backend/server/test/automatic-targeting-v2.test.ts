import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { proposeAutomaticTargetingV2 } from '../src/services/scene-automatic-targeting-v2.js';
import { proposeAutomaticTargeting } from '../src/services/scene-automatic-targeting.js';
import { connectorProtocolV2 } from '../src/services/connector-protocol-v2.js';
import { canonicalHash } from '../src/lib/canonical-json.js';
import { ConnectorWorkflowService } from '../src/jobs/connector-workflow.js';
import {
  evaluateConnectorPixels,
  evaluateConnectorPixelsV2,
} from '../src/services/connector-pixel-evaluation.js';
import { prepareAutomaticConnectorExperiment } from '../src/jobs/scene-connector-experiment.js';
import {
  syntheticConnectorFixture,
  syntheticConnectorClient,
  workflowApproval,
} from './fixtures/connector-workflow.js';
import { maskFixture } from './helpers.js';
import type { BoundingBox } from '../src/schemas/vision.js';
import { targetingV2DiagnosticsSchema } from '../src/schemas/targeting-v2.js';
import { checkpointScene } from '../src/jobs/scene-snapshots.js';
import { ConnectorValidationService } from '../src/jobs/connector-validation.js';
import { decodeMaskToRaster } from '@meta-sam/parser';

async function scene(t: { after: (f: () => void) => void }, baseline = true) {
  const f = await syntheticConnectorFixture(':memory:', baseline);
  t.after(() => f.store.close());
  const objectId = f.prepareBody.objectId,
    observation = f.graph.observations.find((o) => o.source === 'sam')!,
    native = [
      { observationId: observation.id, encodedMask: maskFixture('blob') },
    ],
    crop: BoundingBox = [0, 0, 200, 160],
    rgb = new Uint8Array(200 * 160 * 3).fill(255);
  const rectangle = (
    x: number,
    y: number,
    w: number,
    h: number,
    value = 20,
  ) => {
    for (let py = y; py < y + h; py++)
      for (let px = x; px < x + w; px++)
        rgb.fill(value, (py * 200 + px) * 3, (py * 200 + px) * 3 + 3);
  };
  const proposal = () =>
    proposeAutomaticTargetingV2(f.graph, objectId, crop, native, {
      width: 200,
      height: 160,
      rgb,
    });
  return {
    ...f,
    objectId,
    observation,
    native,
    crop,
    rgb,
    rectangle,
    proposal,
  };
}
test('v2 diagnoses missing baseline association separately and never invents one from inventory or reference evidence', async (t) => {
  const f = await scene(t, false),
    before = canonicalHash(f.graph),
    p = f.proposal();
  assert.equal(p.pointStatus, 'abstained');
  assert.deepEqual(p.diagnostics.baseline[0]!.reasons, [
    'no_target_baseline_association',
  ]);
  assert.equal(
    p.diagnostics.bodyProposal.reason,
    'no_supported_dark_body_core',
  );
  assert.equal(canonicalHash(f.graph), before);
  assert.equal(p.variants.length, 1);
  targetingV2DiagnosticsSchema.parse(p.diagnostics);
});
test('v2 recovers an interior point when a reviewed conductor mask is disjoint despite overlapping boxes; v1 stays unchanged', async (t) => {
  const f = await scene(t),
    wire = f.graph.objects.find((o) => o.category === 'conductor')!;
  wire.bbox = [70, 30, 50, 70];
  const wireObservation = {
    ...f.observation,
    id: randomUUID(),
    bbox: [105, 40, 20, 20] as BoundingBox,
  };
  f.graph.observations.push(wireObservation);
  f.native.push({
    observationId: wireObservation.id,
    encodedMask: maskFixture('blob'),
  });
  f.graph.associations.push({
    id: randomUUID(),
    objectId: wire.id,
    observationId: wireObservation.id,
    relation: 'whole',
    basis: 'category_and_overlap',
    status: 'proposed',
    attemptId: f.observation.attemptId,
  });
  f.graph.maskIdentityReviews = [
    {
      id: randomUUID(),
      objectId: wire.id,
      observationId: wireObservation.id,
      decision: 'accepted',
      source: 'human_review',
      reason: 'Synthetic identity review for fixture mask.',
      inputSnapshotId: f.job.scene!.snapshotRef!.snapshotId,
      inputSnapshotHash: f.job.scene!.snapshotRef!.snapshotHash,
      reviewedAt: 1,
    },
  ];
  const legacy = proposeAutomaticTargeting(
      f.graph,
      f.objectId,
      f.crop,
      f.native,
    ),
    legacyHash = canonicalHash(legacy),
    p = f.proposal();
  assert.equal(legacy.pointStatus, 'abstained');
  assert.equal(p.pointStatus, 'proposed');
  assert.equal(
    p.diagnostics.exclusions.find((e) => e.objectId === wire.id)!.mode,
    'native_mask_with_margin',
  );
  assert.equal(
    canonicalHash(
      proposeAutomaticTargeting(f.graph, f.objectId, f.crop, f.native),
    ),
    legacyHash,
  );
  assert.ok(p.pointCues[0]!.point[0] < 103);
  // Missing or superseded uncertain review restores conservative box exclusion.
  f.graph.maskIdentityReviews.push({
    ...f.graph.maskIdentityReviews[0]!,
    id: randomUUID(),
    decision: 'uncertain',
    reviewedAt: 2,
  });
  assert.equal(f.proposal().pointStatus, 'abstained');
  assert.ok(
    f.proposal().diagnostics.baseline[0]!.pixelRejections.uncertainNeighborBox >
      0,
  );
  f.graph.maskIdentityReviews.push({
    ...f.graph.maskIdentityReviews[0]!,
    id: randomUUID(),
    decision: 'accepted',
    reviewedAt: 3,
  });
  wireObservation.bbox = [...f.observation.bbox];
  const crossing = f.proposal();
  assert.equal(crossing.pointStatus, 'abstained');
  assert.ok(
    crossing.diagnostics.baseline[0]!.pixelRejections
      .conductorOrNeighborPixels > 0,
  );
});
test('v2 refuses contested connector/wire masks and reports unavailable native pixels', async (t) => {
  const f = await scene(t),
    wire = f.graph.objects.find((o) => o.category === 'conductor')!;
  f.graph.associations.push({
    id: randomUUID(),
    objectId: wire.id,
    observationId: f.observation.id,
    relation: 'unknown',
    basis: 'category_and_overlap',
    status: 'proposed',
    attemptId: f.observation.attemptId,
  });
  assert.equal(f.proposal().pointStatus, 'abstained');
  assert.ok(
    f
      .proposal()
      .diagnostics.baseline[0]!.reasons.includes(
        'competing_conductor_identity',
      ),
  );
  f.native.length = 0;
  assert.ok(
    f
      .proposal()
      .diagnostics.baseline[0]!.reasons.includes(
        'native_mask_unavailable_or_ambiguous',
      ),
  );
});
test('original-image body cues can be proposed without a baseline mask but remain unconfirmed; ambiguous or thin cores abstain', async (t) => {
  const f = await scene(t, false);
  f.rectangle(80, 40, 20, 20);
  const p = f.proposal();
  assert.equal(p.pointStatus, 'abstained');
  assert.equal(p.diagnostics.bodyProposal.status, 'proposed');
  assert.equal(
    p.diagnostics.bodyProposal.physicalBoundaryStatus,
    'unconfirmed',
  );
  assert.ok(p.variants.some((v) => v.name === 'C-body-aware-v2'));
  assert.equal(p.diagnostics.negativeCues.length, 0);
  f.rectangle(80, 65, 20, 20);
  assert.equal(
    f.proposal().diagnostics.bodyProposal.reason,
    'ambiguous_dark_body_components',
  );
  f.rgb.fill(255);
  f.rectangle(80, 40, 2, 35);
  assert.equal(f.proposal().diagnostics.bodyProposal.status, 'abstained');
  f.rgb.fill(20);
  assert.equal(f.proposal().diagnostics.bodyProposal.status, 'abstained');
});
test('conductor-negative points require unambiguous human-reviewed native pixels and cannot be inferred from wire color or boxes', async (t) => {
  const f = await scene(t, false);
  f.rectangle(80, 40, 20, 20);
  const wire = f.graph.objects.find((o) => o.category === 'conductor')!,
    wo = {
      ...f.observation,
      id: randomUUID(),
      bbox: [140, 70, 20, 20] as BoundingBox,
    };
  f.graph.observations.push(wo);
  f.native.push({ observationId: wo.id, encodedMask: maskFixture('blob') });
  f.graph.associations.push({
    id: randomUUID(),
    objectId: wire.id,
    observationId: wo.id,
    relation: 'whole',
    basis: 'category_and_overlap',
    status: 'proposed',
    attemptId: wo.attemptId,
  });
  assert.equal(f.proposal().diagnostics.negativeCues.length, 0);
  const review = {
    id: randomUUID(),
    objectId: wire.id,
    observationId: wo.id,
    decision: 'accepted' as const,
    source: 'human_review' as const,
    reason: 'Synthetic reviewed conductor pixels.',
    inputSnapshotId: f.job.scene!.snapshotRef!.snapshotId,
    inputSnapshotHash: f.job.scene!.snapshotRef!.snapshotHash,
    reviewedAt: 1,
  };
  f.graph.maskIdentityReviews = [review];
  const p = f.proposal();
  assert.equal(p.diagnostics.negativeCues.length, 1);
  assert.equal(p.diagnostics.negativeCues[0]!.reviewId, review.id);
  assert.ok(
    p.variants
      .find((v) => v.name === 'C-body-aware-v2')!
      .prompt.includes('-<|point'),
  );
});

async function threeArmFixture(t: {
  after: (f: () => void | Promise<void>) => void;
}) {
  const bytes = await sharp({
    create: { width: 200, height: 160, channels: 3, background: '#fff' },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="20" height="20"><rect width="20" height="20" fill="#111"/></svg>',
        ),
        left: 80,
        top: 40,
      },
    ])
    .jpeg()
    .toBuffer();
  const f = await syntheticConnectorFixture(':memory:', true, bytes),
    preview = await prepareAutomaticConnectorExperiment(
      f.store,
      f.job.analysisId,
      f.prepareBody.objectId,
      'v2',
    ),
    crop = preview.variants[0]!.crop,
    fake = syntheticConnectorClient(
      f.config,
      ['mask', 'mask', 'mask'],
      [80 - crop[0], 40 - crop[1]],
    ),
    service = new ConnectorWorkflowService(f.store, fake.client);
  t.after(async () => {
    await service.close();
    f.store.close();
  });
  const legacy = await service.prepare(f.job.analysisId, f.prepareBody),
    before = canonicalHash(
      service.evidence(legacy.workflowId, f.job.analysisId),
    );
  const w = await service.prepare(f.job.analysisId, {
    ...f.prepareBody,
    targetingVersion: 'v2',
  });
  assert.equal(w.contract.plan.variants.length, 3);
  return { ...f, fake, service, w, legacy, before };
}
test('v2 uses the shared bounded execution engine and explicit three-arm evaluator while preserving historical v1 evidence', async (t) => {
  const f = await threeArmFixture(t),
    report = await f.service.run(f.w.workflowId, workflowApproval(f.w));
  assert.equal(report.chargedRequests, 3);
  assert.ok(report.chargedPixels <= 6000000);
  assert.equal(f.fake.calls(), 3);
  assert.throws(
    () => evaluateConnectorPixels({ report, registeredReferenceHash: null }),
    /V2/,
  );
  const reviews = report.measurements.flatMap((m) =>
    (m.observations as Array<{ id: string }>).map((o) => ({
      observationId: o.id,
      decision: 'correct' as const,
      source: 'synthetic_fixture' as const,
      reviewedAt: Date.now(),
    })),
  );
  const result = f.service.evaluate(f.w.workflowId, reviews);
  assert.equal(result.plannedStrategyCount, 3);
  assert.equal(result.armResults.length, 3);
  assert.equal(result.protocolVersion, 'connector-comparison-protocol-v2');
  assert.equal(result.abComparison, 'complete');
  assert.equal(result.referenceQualification, 'synthetic');
  assert.equal(result.status, 'synthetic_pass');
  const validation = new ConnectorValidationService(f.store),
    draft = validation.draft(f.legacy.workflowId, f.job.analysisId),
    raster = decodeMaskToRaster(f.reference.connector.mask),
    runs: [number, number, number][] = [];
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 20;) {
      if (!raster[y * 20 + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < 20 && raster[y * 20 + x]) x++;
      runs.push([40 + y, 80 + start, 80 + x]);
    }
  const saved = validation.saveDraft(f.legacy.workflowId, f.job.analysisId, {
    revision: 0,
    content: {
      ...draft.content,
      annotationMethod: 'assistant_proposal',
      source: 'assistant_visual',
      predictionExposure: 'never_seen',
      originalImageOnly: true,
      regions: {
        connector: runs,
        redWire: [[80, 120, 130]],
        blackWire: [[100, 140, 150]],
        uncertain: [],
      },
    },
  });
  const referenceVersion = validation.freeze(
      f.legacy.workflowId,
      f.job.analysisId,
      saved.revision,
    ),
    retrospective = validation.evaluate(
      f.w.workflowId,
      f.job.analysisId,
      referenceVersion.referenceHash,
    );
  assert.equal(retrospective.strategy, 'C-body-aware-v2');
  assert.equal(retrospective.protocolHash, connectorProtocolV2.protocolHash);
  assert.equal(retrospective.metrics[0]!.iou, 1);
  assert.equal(retrospective.metrics[0]!.accepted, false);
  assert.equal(retrospective.independentGroundTruth, false);
  assert.equal(
    validation.evidence(f.w.workflowId, f.job.analysisId).pointAudit
      .targetingAlgorithmVersion,
    'automatic-targeting-v2',
  );
  assert.equal(retrospective.status, 'incomplete');
  assert.equal(
    validation.summary(f.job.analysisId).gates[0]!.status,
    'blocked',
  );
  assert.equal(
    canonicalHash(f.service.evidence(f.legacy.workflowId, f.job.analysisId)),
    f.before,
  );
  const pub = f.service
    .publicForAnalysis(f.job.analysisId)
    .find((w) => w.workflowId === f.w.workflowId)!;
  assert.equal(pub.arms.length, 3);
  assert.equal(
    pub.targetingDiagnostics!.version,
    'automatic-targeting-diagnostics-v2',
  );
  assert.equal(
    pub.evaluationProtocol!.protocolHash,
    connectorProtocolV2.protocolHash,
  );
  await assert.rejects(
    f.service.run(f.w.workflowId, workflowApproval(f.w)),
    /already admitted/i,
  );
  assert.equal(f.fake.calls(), 3);
  const reference = {
    ...f.reference,
    source: 'human_review' as const,
    independent: true,
  };
  const humanReviews = reviews.map((r) => ({
    ...r,
    source: 'human_review' as const,
  }));
  const unqualified = evaluateConnectorPixelsV2({
    report,
    reference,
    registeredReferenceHash: canonicalHash(reference),
    reviews: humanReviews,
    protocol: connectorProtocolV2,
  });
  assert.equal(unqualified.independentGroundTruth, false);
  assert.equal(unqualified.referenceQualification, 'provisional');
  assert.ok(unqualified.armResults.every((a) => a.acceptedMaskCount === 0));
  const nonblinded = {
    ...reference,
    provenance: {
      annotationMethod: 'manual_brush' as const,
      predictionExposure: 'seen_before' as const,
      originalImageOnly: true,
      independentAttestation: true,
      reviewer: 'Simulated reviewer',
    },
  };
  assert.equal(
    evaluateConnectorPixelsV2({
      report,
      reference: nonblinded,
      registeredReferenceHash: canonicalHash(nonblinded),
      reviews: humanReviews,
      protocol: connectorProtocolV2,
    }).independentGroundTruth,
    false,
  );
  const blinded = {
    ...nonblinded,
    provenance: {
      ...nonblinded.provenance,
      predictionExposure: 'never_seen' as const,
    },
  };
  assert.equal(
    evaluateConnectorPixelsV2({
      report,
      reference: blinded,
      registeredReferenceHash: canonicalHash(blinded),
      reviews: humanReviews,
      protocol: connectorProtocolV2,
    }).independentGroundTruth,
    true,
  );
  const provisional = {
    ...nonblinded,
    source: 'assistant_visual' as const,
    independent: false,
    provenance: {
      ...nonblinded.provenance,
      annotationMethod: 'assistant_proposal' as const,
      predictionExposure: 'never_seen' as const,
    },
  };
  const diagnostic = evaluateConnectorPixelsV2({
    report,
    reference: provisional,
    registeredReferenceHash: canonicalHash(provisional),
    reviews: humanReviews,
    protocol: connectorProtocolV2,
  });
  assert.equal(diagnostic.status, 'incomplete');
  assert.equal(diagnostic.armResults[0]!.maskMetrics[0]!.iou, 1);
  assert.equal(diagnostic.armResults[0]!.acceptedMaskCount, 0);
  const poorerBaseline = structuredClone(report);
  (
    poorerBaseline.measurements[0]!.native![0] as {
      encodedMask: ReturnType<typeof maskFixture>;
    }
  ).encodedMask = maskFixture('empty');
  assert.equal(
    evaluateConnectorPixelsV2({
      report: poorerBaseline,
      reference: f.reference,
      registeredReferenceHash: canonicalHash(f.reference),
      reviews,
      protocol: connectorProtocolV2,
    }).status,
    'synthetic_pass',
  );
  assert.throws(
    () =>
      evaluateConnectorPixelsV2({
        report,
        registeredReferenceHash: null,
        protocol: {
          ...connectorProtocolV2,
          requiredComparisons: ['C-body-aware-v2'],
        },
      }),
    /modified/,
  );
});
test('v2 preserves reference cost control before dispatch', async (t) => {
  const f = await threeArmFixture(t);
  // Spend the historical A/B workflow, then refuse v2 without a qualifying independent evaluation.
  await f.service.run(f.legacy.workflowId, workflowApproval(f.legacy));
  const calls = f.fake.calls();
  await assert.rejects(
    f.service.run(f.w.workflowId, workflowApproval(f.w)),
    /independent reference/,
  );
  assert.equal(f.fake.calls(), calls);
  assert.equal(f.service.get(f.w.workflowId).startingAt, null);
  const changed = structuredClone(f.w.contract.plan);
  changed.variants[0]!.prompt += ' altered';
  assert.notEqual(canonicalHash(changed), canonicalHash(f.w.contract.plan));
  const before = canonicalHash(f.service.get(f.legacy.workflowId));
  await prepareAutomaticConnectorExperiment(
    f.store,
    f.job.analysisId,
    f.w.contract.plan.objectId,
    'v2',
  );
  assert.equal(canonicalHash(f.service.get(f.legacy.workflowId)), before);
});
test('v2 rejects changed scene evidence before transport or request accounting', async (t) => {
  const f = await threeArmFixture(t),
    job = f.store.get(f.job.analysisId),
    graph = structuredClone(job.scene!.graph!);
  graph.objects.find((o) => o.id === f.prepareBody.objectId)!.bbox[0] += 1;
  checkpointScene(f.store, job, graph, [], randomUUID());
  f.store.save(job);
  await assert.rejects(
    f.service.run(f.w.workflowId, workflowApproval(f.w)),
    /evidence changed/i,
  );
  assert.equal(f.fake.calls(), 0);
  assert.equal(f.service.get(f.w.workflowId).experimentId, null);
  assert.equal(f.store.get(f.job.analysisId).scene!.budget.requests, 0);
});
test('v2 cannot spend a box-only repeat when both improved strategies abstain', async (t) => {
  const f = await syntheticConnectorFixture(':memory:', false),
    fake = syntheticConnectorClient(f.config),
    service = new ConnectorWorkflowService(f.store, fake.client);
  t.after(async () => {
    await service.close();
    f.store.close();
  });
  const w = await service.prepare(f.job.analysisId, {
    ...f.prepareBody,
    targetingVersion: 'v2',
  });
  assert.equal(w.contract.plan.variants.length, 1);
  await assert.rejects(
    service.run(w.workflowId, workflowApproval(w)),
    /no supported improved strategy/,
  );
  assert.equal(fake.calls(), 0);
  assert.equal(service.get(w.workflowId).startingAt, null);
});
