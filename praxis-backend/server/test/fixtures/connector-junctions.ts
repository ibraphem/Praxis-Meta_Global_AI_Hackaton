import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { decodeMaskToRaster } from '@meta-sam/parser';
import {
  syntheticConnectorFixture,
  syntheticConnectorClient,
  workflowApproval,
} from './connector-workflow.js';
import { checkpointScene } from '../../src/jobs/scene-snapshots.js';
import { prepareAutomaticConnectorExperiment } from '../../src/jobs/scene-connector-experiment.js';
import { ConnectorWorkflowService } from '../../src/jobs/connector-workflow.js';
import { ConnectorValidationService } from '../../src/jobs/connector-validation.js';
import { ConnectorJunctionService } from '../../src/jobs/connector-junctions.js';
import type { JunctionPlan } from '../../src/schemas/connector-junctions.js';
/** Isolated synthetic fixture with simulated human metadata for the prerequisite gate.
 * No real photograph, real reviewer, network inference or photographic accuracy claim. */
export async function acceptedJunctionFixture(t: {
  after: (fn: () => void | Promise<void>) => void;
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
      {
        input: Buffer.from(
          '<svg width="30" height="3"><rect width="30" height="3" fill="red"/></svg>',
        ),
        left: 100,
        top: 48,
      },
      {
        input: Buffer.from(
          '<svg width="20" height="3"><rect width="20" height="3" fill="#111"/></svg>',
        ),
        left: 60,
        top: 48,
      },
    ])
    .jpeg()
    .toBuffer();
  const f = await syntheticConnectorFixture(':memory:', true, bytes),
    red = f.graph.objects.find((o) => o.category === 'conductor')!;
  red.bbox = [100, 47, 30, 4];
  const black = {
    ...red,
    id: randomUUID(),
    proposedType: 'black insulated conductor',
    bbox: [60, 47, 20, 4] as [number, number, number, number],
  };
  f.graph.objects.push(black);
  const source = f.graph.associations.find(
      (a) => a.objectId === red.id && a.basis === 'inventory',
    )!,
    observation = {
      ...f.graph.observations.find((o) => o.id === source.observationId)!,
      id: randomUUID(),
      bbox: black.bbox,
    };
  f.graph.observations.push(observation);
  f.graph.associations.push({
    ...source,
    id: randomUUID(),
    objectId: black.id,
    observationId: observation.id,
  });
  checkpointScene(f.store, f.job, f.graph, [], randomUUID());
  f.store.save(f.job);
  const p = await prepareAutomaticConnectorExperiment(
      f.store,
      f.job.analysisId,
      f.prepareBody.objectId,
      'v2',
    ),
    crop = p.variants[0]!.crop,
    fake = syntheticConnectorClient(
      f.config,
      ['mask', 'mask', 'mask'],
      [80 - crop[0], 40 - crop[1]],
    ),
    workflows = new ConnectorWorkflowService(f.store, fake.client);
  t.after(async () => {
    await workflows.close();
    f.store.close();
  });
  const w = await workflows.prepare(f.job.analysisId, {
    ...f.prepareBody,
    snapshotId: f.job.scene!.snapshotRef!.snapshotId,
    snapshotHash: f.job.scene!.snapshotRef!.snapshotHash,
    targetingVersion: 'v2',
  });
  const report = await workflows.run(w.workflowId, workflowApproval(w));
  workflows.evaluate(
    w.workflowId,
    report.measurements.flatMap((m) =>
      (m.observations as Array<{ id: string }>).map((o) => ({
        observationId: o.id,
        decision: 'correct',
        source: 'human_review',
        reviewedAt: Date.now(),
      })),
    ),
  );
  const validation = new ConnectorValidationService(f.store),
    draft = validation.draft(w.workflowId, f.job.analysisId),
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
  const saved = validation.saveDraft(w.workflowId, f.job.analysisId, {
    revision: 0,
    content: {
      ...draft.content,
      reviewer: 'Simulated prerequisite reviewer',
      source: 'human_review',
      annotationMethod: 'manual_brush',
      predictionExposure: 'never_seen',
      originalImageOnly: true,
      independentAttestation: true,
      regions: {
        connector: runs,
        redWire: Array.from({ length: 10 }, (_, i) => [75 + i, 120, 130]),
        blackWire: Array.from({ length: 10 }, (_, i) => [95 + i, 60, 70]),
        uncertain: [],
      },
    },
  });
  const reference = validation.freeze(
      w.workflowId,
      f.job.analysisId,
      saved.revision,
    ),
    evaluation = validation.evaluate(
      w.workflowId,
      f.job.analysisId,
      reference.referenceHash,
    );
  if (evaluation.status !== 'passed')
    throw Error('Synthetic prerequisite C gate failed.');
  const service = new ConnectorJunctionService(f.store),
    prepareBody = {
      connectorObjectId: f.prepareBody.objectId,
      conductorObjectIds: [red.id, black.id] as [string, string],
      snapshotHash: f.job.scene!.snapshotRef!.snapshotHash,
      useMuse: true,
    };
  return { ...f, red, black, workflows, validation, service, prepareBody };
}
export const junctionApproval = (p: JunctionPlan) => ({
  planId: p.planId,
  authorizeInference: p.useMuse,
  providerBaseUrl: p.providerBaseUrl,
  museRequests: p.budget.museRequests,
  pixels: p.budget.inputPixels,
});
export function syntheticJunctionResponse(plan: JunctionPlan, hidden = false) {
  return {
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            junctions: plan.conductorObjectIds.map((id) => {
              const candidate = plan.candidates.find(
                  (c) => c.conductorObjectId === id,
                ),
                p = candidate
                  ? [
                      candidate.region[0] +
                        Math.floor(candidate.region[2] / 2) -
                        plan.crop[0],
                      candidate.region[1] +
                        Math.floor(candidate.region[3] / 2) -
                        plan.crop[1],
                    ]
                  : [0, 0];
              return {
                conductorObjectId: id,
                kind: hidden ? 'unknown' : 'housing_entry',
                visibility: hidden ? 'occluded' : 'visible',
                position: hidden ? null : p,
                contactVisibility: 'occluded',
                candidateIds: candidate ? [candidate.id] : [],
                confidence: hidden ? null : 0.7,
                visualEvidence: hidden
                  ? 'Synthetic housing obscures the conductor attachment; no contact position is supported.'
                  : 'Synthetic visible insulation/housing junction. The conductive contact remains hidden.',
              };
            }),
          }),
        },
      },
    ],
  };
}
