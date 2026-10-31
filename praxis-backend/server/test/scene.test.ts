import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildSceneGraph,
  discoverInventory,
  inventorySchema,
  planSceneTargets,
  segmentSceneTarget,
  type Inventory,
} from '../src/services/scene.js';
import { sceneGraphSchema } from '../src/schemas/scene.js';
import { prepareImage } from '../src/services/image.js';
import {
  JobStore,
  lastAttempt,
  newAttempt,
  publicJob,
} from '../src/jobs/store.js';
import { AnalysisWorker } from '../src/jobs/worker.js';
import {
  checkpointScene,
  getSceneSnapshot,
  sceneSnapshots,
} from '../src/jobs/scene-snapshots.js';
import { partialAnalysis } from '../src/services/partial-analysis.js';
import type { SamSnapshot } from '../src/services/vision.js';
import type { MetaClient } from '../src/lib/meta-client.js';
import type { SnapshotRef } from '../src/jobs/snapshots.js';
import { AppError } from '../src/lib/errors.js';
import Fastify from 'fastify';
import { registerAnalysisRoutes } from '../src/routes/analyses.js';
import {
  completion,
  imageBytes,
  maskFixture,
  queuedClient,
  samEnvelope,
  testConfig,
} from './helpers.js';

const imageHash = 'a'.repeat(64);
const inventory: Inventory = {
  objects: [
    {
      proposedType: '9V battery',
      category: 'power_source',
      box: [500, 100, 800, 700],
    },
    {
      proposedType: 'battery snap connector',
      category: 'connector',
      box: [400, 100, 500, 300],
    },
    {
      proposedType: 'red insulated external power lead',
      category: 'conductor',
      box: [200, 300, 450, 800],
    },
    {
      proposedType: 'unfamiliar blue enclosure with three metal tabs',
      category: 'unknown',
      box: [600, 700, 800, 950],
    },
  ],
};
function ref(): SnapshotRef {
  return {
    samSnapshotId: randomUUID(),
    samSnapshotHash: 'b'.repeat(64),
    imageHash,
    model: 'test-sam',
    processingVersion: 'sam-checkpoint-v1',
    sourceAttemptId: randomUUID(),
    createdAt: Date.now(),
    origin: 'recorded',
  };
}
async function until(predicate: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout)
      throw new Error('Scene job did not reach expected state');
    await delay(5);
  }
}
function record(width: number, height: number) {
  const mask = maskFixture();
  return samEnvelope(
    `<0f>0<|box;x1=0;y1=0;x2=19;y2=19;w=${width};h=${height};c=0.9|><|mask;x=0;y=0;c=0.9;data=${mask.height},${mask.width},${mask.payload}|>`,
  );
}
function fixtureStages() {
  return {
    async segment(image: SamSnapshot['image']): Promise<SamSnapshot> {
      return {
        image,
        candidates: [
          { id: 'resistor_1', type: 'resistor', bbox: [5, 5, 10, 10] },
        ],
      };
    },
    async interpret(snapshot: SamSnapshot) {
      return partialAnalysis(snapshot, testConfig());
    },
  };
}

test('inventory is open vocabulary, has no fabricated confidence or IDs, and maps resized inputs to original coordinates', async () => {
  const config = testConfig({ DYNAMIC_SCENE_ENABLED: 'true' });
  const image = await prepareImage(await imageBytes(2000, 1000), config);
  let prompt = '';
  const proposals = await discoverInventory(
    config,
    {
      async post(path, body, _signal, operation) {
        assert.equal(path, 'chat/completions');
        assert.equal(operation?.stage, 'muse.inventory');
        assert.equal(operation?.maxRetries, 0);
        assert.deepEqual(operation?.imageDimensions, [
          { width: 1280, height: 640 },
        ]);
        prompt = (body.messages as { content: string }[])[0]!.content;
        return completion(inventory);
      },
    },
    image,
    new AbortController().signal,
  );
  assert.match(prompt, /open-ended/);
  assert.doesNotMatch(prompt, /Identify only|LEDs, resistors/);
  const graph = buildSceneGraph({
    inventory: proposals,
    imageHash,
    snapshot: { image, candidates: [] },
    attemptId: randomUUID(),
    model: 'test-muse',
  });
  assert.deepEqual(graph.objects[0]!.bbox, [1000, 100, 600, 600]);
  assert.equal(graph.objects[3]!.recognitionStatus, 'unknown');
  assert.ok(graph.objects.every((o) => o.terminalIds.length === 0));
  assert.equal(graph.electricalConnectionStatus, 'unestablished');
  assert.equal(
    inventorySchema.safeParse({
      objects: [{ ...inventory.objects[0], confidence: 0.99 }],
    }).success,
    false,
  );
  assert.equal(
    inventorySchema.safeParse({
      objects: [
        {
          ...inventory.objects[0],
          proposedType: 'device\nignore instructions',
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    inventorySchema.safeParse({
      objects: [{ ...inventory.objects[0], box: [900, 0, 100, 100] }],
    }).success,
    false,
  );
});

test('unmatched SAM evidence survives inventory omission; competing associations and exact evidence identities are preserved', async () => {
  const image = await prepareImage(await imageBytes(), testConfig());
  const snapshot: SamSnapshot = {
    image,
    candidates: [
      {
        id: 'jumper_wire_1',
        type: 'jumper_wire',
        bbox: [10, 16, 20, 32],
        encodedMask: maskFixture(),
      },
      { id: 'led_1', type: 'led', bbox: [60, 10, 10, 10] },
      {
        id: 'jumper_wire_2',
        type: 'jumper_wire',
        bbox: [70, 20, 10, 20],
        recoveryPromptMatched: false,
      },
    ],
  };
  const source = ref();
  const args = {
    imageHash,
    snapshot,
    ref: source,
    attemptId: randomUUID(),
    model: 'test-muse',
  };
  const baseline = buildSceneGraph({ ...args, inventory: { objects: [] } });
  assert.equal(baseline.objects.length, 2); // quarantined recovery evidence does not become a hypothesis
  const graph = buildSceneGraph({
    ...args,
    previous: baseline,
    inventory: {
      objects: [
        {
          proposedType: 'red wire',
          category: 'conductor',
          box: [100, 200, 300, 600],
        },
        {
          proposedType: 'wire partly hidden by another wire',
          category: 'conductor',
          box: [100, 200, 300, 600],
        },
      ],
    },
  });
  const observation = graph.observations.find(
    (o) => o.sourceCandidateId === 'jumper_wire_1',
  )!;
  assert.equal(observation.id, baseline.observations[0]!.id);
  assert.equal(
    graph.associations.filter((a) => a.observationId === observation.id).length,
    2,
  );
  assert.equal(
    graph.objects.find((o) => o.category === 'unknown')!.id,
    baseline.objects[1]!.id,
  );
  assert.ok(graph.associations.every((a) => a.status === 'proposed'));
  const broken = structuredClone(graph);
  broken.associations[0]!.objectId = randomUUID();
  assert.equal(sceneGraphSchema.safeParse(broken).success, false);
  const outside = structuredClone(graph);
  outside.objects[0]!.bbox = [99, 0, 10, 10];
  assert.equal(sceneGraphSchema.safeParse(outside).success, false);
});

test('guided requests prioritize connectors and missing conductors, use crops, and retain generic mask candidates without changing identity', async () => {
  const config = testConfig();
  const image = await prepareImage(await imageBytes(1000, 800), config);
  const graph = buildSceneGraph({
    inventory,
    imageHash,
    snapshot: { image, candidates: [] },
    attemptId: randomUUID(),
    model: 'test',
  });
  const targets = planSceneTargets(graph, image, config.SCENE_MAX_CROP_PIXELS);
  assert.deepEqual(
    targets.map((t) => t.reason),
    [
      'missing_connector',
      'missing_conductor',
      'power_source',
      'unclassified_object',
    ],
  );
  assert.equal(planSceneTargets(graph, image, 1).length, 0);
  const target = targets[0]!;
  const result = await segmentSceneTarget(
    config,
    {
      async post(path, body, _signal, operation) {
        assert.equal(path, 'responses');
        assert.equal(operation?.maxRetries, 0);
        assert.equal(
          (body.input as { content: { text: string }[] }[])[0]!.content[0]!
            .text,
          'battery snap connector',
        );
        return record(target.crop[2], target.crop[3]);
      },
    },
    image,
    target,
    randomUUID(),
    new AbortController().signal,
  );
  assert.deepEqual(result.observations[0]!.bbox, [
    target.crop[0],
    target.crop[1],
    20,
    20,
  ]);
  assert.ok(result.native[0]!.encodedMask.payload.length);
  assert.equal('type' in result.observations[0]!, false);
  assert.equal(graph.objects[1]!.segmentationStatus, 'not_attempted'); // no in-place semantic upgrade
});

test('persisted scene stages preserve baseline results, bound inventory, cumulative budgets and offline native evidence', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-scene-'));
  const config = testConfig({
    DYNAMIC_SCENE_ENABLED: 'true',
    SCENE_MAX_GUIDED_REQUESTS: '1',
  });
  let store = new JobStore(config, directory);
  let release!: (value: unknown) => void;
  let guidedCalls = 0;
  const client: MetaClient = {
    async post(path, body) {
      if (path === 'chat/completions')
        return new Promise((resolve) => {
          release = resolve;
        });
      guidedCalls++;
      const data = (body.input as { content: { image_url: string }[] }[])[0]!
        .content[1]!.image_url;
      const metadata = await (
        await import('sharp')
      )
        .default(Buffer.from(data.split(',')[1]!, 'base64'))
        .metadata();
      return record(metadata.width!, metadata.height!);
    },
  };
  const bytes = await imageBytes(1000, 800),
    image = await prepareImage(bytes, config);
  const created = store.create(bytes, image);
  let worker = new AnalysisWorker(
    store,
    config,
    () => {},
    fixtureStages(),
    undefined,
    client,
  );
  t.after(async () => {
    await worker.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  worker.start();
  await until(() => !!release);
  const during = store.get(created.analysisId);
  assert.ok(publicJob(during).result);
  assert.equal(during.scene!.status, 'running');
  const original = JSON.stringify(during.candidateResult);
  const samRef = during.sam.snapshotRef!;
  assert.equal(
    lastAttempt(during, 'scene')!.samSnapshotId,
    samRef.samSnapshotId,
  );
  release(completion(inventory));
  await until(
    () => store.get(created.analysisId).scene!.status === 'succeeded',
  );
  const job = store.get(created.analysisId);
  assert.equal(guidedCalls, 1);
  assert.equal(job.scene!.budget.requests, 1);
  assert.equal(job.scene!.work[0]!.reason, 'missing_connector');
  assert.ok(job.scene!.budget.pixels <= config.SCENE_MAX_GUIDED_PIXELS);
  assert.equal(JSON.stringify(job.candidateResult), original);
  assert.equal(job.sam.snapshotRef!.samSnapshotId, samRef.samSnapshotId);
  assert.equal(
    job.scene!.graph!.objects.find((o) => o.category === 'connector')!
      .segmentationStatus,
    'candidates_returned',
  );
  assert.equal(
    job.scene!.graph!.objects.find((o) => o.category === 'power_source')!
      .segmentationStatus,
    'not_attempted',
  );
  const snapshots = sceneSnapshots(store, job.analysisId);
  const final = snapshots.at(-1)!;
  assert.equal(final.native.length, 1);
  assert.equal(JSON.stringify(publicJob(job)).includes('encodedMask'), false);
  assert.throws(
    () =>
      store.db
        .prepare('UPDATE scene_snapshots SET data=? WHERE id=?')
        .run('{}', final.ref.snapshotId),
    /immutable/,
  );
  const objectIds = job.scene!.graph!.objects.map((o) => o.id);
  const museFailure = store.get(job.analysisId);
  museFailure.muse.status = 'timed_out';
  Object.assign(lastAttempt(museFailure, 'muse')!, {
    status: 'timed_out',
    retryPolicy: 'manual_only',
    upstreamOutcome: 'unknown',
  });
  store.save(museFailure);
  store.retry(job.analysisId, 'muse');
  await until(() => store.get(job.analysisId).muse.status === 'succeeded');
  assert.equal(guidedCalls, 1); // interpretation retry never invokes either new model stage
  assert.equal(
    store.get(job.analysisId).scene!.snapshotRef!.snapshotId,
    final.ref.snapshotId,
  );
  await worker.close();
  store.close();
  store = new JobStore(config, directory);
  worker = new AnalysisWorker(
    store,
    config,
    () => {},
    fixtureStages(),
    undefined,
    client,
  );
  assert.deepEqual(
    store.get(job.analysisId).scene!.graph!.objects.map((o) => o.id),
    objectIds,
  );
  assert.equal(
    getSceneSnapshot(store, final.ref.snapshotId).ref.snapshotHash,
    final.ref.snapshotHash,
  );
});

test('an inventory timeout retains SAM hypotheses, retries only inventory, and cannot publish a late result', async (t) => {
  const config = testConfig({
    DYNAMIC_SCENE_ENABLED: 'true',
    SCENE_STAGE_TIMEOUT_MS: '40',
  });
  const store = new JobStore(config, ':memory:');
  const bytes = await imageBytes(),
    image = await prepareImage(bytes, config);
  const job = store.create(bytes, image);
  let calls = 0,
    release!: (value: unknown) => void;
  const client: MetaClient = {
    async post() {
      calls++;
      if (calls === 1)
        return new Promise((resolve) => {
          release = resolve;
        });
      return completion({ objects: [] });
    },
  };
  const worker = new AnalysisWorker(
    store,
    config,
    () => {},
    fixtureStages(),
    undefined,
    client,
  );
  t.after(async () => {
    await worker.close();
    store.close();
  });
  worker.start();
  await until(() => store.get(job.analysisId).scene!.status === 'timed_out');
  const failed = store.get(job.analysisId);
  assert.equal(failed.scene!.graph!.objects[0]!.category, 'unknown');
  assert.equal(lastAttempt(failed, 'scene')!.upstreamOutcome, 'unknown');
  assert.equal(
    lastAttempt(failed, 'scene')!.outputSnapshotId,
    failed.scene!.snapshotRef!.snapshotId,
  );
  assert.ok(publicJob(failed).result);
  const baseline = JSON.stringify(failed.candidateResult);
  store.retry(job.analysisId, 'scene');
  await until(() => store.get(job.analysisId).scene!.status === 'succeeded');
  const currentHash = store.get(job.analysisId).scene!.snapshotRef!
    .snapshotHash;
  release(completion(inventory));
  await delay(10);
  assert.equal(
    store.get(job.analysisId).scene!.snapshotRef!.snapshotHash,
    currentHash,
  );
  assert.equal(
    JSON.stringify(store.get(job.analysisId).candidateResult),
    baseline,
  );
  assert.equal(calls, 2);
  assert.equal(store.get(job.analysisId).sam.attempts.length, 1);
  assert.equal(store.get(job.analysisId).muse.attempts.length, 1);
});

test('guided timeout preserves its charge and stops later requests; restart never repeats unknown work', async (t) => {
  const config = testConfig({ DYNAMIC_SCENE_ENABLED: 'true' });
  const store = new JobStore(config, ':memory:');
  const bytes = await imageBytes(1000, 800),
    image = await prepareImage(bytes, config);
  const job = store.create(bytes, image);
  let samCalls = 0;
  const client: MetaClient = {
    async post(path) {
      if (path === 'chat/completions') return completion(inventory);
      samCalls++;
      throw new AppError(504, 'PROVIDER_TIMEOUT', 'Deadline');
    },
  };
  const worker = new AnalysisWorker(
    store,
    config,
    () => {},
    fixtureStages(),
    undefined,
    client,
  );
  t.after(async () => {
    await worker.close();
    store.close();
  });
  worker.start();
  await until(() => store.get(job.analysisId).scene!.status === 'timed_out');
  const saved = store.get(job.analysisId);
  assert.equal(samCalls, 1);
  assert.equal(saved.scene!.budget.requests, 1);
  assert.equal(saved.scene!.work[0]!.status, 'timed_out');
  assert.equal(saved.scene!.work[0]!.upstreamOutcome, 'unknown');
  assert.equal(
    saved.scene!.graph!.objects.find((o) => o.category === 'connector')!
      .segmentationStatus,
    'failed',
  );
  assert.throws(() => store.retry(job.analysisId, 'scene'), /not eligible/);
  store.recover();
  worker.tick();
  await delay(20);
  assert.equal(samCalls, 1);
});

test('legacy analyses have no new stages or inference and the feature is opt-in for new uploads', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  const bytes = await imageBytes(),
    image = await prepareImage(bytes, testConfig());
  const job = store.create(bytes, image);
  assert.equal(job.scene, undefined);
  assert.equal('scene' in publicJob(store.get(job.analysisId)), false);
  const original = createHash('sha256')
    .update(JSON.stringify(store.get(job.analysisId)))
    .digest('hex');
  store.get(job.analysisId);
  store.snapshots(job.analysisId);
  sceneSnapshots(store, job.analysisId);
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(store.get(job.analysisId)))
      .digest('hex'),
    original,
  );
});

test('provider completion validation rejects malformed inventory rather than trusting a partial response', async () => {
  const config = testConfig(),
    image = await prepareImage(await imageBytes(), config);
  const { client } = queuedClient([
    completion({
      objects: [
        { proposedType: 'relay', category: 'motor', box: [0, 0, 100, 100] },
      ],
    }),
  ]);
  await assert.rejects(
    discoverInventory(config, client, image, new AbortController().signal),
    /invalid/i,
  );
});

test('a real store restart interrupts a dispatched guided request without losing its charge, binding or unresolved object', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-scene-restart-'));
  const config = testConfig({ DYNAMIC_SCENE_ENABLED: 'true' });
  let store = new JobStore(config, directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const bytes = await imageBytes(1000, 800),
    image = await prepareImage(bytes, config);
  const job = store.create(bytes, image);
  job.sam.status = 'succeeded';
  lastAttempt(job, 'sam')!.status = 'succeeded';
  job.sam.result = partialAnalysis(job.sam.snapshot!, config);
  const graph = buildSceneGraph({
    inventory,
    imageHash: job.imageHash,
    snapshot: job.sam.snapshot!,
    attemptId: lastAttempt(job, 'scene')!.attemptId,
    model: config.META_REASONING_MODEL,
  });
  const input = checkpointScene(
    store,
    job,
    graph,
    [],
    lastAttempt(job, 'scene')!.attemptId,
  );
  job.scene!.attempts = [
    {
      ...newAttempt(),
      sceneOperation: 'guided',
      sceneSnapshotId: input.snapshotId,
      sceneSnapshotHash: input.snapshotHash,
    },
  ];
  store.save(job);
  const claim = store.claim('dead-scene-worker')!;
  assert.equal(claim.stage, 'scene');
  store.owned(
    job.analysisId,
    'dead-scene-worker',
    'scene',
    claim.attemptId,
    (j) => {
      j.scene!.budget = { requests: 1, pixels: 1600 };
      j.scene!.work.push({
        requestId: randomUUID(),
        attemptId: claim.attemptId,
        objectId: graph.objects[0]!.id,
        inputSnapshotId: input.snapshotId,
        inputSnapshotHash: input.snapshotHash,
        prompt: '9V battery',
        crop: [0, 0, 40, 40],
        reason: 'power_source',
        status: 'running',
        upstreamOutcome: 'unknown',
        startedAt: Date.now(),
      });
      j.leaseUntil = 0;
    },
  );
  store.close();
  store = new JobStore(config, directory);
  store.recover();
  const recovered = store.get(job.analysisId);
  assert.equal(recovered.scene!.status, 'interrupted');
  assert.equal(recovered.scene!.budget.requests, 1);
  assert.equal(recovered.scene!.work[0]!.upstreamOutcome, 'unknown');
  assert.equal(recovered.scene!.work[0]!.status, 'interrupted');
  assert.equal(
    recovered.scene!.graph!.objects[0]!.segmentationStatus,
    'unresolved',
  );
  assert.equal(recovered.scene!.attempts[0]!.sceneSnapshotId, input.snapshotId);
  assert.equal(store.claim('next-worker'), undefined);
  assert.equal(
    store.owned(
      job.analysisId,
      'dead-scene-worker',
      'scene',
      claim.attemptId,
      () => {},
    ),
    false,
  );
});

test('inventory can still discover objects after broad segmentation fails', async (t) => {
  const config = testConfig({
    DYNAMIC_SCENE_ENABLED: 'true',
    SCENE_MAX_GUIDED_REQUESTS: '0',
  });
  const store = new JobStore(config, ':memory:');
  const bytes = await imageBytes(1000, 800),
    image = await prepareImage(bytes, config);
  const job = store.create(bytes, image);
  const worker = new AnalysisWorker(
    store,
    config,
    () => {},
    {
      async segment() {
        throw new AppError(502, 'PROVIDER_ERROR', 'Failed');
      },
      async interpret(snapshot) {
        return partialAnalysis(snapshot, config);
      },
    },
    undefined,
    {
      async post() {
        return completion(inventory);
      },
    },
  );
  t.after(async () => {
    await worker.close();
    store.close();
  });
  worker.start();
  await until(() => store.get(job.analysisId).scene!.status === 'succeeded');
  const result = store.get(job.analysisId);
  assert.equal(result.sam.status, 'failed');
  assert.equal(result.scene!.graph!.objects.length, 4);
  assert.equal(result.scene!.graph!.objects[0]!.proposedType, '9V battery');
  assert.equal(result.scene!.budget.requests, 0);
});

test('explicit saved-photo discovery works when automatic discovery was disabled and preserves the baseline without new SAM calls', async (t) => {
  const config = testConfig({ DYNAMIC_SCENE_ENABLED: 'false' });
  const store = new JobStore(config, ':memory:');
  const bytes = await imageBytes(1000, 800),
    image = await prepareImage(bytes, config);
  const created = store.create(bytes, image);
  assert.throws(
    () => store.requestScene(created.analysisId),
    /active model work/,
  );
  let inventoryCalls = 0,
    samCalls = 0;
  const worker = new AnalysisWorker(
    store,
    config,
    () => {},
    fixtureStages(),
    undefined,
    {
      async post(path) {
        if (path === 'responses') {
          samCalls++;
          throw new Error('Discovery must not run SAM');
        }
        inventoryCalls++;
        return completion(inventory);
      },
    },
  );
  const app = Fastify();
  let kicks = 0;
  registerAnalysisRoutes(app, config, store, () => {
    kicks++;
    worker.tick();
  });
  t.after(async () => {
    await app.close();
    await worker.close();
    store.close();
  });
  worker.start();
  await until(() => store.get(created.analysisId).status === 'completed');
  const before = store.get(created.analysisId);
  const baseline = JSON.stringify({
    settings: before.settings,
    sam: before.sam,
    muse: before.muse,
    candidateResult: before.candidateResult,
    revision: before.revision,
    wireIdentities: before.wireIdentities,
  });
  const response = await app.inject({
    method: 'POST',
    url: `/api/analyses/${created.analysisId}/start-scene`,
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().scene.enabledBy, 'manual');
  assert.equal(response.json().scene.settings.maxRequests, 0);
  assert.equal(
    response.json().scene.attempts[0].samSnapshotId,
    before.sam.snapshotRef!.samSnapshotId,
  );
  await until(
    () => store.get(created.analysisId).scene?.status === 'succeeded',
  );
  const after = store.get(created.analysisId);
  assert.equal(
    JSON.stringify({
      settings: after.settings,
      sam: after.sam,
      muse: after.muse,
      candidateResult: after.candidateResult,
      revision: after.revision,
      wireIdentities: after.wireIdentities,
    }),
    baseline,
  );
  assert.equal(
    after.scene!.graph!.objects.find((o) => o.category === 'power_source')!
      .proposedType,
    '9V battery',
  );
  assert.equal(samCalls, 0);
  assert.equal(inventoryCalls, 1);
  assert.equal(kicks, 1);
  const duplicate = await app.inject({
    method: 'POST',
    url: `/api/analyses/${created.analysisId}/start-scene`,
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(inventoryCalls, 1);
});

test('explicit discovery freezes its own settings on a legacy analysis without rewriting its original settings', async (t) => {
  const config = testConfig();
  const store = new JobStore(config, ':memory:');
  t.after(() => store.close());
  const bytes = await imageBytes(),
    image = await prepareImage(bytes, config),
    job = store.create(bytes, image);
  job.sam.status = 'succeeded';
  lastAttempt(job, 'sam')!.status = 'succeeded';
  delete job.settings.dynamicScene;
  delete job.settings.sceneTimeoutMs;
  delete job.settings.sceneMaxRequests;
  delete job.settings.sceneMaxPixels;
  delete job.settings.sceneMaxCropPixels;
  store.save(job);
  const original = JSON.stringify(job.settings);
  const next = store.requestScene(job.analysisId);
  assert.equal(JSON.stringify(next.settings), original);
  assert.equal(next.scene!.settings!.timeoutMs, config.SCENE_STAGE_TIMEOUT_MS);
  assert.equal(next.scene!.settings!.maxRequests, 0);
  assert.equal(
    next.scene!.attempts[0]!.samSnapshotHash,
    next.sam.snapshotRef!.samSnapshotHash,
  );
});
