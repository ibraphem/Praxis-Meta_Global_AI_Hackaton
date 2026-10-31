import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJobEvidence } from '../src/jobs/evidence.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  JobStore,
  newAttempt,
  lastAttempt,
  publicJob,
} from '../src/jobs/store.js';
import { checkpointScene } from '../src/jobs/scene-snapshots.js';
import { buildSceneGraph } from '../src/services/scene.js';
import {
  prepareConnectorExperiment,
  prepareAutomaticConnectorExperiment,
  runConnectorExperiment,
} from '../src/jobs/scene-connector-experiment.js';
import { sceneRequestEvidence } from '../src/jobs/scene-request-evidence.js';
import { createMetaClient } from '../src/lib/meta-client.js';
import { imageBytes, testConfig, samEnvelope, maskFixture } from './helpers.js';
import { prepareImage } from '../src/services/image.js';
import {
  boundaryProfileSchema,
  buildBoundaryVariants,
  evaluateBoundaryMask,
  type BoundaryProfile,
} from '../src/services/connector-boundary.js';
import { proposeAutomaticTargeting } from '../src/services/scene-automatic-targeting.js';
import { evaluateAutomaticTargetingReport } from '../src/services/automatic-targeting-evaluation.js';
import type { SceneObservation } from '../src/schemas/scene.js';
import { matchInventoryRediscoveries } from '../src/services/scene-identity.js';

async function fixture() {
  const config = testConfig(),
    store = new JobStore(config, ':memory:');
  const bytes = await imageBytes(400, 300),
    image = await prepareImage(bytes, config),
    job = store.create(bytes, image);
  job.sam.status = 'succeeded';
  lastAttempt(job, 'sam')!.status = 'succeeded';
  store.checkpointSnapshot(
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
          proposedType: 'black 9V battery snap connector',
          category: 'connector',
          box: [400, 100, 500, 300],
        },
        {
          proposedType: 'red wire',
          category: 'conductor',
          box: [100, 100, 200, 200],
        },
      ],
    },
    imageHash: job.imageHash,
    snapshot: job.sam.snapshot!,
    attemptId: attempt.attemptId,
    model: 'test',
  });
  job.scene = {
    status: 'succeeded',
    attempts: [attempt],
    budget: { requests: 3, pixels: 73483 },
    work: [],
    settings: {
      maxRequests: 3,
      maxPixels: 6000000,
      maxCropPixels: 2000000,
      timeoutMs: 45000,
    },
  };
  checkpointScene(store, job, graph, [], attempt.attemptId);
  store.save(job);
  const plan = await prepareConnectorExperiment(
    store,
    job.analysisId,
    graph.objects[0]!.id,
    [170, 50],
    [215, 60],
  );
  return { config, store, job, plan, graph };
}
test('connector experiment freezes three image-bound arms and captures empty/valid/invalid provider outputs without changing production', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const original = JSON.stringify(f.store.get(f.job.analysisId));
  assert.equal(f.plan.variants.length, 3);
  assert.equal(
    f.plan.variants[1]!.imageSha256,
    f.plan.variants[2]!.imageSha256,
  );
  assert.equal(f.plan.variants[0]!.prompt, 'battery connector');
  assert.match(f.plan.variants[2]!.prompt, /^<0f>0<\|box;/);
  assert.doesNotMatch(f.plan.variants[2]!.prompt, /battery/);
  let calls = 0;
  const client = createMetaClient(f.config, async (_url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string),
      content = body.input[0].content;
    assert.equal(content[0].text, f.plan.variants[calls - 1]!.prompt);
    const meta = await (
      await import('sharp')
    )
      .default(Buffer.from(content[1].image_url.split(',')[1], 'base64'))
      .metadata();
    const mask = maskFixture();
    return Response.json(
      samEnvelope(
        calls === 1
          ? ''
          : calls === 2
            ? `<0f>0<|box;x1=0;y1=0;x2=19;y2=19;w=${meta.width};h=${meta.height}|><|mask;x=0;y=0;data=${mask.height},${mask.width},${mask.payload}|>`
            : 'invalid grammar',
      ),
    );
  });
  const report = await runConnectorExperiment(f.store, f.plan, f.config, {
    client,
  });
  assert.equal(calls, 3);
  assert.equal(report.status, 'failed');
  assert.deepEqual(
    report.measurements.map((m) => m.status),
    ['empty_output', 'candidates_returned', 'failed'],
  );
  const records = sceneRequestEvidence(f.store, f.job.analysisId);
  assert.equal(records.length, 3);
  assert.equal(records[0]!.decoded!.outcome, 'empty_output');
  assert.equal(records[1]!.decoded!.candidateCount, 1);
  assert.equal(records[2]!.failurePhase, 'decoding');
  assert.ok(
    records.every((r) => r.request && r.response && r.cropImage.sha256),
  );
  assert.equal(JSON.stringify(records).includes('test-provider-key'), false);
  assert.equal(JSON.stringify(f.store.get(f.job.analysisId)), original);
  assert.equal(
    JSON.stringify(publicJob(f.store.get(f.job.analysisId))).includes('base64'),
    false,
  );
});
test('tampered experiment plans and active scene work are blocked before dispatch', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const changed = structuredClone(f.plan);
  changed.variants[0]!.prompt = 'different object';
  await assert.rejects(
    runConnectorExperiment(f.store, changed, f.config),
    /plan was modified/,
  );
  assert.equal(f.store.experiments.forAnalysis(f.job.analysisId).length, 0);
  const job = f.store.get(f.job.analysisId);
  job.scene!.status = 'queued';
  f.store.save(job);
  await assert.rejects(
    runConnectorExperiment(f.store, f.plan, f.config),
    /inactive combined/,
  );
  assert.equal(sceneRequestEvidence(f.store, f.job.analysisId).length, 0);
});
test('unknown upstream outcome stops later variants and retains the experiment reservation', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const controller = new AbortController();
  let calls = 0;
  const client = createMetaClient(f.config, async (_u, init) => {
    calls++;
    setTimeout(() => controller.abort(new Error('test interruption')), 10);
    return new Promise((_resolve, reject) =>
      init!.signal!.addEventListener(
        'abort',
        () => reject(init!.signal!.reason),
        { once: true },
      ),
    );
  });
  const report = await runConnectorExperiment(f.store, f.plan, f.config, {
    client,
    signal: controller.signal,
  });
  assert.equal(calls, 1);
  assert.equal(report.status, 'interrupted');
  assert.equal(report.measurements[0]!.upstreamOutcome, 'unknown');
  assert.equal(f.store.experiments.active()!.status, 'interrupted');
  assert.equal(f.store.get(f.job.analysisId).scene!.budget.requests, 3);
  await delay(5);
});
test('transport diagnostics preserve error/non-JSON response bytes before validation and never retry', async () => {
  for (const [status, type, body] of [
    [403, 'application/json', '{"denied":true}'],
    [200, 'text/plain', 'not JSON'],
    [200, 'application/json', '{"broken"'],
  ] as const) {
    const f = await fixture();
    let calls = 0;
    try {
      const client = createMetaClient(f.config, async () => {
        calls++;
        return new Response(body, {
          status,
          headers: { 'content-type': type },
        });
      });
      const report = await runConnectorExperiment(f.store, f.plan, f.config, {
        client,
      });
      assert.equal(calls, 1);
      assert.equal(report.status, 'failed');
      assert.equal(
        f.store.experiments.get(report.experimentId).status,
        'failed',
      );
      assert.equal(report.measurements[0]!.status, 'failed');
      const record = sceneRequestEvidence(f.store, f.job.analysisId)[0]!;
      assert.equal(
        Buffer.from(record.response!.base64, 'base64').toString(),
        body,
      );
      assert.equal(record.response!.upstreamStatus, status);
    } finally {
      f.store.close();
    }
  }
});
test('identity replay recognizes connector aliases without merging changed wire descriptions or ambiguous duplicates', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const connector = f.graph.objects[0]!,
    wire = f.graph.objects[1]!;
  const proposals = [
    { ...connector, proposedType: 'black 9V battery snap clip' },
    { ...wire, proposedType: 'red insulated wire' },
  ];
  const decisions = matchInventoryRediscoveries(f.graph, proposals);
  assert.equal(decisions[0]!.matchedObjectId, connector.id);
  assert.equal(decisions[1]!.matchedObjectId, null);
  const duplicate = { ...structuredClone(connector), id: randomUUID() };
  f.graph.objects.push(duplicate);
  f.graph.associations.push({
    ...f.graph.associations[0]!,
    id: randomUUID(),
    objectId: duplicate.id,
  });
  assert.equal(
    matchInventoryRediscoveries(f.graph, [proposals[0]!])[0]!.status,
    'ambiguous',
  );
});

test('private diagnostic archives preserve crop and HTTP bytes and survive source deletion', async (t) => {
  const f = await fixture(),
    root = mkdtempSync(join(tmpdir(), 'praxis-connector-archive-'));
  t.after(() => {
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const body = JSON.stringify(samEnvelope(''));
  await runConnectorExperiment(f.store, f.plan, f.config, {
    client: createMetaClient(
      f.config,
      async () =>
        new Response(body, { headers: { 'content-type': 'application/json' } }),
    ),
  });
  const records = sceneRequestEvidence(f.store, f.job.analysisId),
    output = join(root, 'archive');
  const manifest = exportJobEvidence(f.store, f.job.analysisId, output);
  assert.ok(
    manifest.files.some((f) => f.path === 'scene-requests/1-response.bin'),
  );
  assert.equal(
    readFileSync(join(output, 'scene-requests/1-response.bin'), 'utf8'),
    body,
  );
  assert.deepEqual(
    readFileSync(join(output, 'scene-requests/1-crop.jpg')),
    Buffer.from(records[0]!.cropImage.base64, 'base64'),
  );
  assert.equal(
    readFileSync(join(output, 'scene-requests/1-request.json'), 'utf8'),
    records[0]!.request!.payload,
  );
  f.store.remove(f.job.analysisId);
  assert.equal(sceneRequestEvidence(f.store, f.job.analysisId).length, 0);
  assert.equal(
    readFileSync(join(output, 'scene-requests/1-response.bin'), 'utf8'),
    body,
  );
});

test('candidate rejection retains all decoded candidates and distinguishes a quota failure from empty output', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  let calls = 0;
  const client = createMetaClient(f.config, async (_url, init) => {
    calls++;
    const payload = JSON.parse(init!.body as string),
      data = payload.input[0].content[1].image_url.split(',')[1];
    const meta = await (
        await import('sharp')
      )
        .default(Buffer.from(data, 'base64'))
        .metadata(),
      mask = maskFixture();
    return Response.json(
      samEnvelope(
        '<0f>' +
          Array.from(
            { length: 33 },
            (_, i) =>
              `${i}<|box;x1=0;y1=0;x2=19;y2=19;w=${meta.width};h=${meta.height}|><|mask;x=0;y=0;data=${mask.height},${mask.width},${mask.payload}|>`,
          ).join(','),
      ),
    );
  });
  const report = await runConnectorExperiment(f.store, f.plan, f.config, {
    client,
  });
  assert.equal(calls, 1);
  assert.equal(report.measurements[0]!.status, 'failed');
  const record = sceneRequestEvidence(f.store, f.job.analysisId)[0]!;
  assert.equal(record.decoded!.candidateCount, 33);
  assert.equal(record.decoded!.outcome, 'candidate_limit_rejected');
  assert.equal(record.failurePhase, 'quota');
  assert.ok(record.response!.bytes > 0);
});

function boundaryProfile(
  f: Awaited<ReturnType<typeof fixture>>,
): BoundaryProfile {
  return boundaryProfileSchema.parse({
    version: 'connector-boundary-profile-v1',
    imageHash: f.job.imageHash,
    source: 'assistant_visual',
    frozenAt: Date.now(),
    independentGroundTruth: false,
    bodyDefinition:
      'Visible connector body, excluding the separately identifiable insulated lead.',
    assemblyDefinition:
      'Experimental union of the connector and red lead, never a production identity merge.',
    bodyBox: [158, 25, 50, 70],
    assemblyBox: [158, 25, 70, 90],
    positivePoints: [
      [170, 50],
      [180, 60],
    ],
    leadPoint: [215, 100],
    exclusion: {
      battery: [225, 20],
      background: [130, 110],
      otherConductor: [225, 110],
    },
    redConductorObjectId: f.graph.objects[1]!.id,
    probes: [
      { id: 'body', region: 'body', position: [170, 40] },
      { id: 'red', region: 'red_lead', position: [165, 35] },
      { id: 'black', region: 'black_lead', position: [161, 31] },
      { id: 'battery', region: 'battery', position: [179, 49] },
      { id: 'background', region: 'background', position: [162, 48] },
    ],
    annotationLimitations:
      'Synthetic transport/evaluation probes, not physical image accuracy or independent truth.',
  });
}
test('boundary scopes freeze distinct prompts on identical JPEG pixels without exposing evaluation probes to SAM', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const profile = boundaryProfile(f);
  const plan = await prepareConnectorExperiment(
    f.store,
    f.job.analysisId,
    f.plan.objectId,
    profile.positivePoints[0],
    profile.exclusion.battery,
    { profile },
  );
  assert.equal(plan.version, 'connector-boundary-plan-v1');
  assert.equal(new Set(plan.variants.map((v) => v.imageSha256)).size, 1);
  assert.deepEqual(
    plan.variants.map((v) => v.scope),
    ['connector_only', 'connector_only', 'connector_plus_red_lead'],
  );
  assert.equal((plan.variants[0]!.prompt.match(/-<\|point/g) ?? []).length, 3);
  assert.equal((plan.variants[1]!.prompt.match(/<\|point/g) ?? []).length, 5);
  assert.equal((plan.variants[2]!.prompt.match(/<\|point/g) ?? []).length, 6);
  const original = JSON.stringify(f.store.get(f.job.analysisId));
  let calls = 0;
  const report = await runConnectorExperiment(f.store, plan, f.config, {
    client: createMetaClient(f.config, async (_url, init) => {
      calls++;
      const body = JSON.parse(init!.body as string);
      assert.equal('profile' in body, false);
      assert.equal('probes' in body, false);
      assert.equal(
        body.input[0].content[0].text,
        plan.variants[calls - 1]!.prompt,
      );
      return Response.json(samEnvelope(''));
    }),
  });
  assert.equal(calls, 3);
  assert.deepEqual(
    report.measurements.map((m) => m.scope),
    plan.variants.map((v) => v.scope),
  );
  assert.equal(JSON.stringify(f.store.get(f.job.analysisId)), original);
});
test('boundary plans reject reused prompt/evaluation points, foreign images and invalid crop coordinates before dispatch', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const profile = boundaryProfile(f);
  const tainted = structuredClone(profile);
  tainted.probes[0]!.position = profile.positivePoints[0];
  assert.equal(boundaryProfileSchema.safeParse(tainted).success, false);
  const foreign = structuredClone(profile);
  foreign.imageHash = 'f'.repeat(64);
  await assert.rejects(
    prepareConnectorExperiment(
      f.store,
      f.job.analysisId,
      f.plan.objectId,
      profile.positivePoints[0],
      profile.exclusion.battery,
      { profile: foreign },
    ),
    /annotation and conductor/,
  );
  const outside = structuredClone(profile);
  outside.probes[0]!.position = [399, 299];
  assert.throws(
    () => buildBoundaryVariants(outside, [121, 0, 118, 129]),
    /inside the common/,
  );
  assert.equal(sceneRequestEvidence(f.store, f.job.analysisId).length, 0);
});
test('native raster evaluation distinguishes different masks with the same bbox and never accepts an identity', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const profile = boundaryProfile(f),
    observationId = randomUUID();
  const wire = maskFixture('wire'),
    blob = maskFixture('blob');
  const obs: SceneObservation = {
    id: observationId,
    kind: 'mask',
    source: 'sam',
    attemptId: randomUUID(),
    model: 'synthetic',
    bbox: [160, 30, wire.width, wire.height],
  };
  const native = {
    observationId,
    crop: [121, 0, 118, 129] as [number, number, number, number],
    encodedMask: wire,
  };
  const first = evaluateBoundaryMask(obs, native, profile),
    second = evaluateBoundaryMask(
      { ...obs, bbox: [160, 30, blob.width, blob.height] },
      { ...native, encodedMask: blob },
      profile,
    );
  assert.notEqual(first.areaPixels, second.areaPixels);
  assert.notDeepEqual(
    first.probes.map((p) => p.masked),
    second.probes.map((p) => p.masked),
  );
  assert.equal(first.automaticAcceptance, false);
  assert.equal(first.independentGroundTruth, false);
  assert.throws(
    () =>
      evaluateBoundaryMask(
        obs,
        { ...native, observationId: randomUUID() },
        profile,
      ),
    /binding mismatch/,
  );
  assert.throws(
    () =>
      evaluateBoundaryMask(
        { ...obs, bbox: [160, 30, wire.width + 1, wire.height] },
        native,
        profile,
      ),
    /one-to-one/,
  );
});

test('definitive pre-dispatch errors finalize once with the failed measurement and free admission', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const record = f.store.experiments.record.bind(f.store.experiments);
  let finalWrites = 0;
  f.store.experiments.record = (id, owner, report, status) => {
    if (status !== 'running') {
      finalWrites++;
      const value = report as {
        finishedAt: number;
        measurements: Array<{ finishedAt: number; status: string }>;
      };
      assert.ok(value.finishedAt);
      assert.ok(value.measurements[0]!.finishedAt);
      assert.equal(value.measurements[0]!.status, 'failed');
    }
    return record(id, owner, report, status);
  };
  const report = await runConnectorExperiment(f.store, f.plan, f.config, {
    client: {
      async post() {
        throw new Error('local serialization failure');
      },
    },
  });
  assert.equal(finalWrites, 1);
  assert.equal(report.status, 'failed');
  assert.equal(report.measurements[0]!.upstreamOutcome, 'not_sent');
  assert.equal(f.store.experiments.active(), undefined);
  assert.deepEqual(
    f.store.experiments.get(report.experimentId).report,
    JSON.parse(JSON.stringify(report)),
  );
});

test('three valid empty outputs complete successfully while cancellation before dispatch is interrupted', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const success = await runConnectorExperiment(f.store, f.plan, f.config, {
    client: createMetaClient(f.config, async () =>
      Response.json(samEnvelope('')),
    ),
  });
  assert.equal(success.status, 'completed');
  assert.equal(success.measurements.length, 3);
  const signal = AbortSignal.abort(new Error('stop before dispatch'));
  await assert.rejects(
    runConnectorExperiment(f.store, f.plan, f.config, { signal }),
    /stop before dispatch/,
  );
  const interrupted = f.store.experiments.active()!;
  assert.equal(interrupted.status, 'interrupted');
  assert.equal((interrupted.report as typeof success).chargedRequests, 0);
});

test('lost finalization acknowledgement leaves the committed interrupted state and charged evidence durable', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const record = f.store.experiments.record.bind(f.store.experiments);
  f.store.experiments.record = (id, owner, report, status) => {
    const result = record(id, owner, report, status);
    if (status === 'interrupted' && result)
      throw new Error('simulated termination after commit');
    return result;
  };
  await assert.rejects(
    runConnectorExperiment(f.store, f.plan, f.config, {
      client: {
        async post(_path, body, _signal, operation) {
          operation!.evidence!.request(JSON.stringify(body));
          throw new Error('connection disappeared');
        },
      },
    }),
  );
  const saved = f.store.experiments.active()!;
  assert.equal(saved.status, 'interrupted');
  const report = saved.report as Awaited<
    ReturnType<typeof runConnectorExperiment>
  >;
  assert.equal(report.status, 'interrupted');
  assert.equal(report.chargedRequests, 1);
  assert.equal(report.measurements[0]!.status, 'interrupted');
  assert.ok(report.finishedAt);
  assert.ok(
    sceneRequestEvidence(f.store, f.job.analysisId)[0]!.dispatchStartedAt,
  );
});

test('lease recovery retains unfinished charged work and blocks replay after process loss', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const record = f.store.experiments.record.bind(f.store.experiments);
  f.store.experiments.record = (id, owner, report, status) => {
    const result = record(id, owner, report, status);
    if ((report as { chargedRequests: number }).chargedRequests === 1) {
      f.store.db
        .prepare('UPDATE experiments SET lease_until=0 WHERE id=?')
        .run(id);
      throw new Error('process lost after admission');
    }
    return result;
  };
  await assert.rejects(
    runConnectorExperiment(f.store, f.plan, f.config, {
      client: {
        async post() {
          assert.fail('must not dispatch');
        },
      },
    }),
  );
  f.store.experiments.recover();
  const saved = f.store.experiments.active()!;
  assert.equal(saved.status, 'interrupted');
  assert.equal(
    (saved.report as { chargedRequests: number }).chargedRequests,
    1,
  );
  assert.throws(
    () => f.store.experiments.reserve(f.job.analysisId),
    /Interrupted reservations/,
  );
});

test('repeated ambiguous rediscoveries retain a stable cluster, evidence and snapshot-bound human reviews without merging', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const inventory = {
    objects: Array.from({ length: 2 }, () => ({
      proposedType: 'black 9V battery snap clip',
      category: 'connector' as const,
      box: [400, 100, 500, 300] as [number, number, number, number],
    })),
  };
  const refresh = (previous: typeof f.graph) =>
    buildSceneGraph({
      inventory,
      previous,
      snapshot: f.job.sam.snapshot!,
      imageHash: f.job.imageHash,
      attemptId: randomUUID(),
      model: 'test',
    });
  const next = refresh(f.graph);
  assert.equal(next.ambiguityClusters!.length, 1);
  const cluster = next.ambiguityClusters![0]!;
  assert.equal(cluster.memberObjectIds.length, 3);
  assert.equal(cluster.evidence.length, 2);
  const checkpoint = checkpointScene(f.store, f.job, next, [], randomUUID());
  f.store.save(f.job);
  const body = {
    snapshotId: checkpoint.snapshotId,
    snapshotHash: checkpoint.snapshotHash,
    ambiguityReview: {
      clusterId: cluster.id,
      memberObjectIds: cluster.memberObjectIds,
      decision: 'same_object',
    },
  };
  assert.throws(
    () =>
      f.store.requestSceneUnderstanding(f.job.analysisId, 'reconcile', {
        ...body,
        ambiguityReview: {
          ...body.ambiguityReview,
          memberObjectIds: cluster.memberObjectIds.slice(1),
        },
      }),
    /complete current cluster/,
  );
  const reviewed = f.store.requestSceneUnderstanding(
    f.job.analysisId,
    'reconcile',
    body,
  );
  assert.equal(reviewed.scene!.graph!.objects.length, next.objects.length);
  assert.deepEqual(reviewed.scene!.graph!.terminals, next.terminals);
  assert.equal(
    reviewed.scene!.graph!.ambiguityReviews![0]!.inputSnapshotHash,
    checkpoint.snapshotHash,
  );
  assert.throws(
    () =>
      f.store.requestSceneUnderstanding(f.job.analysisId, 'reconcile', body),
    /Reload/,
  );
  const again = refresh(reviewed.scene!.graph!);
  assert.equal(again.ambiguityClusters!.length, 1);
  assert.equal(again.ambiguityClusters![0]!.id, cluster.id);
  assert.equal(again.ambiguityClusters![0]!.memberObjectIds.length, 5);
  assert.deepEqual(
    again.ambiguityReviews,
    reviewed.scene!.graph!.ambiguityReviews,
  );
  for (const obs of next.observations)
    assert.deepEqual(
      again.observations.find((o) => o.id === obs.id),
      obs,
    );
});

test('automatic targeting prepares without manual annotations and abstains from unsupported points', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const before = JSON.stringify(f.store.get(f.job.analysisId));
  const plan = await prepareAutomaticConnectorExperiment(
    f.store,
    f.job.analysisId,
    f.plan.objectId,
  );
  assert.equal(plan.version, 'connector-automatic-plan-v1');
  assert.equal(plan.profile, undefined);
  assert.equal(plan.spatialSeed.point, null);
  assert.equal(plan.spatialSeed.negative, null);
  assert.equal(plan.automaticTargeting!.pointStatus, 'abstained');
  assert.equal(plan.variants.length, 1);
  assert.doesNotMatch(plan.variants[0]!.prompt, /point/);
  const profile = boundaryProfile(f);
  let calls = 0;
  const report = await runConnectorExperiment(f.store, plan, f.config, {
    client: createMetaClient(f.config, async (_u, init) => {
      calls++;
      assert.equal(
        JSON.stringify(JSON.parse(init!.body as string)).includes('probes'),
        false,
      );
      return Response.json(samEnvelope(''));
    }),
  });
  assert.equal(report.status, 'completed');
  assert.equal(calls, 1);
  assert.equal(report.chargedRequests, 1);
  const scored = evaluateAutomaticTargetingReport(report, profile);
  assert.equal(scored.measurements[0]!.masks.length, 0);
  assert.equal(scored.automaticAcceptance, false);
  assert.equal(scored.targeting.pointStatus, 'abstained');
  assert.throws(
    () =>
      evaluateAutomaticTargetingReport(report, {
        ...profile,
        frozenAt: report.startedAt + 1,
      }),
    /frozen before/,
  );
  assert.throws(
    () =>
      evaluateAutomaticTargetingReport(report, {
        ...profile,
        imageHash: 'f'.repeat(64),
      }),
    /bound plan/,
  );
  assert.equal(JSON.stringify(f.store.get(f.job.analysisId)), before);
});

test('automatic points use baseline foreground interiors and abstain for neighbor overlap or guided evidence', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const graph = structuredClone(f.graph),
    observationId = randomUUID(),
    mask = maskFixture('blob'),
    target = graph.objects[0]!;
  const observation: SceneObservation = {
    id: observationId,
    kind: 'mask',
    source: 'sam',
    attemptId: randomUUID(),
    model: 'test',
    bbox: [165, 35, mask.width, mask.height],
    samSnapshotId: randomUUID(),
  };
  graph.observations.push(observation);
  const association = {
    id: randomUUID(),
    objectId: target.id,
    observationId,
    relation: 'unknown' as const,
    status: 'proposed' as const,
    basis: 'category_and_overlap' as const,
    attemptId: randomUUID(),
  };
  graph.associations.push(association);
  const crop: [number, number, number, number] = [120, 0, 120, 130];
  const native = [{ observationId, encodedMask: mask }];
  const proposed = proposeAutomaticTargeting(graph, target.id, crop, native);
  assert.equal(proposed.pointStatus, 'proposed');
  assert.equal(proposed.variants.length, 2);
  assert.ok(proposed.pointCues[0]!.interiorDistance >= 2);
  assert.match(proposed.variants[1]!.prompt, /point/);
  const point = proposed.pointCues[0]!.point;
  assert.ok(point[0] > 165 && point[1] > 35);
  graph.objects[1] = {
    ...structuredClone(graph.objects[1]!),
    bbox: target.bbox,
  };
  assert.equal(
    proposeAutomaticTargeting(graph, target.id, crop, native).pointStatus,
    'abstained',
  );
  graph.objects[1] = f.graph.objects[1]!;
  graph.associations.at(-1)!.basis = 'prompt_target';
  assert.equal(
    proposeAutomaticTargeting(graph, target.id, crop, native).pointStatus,
    'abstained',
  );
});

test('automatic scoring retains native mask metrics and rejects a mask from a different request crop', async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const plan = await prepareAutomaticConnectorExperiment(
    f.store,
    f.job.analysisId,
    f.plan.objectId,
  );
  const profile = boundaryProfile(f);
  const report = await runConnectorExperiment(f.store, plan, f.config, {
    client: createMetaClient(f.config, async (_u, init) => {
      const payload = JSON.parse(init!.body as string),
        meta = await (
          await import('sharp')
        )
          .default(
            Buffer.from(
              payload.input[0].content[1].image_url.split(',')[1],
              'base64',
            ),
          )
          .metadata(),
        mask = maskFixture();
      return Response.json(
        samEnvelope(
          `<0f>0<|box;x1=0;y1=0;x2=19;y2=19;w=${meta.width};h=${meta.height}|><|mask;x=0;y=0;data=${mask.height},${mask.width},${mask.payload}|>`,
        ),
      );
    }),
  });
  const scored = evaluateAutomaticTargetingReport(report, profile);
  assert.equal(scored.measurements[0]!.masks.length, 1);
  assert.ok(scored.measurements[0]!.masks[0]!.areaPixels > 0);
  const invalid = structuredClone(report);
  const badNative = invalid.measurements[0]!.native![0] as { crop: number[] };
  badNative.crop = [...badNative.crop];
  badNative.crop[0] = badNative.crop[0]! + 1;
  assert.throws(
    () => evaluateAutomaticTargetingReport(invalid, profile),
    /mask binding mismatch/,
  );
  const [x, y, w, h] = plan.object.bbox,
    [cx, cy] = plan.variants[0]!.crop;
  assert.ok(
    plan.variants[0]!.prompt.includes(
      `x1=${x - cx};y1=${y - cy};x2=${x - cx + w - 1};y2=${y - cy + h - 1};`,
    ),
  );
});
