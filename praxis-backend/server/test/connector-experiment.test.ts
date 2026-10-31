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
  assert.equal(report.status, 'completed');
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
