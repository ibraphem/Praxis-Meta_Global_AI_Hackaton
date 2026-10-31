import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { testConfig, imageBytes, completion } from './helpers.js';
import { prepareImage } from '../src/services/image.js';
import { buildSceneGraph } from '../src/services/scene.js';
import {
  reconcileSceneGraph,
  reconcileSceneView,
  preferredTerminalTargets,
} from '../src/services/scene-reconciliation.js';
import {
  discoverTerminals,
  terminalCrop,
} from '../src/services/scene-terminals.js';
import { sceneGraphSchema } from '../src/schemas/scene.js';
import {
  checkpointScene,
  getSceneSnapshot,
  sceneSnapshots,
} from '../src/jobs/scene-snapshots.js';
import { JobStore, newAttempt, lastAttempt } from '../src/jobs/store.js';
import { AnalysisWorker } from '../src/jobs/worker.js';
import { partialAnalysis } from '../src/services/partial-analysis.js';
import { AppError } from '../src/lib/errors.js';
import {
  scoreScene,
  type SceneTruth,
  type SceneReview,
} from '../src/services/scene-evaluation.js';

const hash = 'a'.repeat(64);
async function fixture() {
  const config = testConfig(),
    bytes = await imageBytes(400, 300),
    image = await prepareImage(bytes, config);
  const graph = buildSceneGraph({
    inventory: {
      objects: [
        {
          proposedType: 'red dome LED',
          category: 'electrical_component',
          box: [100, 400, 200, 500],
        },
        {
          proposedType: 'white LED holder housing',
          category: 'connector',
          box: [200, 400, 350, 500],
        },
        {
          proposedType: 'battery snap connector',
          category: 'connector',
          box: [700, 100, 850, 300],
        },
        {
          proposedType: 'red insulated conductor',
          category: 'conductor',
          box: [300, 400, 700, 550],
        },
        {
          proposedType: 'white insulated conductor',
          category: 'conductor',
          box: [300, 500, 700, 650],
        },
      ],
    },
    imageHash: hash,
    snapshot: { image, candidates: [] },
    attemptId: randomUUID(),
    model: 'test-muse',
  });
  return {
    config,
    bytes,
    image,
    graph,
    led: graph.objects[0]!.id,
    holder: graph.objects[1]!.id,
    snap: graph.objects[2]!.id,
    red: graph.objects[3]!.id,
    white: graph.objects[4]!.id,
  };
}
function response(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    terminals: [
      {
        key: 'A',
        physicalKind: 'contact',
        location: [500, 500],
        evidence: 'visible_terminal',
        pinLabel: null,
        electricalRole: null,
        roleMarking: null,
      },
      {
        key: 'B',
        physicalKind: 'lead',
        location: null,
        evidence: 'occluded',
        pinLabel: null,
        electricalRole: null,
        roleMarking: null,
      },
    ],
    attachments: [
      {
        terminalKey: 'A',
        conductorObjectId: f.red,
        evidence: 'visible_attachment',
        position: [500, 500],
      },
      {
        terminalKey: 'B',
        conductorObjectId: f.white,
        evidence: 'occluded_path',
        position: null,
      },
    ],
    relations: [
      {
        fromObjectId: f.led,
        toObjectId: f.holder,
        type: 'part_of',
        evidence: 'visible_part',
      },
    ],
  };
}
async function observe(f: Awaited<ReturnType<typeof fixture>>, data: unknown) {
  return discoverTerminals({
    ...f,
    objectId: f.holder,
    attemptId: randomUUID(),
    requestId: randomUUID(),
    client: {
      async post() {
        return completion(data);
      },
    },
    signal: new AbortController().signal,
  });
}

test('reconciled presentation links body-vs-assembly baseline evidence once while retaining all source objects', async () => {
  const f = await fixture();
  const before = JSON.stringify(f.graph);
  const baseline = [
    {
      id: 'led_1',
      type: 'led',
      bbox: [41, 122, 35, 25] as [number, number, number, number],
    },
    {
      id: 'jumper_wire_1',
      type: 'jumper_wire',
      bbox: [120, 120, 150, 40] as [number, number, number, number],
    },
  ];
  const view = reconcileSceneView(f.graph, baseline);
  assert.equal(
    view.objects.filter((o) => o.baselineIds.includes('led_1')).length,
    1,
  );
  assert.equal(view.objects.length, 5);
  assert.equal(JSON.stringify(f.graph), before);
  assert.ok(
    view.relations.some(
      (r) => r.type === 'part_of' && r.status === 'unresolved',
    ),
  );
  assert.equal(
    view.objects.find((o) => o.id === f.holder)!.sceneObjectIds.includes(f.led),
    false,
  );
  assert.deepEqual(preferredTerminalTargets(f.graph), [f.snap, f.holder]);
});

test('nearby different-color wires, identical overlapping wire boxes and part relationships never become verified object identities', async () => {
  const f = await fixture();
  const copy = structuredClone(f.graph.objects[3]!);
  copy.id = randomUUID();
  copy.proposedType = 'white insulated conductor';
  f.graph.objects.push(copy);
  const observation = structuredClone(f.graph.observations[3]!);
  observation.id = randomUUID();
  f.graph.observations.push(observation);
  f.graph.associations.push({
    ...f.graph.associations[3]!,
    id: randomUUID(),
    objectId: copy.id,
    observationId: observation.id,
  });
  const next = reconcileSceneGraph(f.graph);
  assert.equal(next.objects.length, f.graph.objects.length);
  assert.equal(next.observations.length, f.graph.observations.length);
  assert.equal(
    next.relations!.some(
      (r) =>
        r.type === 'same_object' &&
        [r.fromObjectId, r.toObjectId].includes(copy.id),
    ),
    false,
  );
  assert.equal(next.electricalConnectionStatus, 'unestablished');
});

test('terminal localization maps native crop coordinates, keeps hidden terminals null, and separates attachment and role claims', async () => {
  const f = await fixture(),
    out = await observe(f, response(f));
  const crop = terminalCrop(f.graph, f.holder);
  assert.deepEqual(out.terminals![0]!.location, [
    crop[0] + Math.round(crop[2] / 2),
    crop[1] + Math.round(crop[3] / 2),
  ]);
  assert.equal(out.terminals![1]!.location, null);
  assert.equal(out.terminals![1]!.locationStatus, 'unresolved');
  assert.equal(out.terminals![0]!.electricalRole, null);
  assert.equal(out.terminals![0]!.roleStatus, 'unresolved');
  assert.equal(out.terminals![0]!.promptVersion, 'physical-terminals-v1');
  assert.equal(out.attachments![0]!.status, 'proposed');
  assert.equal(out.attachments![1]!.status, 'unresolved');
  assert.ok(
    out.attachments!.every(
      (a) => a.electricalConnectionStatus === 'unestablished',
    ),
  );
  assert.equal(
    out.objects.find((o) => o.id === f.holder)!.terminalIds.length,
    2,
  );
  assert.equal(
    f.graph.objects.find((o) => o.id === f.holder)!.terminalIds.length,
    0,
  );
  assert.equal(out.version, 'scene-v2');
  assert.ok(sceneGraphSchema.safeParse(out).success);
});

test('fabricated roles, hidden coordinates, foreign conductors and unsupported claims fail closed', async () => {
  const f = await fixture();
  const cases = [
    (x: ReturnType<typeof response>) => {
      x.terminals[0]!.electricalRole = 'anode' as never;
    },
    (x: ReturnType<typeof response>) => {
      x.terminals[0]!.electricalRole = 'positive' as never;
      x.terminals[0]!.roleMarking = 'red wire' as never;
    },
    (x: ReturnType<typeof response>) => {
      x.terminals[1]!.location = [100, 100];
    },
    (x: ReturnType<typeof response>) => {
      x.attachments[0]!.conductorObjectId = randomUUID();
    },
    (x: ReturnType<typeof response>) => {
      x.attachments[0]!.terminalKey = 'B';
    },
    (x: ReturnType<typeof response>) => {
      Object.assign(x, { verified: true });
    },
    (x: ReturnType<typeof response>) => {
      x.terminals[1]!.key = 'A';
    },
  ];
  for (const mutate of cases) {
    const data = response(f);
    mutate(data);
    await assert.rejects(observe(f, data));
  }
  const marked = response(f);
  marked.terminals[0]!.electricalRole = 'positive' as never;
  marked.terminals[0]!.roleMarking = '+' as never;
  const out = await observe(f, marked);
  assert.equal(out.terminals![0]!.roleStatus, 'proposed');
});

test('proposed part cycles and invalid terminal backreferences are rejected', async () => {
  const f = await fixture(),
    graph = await observe(f, response(f));
  graph.relations!.push({
    ...graph.relations!.at(-1)!,
    id: randomUUID(),
    fromObjectId: f.holder,
    toObjectId: f.led,
  });
  assert.equal(sceneGraphSchema.safeParse(graph).success, false);
  graph.relations!.pop();
  graph.objects.find((o) => o.id === f.holder)!.terminalIds = [];
  assert.equal(sceneGraphSchema.safeParse(graph).success, false);
});

async function savedFixture() {
  const f = await fixture(),
    store = new JobStore(f.config, ':memory:');
  const job = store.create(f.bytes, f.image);
  job.sam.status = 'succeeded';
  lastAttempt(job, 'sam')!.status = 'succeeded';
  job.sam.result = partialAnalysis(job.sam.snapshot!, f.config);
  job.candidateResult = job.sam.result;
  job.scene = {
    status: 'succeeded',
    attempts: [
      { ...newAttempt(), status: 'succeeded', sceneOperation: 'inventory' },
    ],
    budget: { requests: 0, pixels: 0 },
    work: [],
  };
  f.graph.imageHash = job.imageHash;
  checkpointScene(store, job, f.graph, [], job.scene.attempts[0]!.attemptId);
  store.save(job);
  const current = store.get(job.analysisId),
    ref = current.scene!.snapshotRef!;
  return {
    ...f,
    store,
    job: current,
    binding: { snapshotId: ref.snapshotId, snapshotHash: ref.snapshotHash },
  };
}

test('local reconciliation is persisted idempotently without model calls, changing baseline data or overwriting immutable snapshots', async (t) => {
  const f = await savedFixture();
  t.after(() => f.store.close());
  const before = JSON.stringify({
    settings: f.job.settings,
    result: f.job.candidateResult,
    revision: f.job.revision,
  });
  const next = f.store.requestSceneUnderstanding(
    f.job.analysisId,
    'reconcile',
    f.binding,
  );
  const latest = f.store.get(next.analysisId);
  assert.equal(latest.scene!.graph!.version, 'scene-v2');
  assert.equal(lastAttempt(latest, 'scene')!.upstreamOutcome, 'not_sent');
  assert.equal(
    getSceneSnapshot(f.store, f.binding.snapshotId).graph.version,
    'scene-v1',
  );
  assert.equal(
    JSON.stringify({
      settings: latest.settings,
      result: latest.candidateResult,
      revision: latest.revision,
    }),
    before,
  );
  const count = sceneSnapshots(f.store, next.analysisId).length;
  f.store.requestSceneUnderstanding(next.analysisId, 'reconcile', {
    snapshotId: latest.scene!.snapshotRef!.snapshotId,
    snapshotHash: latest.scene!.snapshotRef!.snapshotHash,
  });
  assert.equal(sceneSnapshots(f.store, next.analysisId).length, count);
  assert.throws(
    () =>
      f.store.requestSceneUnderstanding(next.analysisId, 'terminals', {
        ...f.binding,
        objectIds: [f.snap],
      }),
    /Reload/,
  );
});

test('terminal worker retains completed evidence and charged work when a later request times out; no automatic retry or SAM call', async (t) => {
  const f = await savedFixture();
  let calls = 0;
  const baseline = JSON.stringify(f.job.candidateResult);
  f.store.requestSceneUnderstanding(f.job.analysisId, 'terminals', {
    ...f.binding,
    objectIds: [f.holder, f.snap],
  });
  const worker = new AnalysisWorker(
    f.store,
    f.config,
    () => {},
    undefined,
    undefined,
    {
      async post(path) {
        assert.equal(path, 'chat/completions');
        calls++;
        if (calls === 2)
          throw new AppError(504, 'PROVIDER_TIMEOUT', 'Deadline');
        return completion(response(f));
      },
    },
  );
  t.after(async () => {
    await worker.close();
    f.store.close();
  });
  worker.start();
  const end = Date.now() + 4000;
  while (f.store.get(f.job.analysisId).scene!.status !== 'timed_out') {
    if (Date.now() > end) throw new Error('Timeout waiting for terminal stage');
    await delay(5);
  }
  const saved = f.store.get(f.job.analysisId);
  assert.equal(calls, 2);
  assert.equal(saved.scene!.graph!.terminals!.length, 2);
  assert.equal(saved.scene!.budget.terminalRequests, 2);
  assert.equal(saved.scene!.budget.requests, 0);
  assert.equal(saved.scene!.terminalWork![1]!.upstreamOutcome, 'unknown');
  assert.equal(JSON.stringify(saved.candidateResult), baseline);
  assert.throws(() => f.store.retry(saved.analysisId, 'scene'), /not eligible/);
  assert.throws(
    () =>
      f.store.requestSceneUnderstanding(saved.analysisId, 'terminals', {
        snapshotId: saved.scene!.snapshotRef!.snapshotId,
        snapshotHash: saved.scene!.snapshotRef!.snapshotHash,
        objectIds: [f.snap],
      }),
    /budget/,
  );
  worker.tick();
  await delay(20);
  assert.equal(calls, 2);
});

test('offline scoring includes missing terminals, duplicate identities and independently supplied annotation provenance', async () => {
  const f = await fixture(),
    graph = await observe(f, response(f));
  const truth: SceneTruth = {
    version: 'scene-truth-v1',
    imageHash: hash,
    source: 'human_visual',
    inventoryComplete: true,
    attachmentsComplete: true,
    terminalTolerancePx: 3,
    objects: f.graph.objects.map((o) => ({ id: o.id, label: o.proposedType })),
    terminals: [
      {
        id: 'ta',
        objectId: f.holder,
        visible: true,
        position: graph.terminals![0]!.location!,
        electricalRole: null,
      },
      {
        id: 'tb',
        objectId: f.holder,
        visible: true,
        position: [140, 140],
        electricalRole: null,
      },
    ],
    attachments: [
      { terminalId: 'ta', conductorObjectId: f.red, visible: true },
    ],
  };
  const review: SceneReview = {
    version: 'scene-review-v1',
    imageHash: hash,
    sceneSnapshotHash: hash,
    source: 'human_visual',
    objectAssignments: graph.objects.map((o) => ({
      predictionId: o.id,
      truthObjectId: o.id,
    })),
    terminalAssignments: [
      { predictionId: graph.terminals![0]!.id, truthTerminalId: 'ta' },
      { predictionId: graph.terminals![1]!.id, truthTerminalId: 'tb' },
    ],
  };
  const score = scoreScene({ graph, snapshotHash: hash, truth, review });
  assert.equal(score.objectRecall, 1);
  assert.equal(score.terminals.accuracy, 0.5);
  assert.equal(score.terminals.unresolvedOrIncorrect, 1);
  assert.equal(score.attachments.correctVisibleProposals, 1);
  assert.equal(score.attachments.falseProposals, 0);
  assert.equal(score.electricalConnectionStatus, 'unestablished');
  assert.throws(
    () => scoreScene({ graph, snapshotHash: 'b'.repeat(64), truth, review }),
    /binding/,
  );
  const assistant = scoreScene({
    graph,
    snapshotHash: hash,
    truth: { ...truth, source: 'assistant_visual' },
    review,
  });
  assert.equal(assistant.accuracyClaimsEligible, false);
  const duplicated = structuredClone(graph.terminals![0]!);
  duplicated.id = randomUUID();
  graph.terminals!.push(duplicated);
  graph.objects.find((o) => o.id === f.holder)!.terminalIds.push(duplicated.id);
  review.terminalAssignments.push({
    predictionId: duplicated.id,
    truthTerminalId: 'ta',
  });
  assert.equal(
    scoreScene({ graph, snapshotHash: hash, truth, review }).terminals.accuracy,
    0,
  );
});

test('shutdown fences an ignored terminal response and retains the unknown charged request', async (t) => {
  const f = await savedFixture();
  f.store.requestSceneUnderstanding(f.job.analysisId, 'terminals', {
    ...f.binding,
    objectIds: [f.holder],
  });
  let release: ((value: unknown) => void) | undefined;
  const worker = new AnalysisWorker(
    f.store,
    f.config,
    () => {},
    undefined,
    undefined,
    {
      async post() {
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  );
  t.after(async () => {
    await worker.close();
    f.store.close();
  });
  worker.start();
  const end = Date.now() + 4000;
  while (!release) {
    if (Date.now() > end)
      throw new Error('Terminal request was not dispatched');
    await delay(5);
  }
  await worker.close();
  const interrupted = f.store.get(f.job.analysisId);
  assert.equal(interrupted.scene!.status, 'interrupted');
  assert.equal(interrupted.scene!.budget.terminalRequests, 1);
  assert.equal(interrupted.scene!.terminalWork![0]!.status, 'interrupted');
  assert.equal(interrupted.scene!.terminalWork![0]!.upstreamOutcome, 'unknown');
  const checkpoint = interrupted.scene!.snapshotRef!.snapshotHash;
  release(completion(response(f)));
  await delay(20);
  assert.equal(
    f.store.get(f.job.analysisId).scene!.snapshotRef!.snapshotHash,
    checkpoint,
  );
  assert.equal(
    f.store.get(f.job.analysisId).scene!.graph!.terminals?.length ?? 0,
    0,
  );
});
