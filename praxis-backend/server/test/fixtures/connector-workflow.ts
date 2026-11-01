import { randomUUID } from 'node:crypto';
import { JobStore, lastAttempt, newAttempt } from '../../src/jobs/store.js';
import { checkpointScene } from '../../src/jobs/scene-snapshots.js';
import { buildSceneGraph } from '../../src/services/scene.js';
import { prepareImage } from '../../src/services/image.js';
import { createMetaClient } from '../../src/lib/meta-client.js';
import {
  imageBytes,
  maskFixture,
  testConfig,
  samEnvelope,
} from '../helpers.js';
import { ConnectorWorkflowService } from '../../src/jobs/connector-workflow.js';
import type { ConnectorReference } from '../../src/services/connector-pixel-evaluation.js';

/** Protocol-only synthetic evidence. The fixture does not measure photographic recognition. */
export async function syntheticConnectorFixture(
  directory = ':memory:',
  baselinePoints = true,
  sourceBytes?: Buffer,
) {
  const config = testConfig(),
    store = new JobStore(config, directory),
    bytes = sourceBytes ?? (await imageBytes(200, 160)),
    image = await prepareImage(bytes, config),
    job = store.create(bytes, image);
  const mask = maskFixture('blob');
  job.sam.snapshot!.candidates = [
    {
      id: 'led_1',
      type: 'led',
      bbox: [80, 40, 20, 20],
      encodedMask: mask,
      localizationSource: 'sam',
    },
  ];
  job.sam.status = 'succeeded';
  lastAttempt(job, 'sam')!.status = 'succeeded';
  const ref = store.checkpointSnapshot(
    job,
    job.sam.snapshot!,
    lastAttempt(job, 'sam')!.attemptId,
  );
  const attempt = {
    ...newAttempt(),
    status: 'succeeded' as const,
    sceneOperation: 'inventory' as const,
  };
  const graph = buildSceneGraph({
    inventory: {
      objects: [
        {
          proposedType: 'black battery snap connector',
          category: 'connector',
          box: [350, 188, 550, 500],
        },
        {
          proposedType: 'red insulated conductor',
          category: 'conductor',
          box: [700, 313, 800, 750],
        },
      ],
    },
    imageHash: job.imageHash,
    snapshot: job.sam.snapshot!,
    ref,
    attemptId: attempt.attemptId,
    model: 'synthetic',
  });
  // Explicit synthetic association enables B to exercise the protocol. It is not a recognition claim.
  const target = graph.objects.find((o) => o.category === 'connector')!;
  const baseline = graph.observations.find((o) => o.source === 'sam')!;
  graph.objects = graph.objects.filter((o) => o.category !== 'unknown');
  graph.associations = graph.associations.filter((a) =>
    graph.objects.some((o) => o.id === a.objectId),
  );
  if (baselinePoints)
    graph.associations.push({
      id: randomUUID(),
      objectId: target.id,
      observationId: baseline.id,
      relation: 'unknown',
      basis: 'category_and_overlap',
      status: 'proposed',
      attemptId: attempt.attemptId,
    });
  job.scene = {
    status: 'succeeded',
    attempts: [attempt],
    budget: { requests: 0, pixels: 0 },
    work: [],
    settings: {
      timeoutMs: 45000,
      maxRequests: 0,
      maxPixels: 6000000,
      maxCropPixels: 2000000,
    },
  };
  checkpointScene(store, job, graph, [], attempt.attemptId);
  store.save(job);
  const reference: ConnectorReference = {
    version: 'connector-pixel-reference-v1',
    imageHash: job.imageHash,
    objectId: target.id,
    image: { width: 200, height: 160 },
    source: 'synthetic_fixture',
    independent: false,
    reviewId: randomUUID(),
    reviewedAt: 0,
    frozenAt: 0,
    connector: { bbox: [80, 40, 20, 20], mask },
    conductors: { bbox: [120, 80, 20, 20], mask: maskFixture('empty') },
    uncertainPixels: 'none',
  };
  const prepareBody = {
    objectId: target.id,
    snapshotId: job.scene.snapshotRef!.snapshotId,
    snapshotHash: job.scene.snapshotRef!.snapshotHash,
    reference,
  };
  return { config, store, job, graph, reference, prepareBody };
}
export function syntheticConnectorClient(
  config: ReturnType<typeof testConfig>,
  behavior: Array<'mask' | 'empty' | 'invalid' | 'disconnect' | 'http403'> = [
    'mask',
    'mask',
  ],
  fixedCropPosition?: [number, number],
) {
  let calls = 0;
  const client = createMetaClient(config, async (_u, init) => {
    const outcome = behavior[calls++];
    if (!outcome) throw new Error('Fake-provider budget exceeded');
    if (outcome === 'disconnect')
      throw new TypeError('Synthetic transport loss');
    if (outcome === 'http403')
      return Response.json({ denied: true }, { status: 403 });
    const body = JSON.parse(init!.body as string),
      jpeg = body.input[0].content[1].image_url.split(',')[1];
    const metadata = await (
      await import('sharp')
    )
      .default(Buffer.from(jpeg, 'base64'))
      .metadata();
    const text = body.input[0].content[0].text as string;
    const x1 = Number(text.match(/x1=(\d+)/)![1]),
      y1 = Number(text.match(/y1=(\d+)/)![1]);
    // The frozen object starts at 70,30; reference starts at 80,40.
    const x = fixedCropPosition?.[0] ?? x1 + 10,
      y = fixedCropPosition?.[1] ?? y1 + 10,
      mask = maskFixture('blob');
    return Response.json(
      samEnvelope(
        outcome === 'empty'
          ? ''
          : outcome === 'invalid'
            ? 'broken grammar'
            : `<0f>0<|box;x1=${x};y1=${y};x2=${x + 19};y2=${y + 19};w=${metadata.width};h=${metadata.height}|><|mask;x=0;y=0;data=${mask.height},${mask.width},${mask.payload}|>`,
      ),
    );
  });
  return { client, calls: () => calls };
}
export const workflowApproval = (
  workflow: Awaited<ReturnType<ConnectorWorkflowService['prepare']>>,
) => ({
  workflowId: workflow.workflowId,
  authorizeInference: true,
  providerBaseUrl: workflow.contract.plan.providerBaseUrl,
  requests: workflow.contract.plan.variants.length,
  pixels: workflow.contract.plan.totalPixels,
});
