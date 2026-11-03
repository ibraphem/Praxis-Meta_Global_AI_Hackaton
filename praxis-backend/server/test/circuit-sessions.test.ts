import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { JobStore, publicJob } from '../src/jobs/store.js';
import { CircuitSessionService } from '../src/jobs/circuit-sessions.js';
import { connectivityPerceptionHash } from '../src/jobs/connectivity.js';
import { circuitCaptureClient } from '../src/jobs/circuit-capture-client.js';
import { prepareImage } from '../src/services/image.js';
import { canonicalHash } from '../src/lib/canonical-json.js';
import {
  testConfig,
  imageBytes,
  multipartBody,
  samEnvelope,
  samWireRecord,
  completion,
} from './helpers.js';
import { syntheticTwoLed } from './fixtures/two-led.js';
const frameHash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pause = () => new Promise((r) => setTimeout(r, 15));
test('idle recovery preserves sessions and unuploaded captures across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-camera-setup-')),
    config = testConfig();
  let store = new JobStore(config, dir);
  try {
    const service = new CircuitSessionService(store),
      initial = service.create(),
      id = initial.session.sessionId;
    assert.equal(store.claim('idle-worker-before-capture'), undefined);
    assert.equal(service.view(id).session.sessionId, id);
    const prepared = service.prepare(id, {
        expectedRevision: initial.session.revision,
        purpose: 'setup',
        frameHash: 'a'.repeat(64),
        width: 640,
        height: 480,
        capturedAt: Date.now(),
      }),
      captureId = prepared.captures[0]!.plan.captureId;
    assert.equal(store.claim('idle-worker-before-approval'), undefined);
    store.close();
    store = new JobStore(config, dir);
    store.recover();
    store.cleanup();
    const resumed = new CircuitSessionService(store).view(id);
    assert.equal(resumed.session.activeCaptureId, captureId);
    assert.equal(resumed.captures.length, 1);
    assert.equal(resumed.captures[0]!.analysisId, null);
    assert.deepEqual(resumed.captures[0]!.plan, prepared.captures[0]!.plan);
    const retaken = new CircuitSessionService(store).prepare(id, {
      expectedRevision: resumed.session.revision,
      purpose: 'setup',
      frameHash: 'b'.repeat(64),
      width: 640,
      height: 480,
      capturedAt: Date.now(),
    });
    assert.equal(retaken.captures.length, 2);
    assert.notEqual(retaken.session.activeCaptureId, captureId);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery removes records linked to missing analyses while keeping new sessions', () => {
  const store = new JobStore(testConfig(), ':memory:'),
    service = new CircuitSessionService(store);
  try {
    const fresh = service.create(),
      orphan = service.create();
    store.db
      .prepare('UPDATE circuit_sessions SET analysis_id=? WHERE id=?')
      .run('removed-analysis', orphan.session.sessionId);
    store.recover();
    assert.equal(
      service.view(fresh.session.sessionId).session.sessionId,
      fresh.session.sessionId,
    );
    assert.throws(() => service.view(orphan.session.sessionId), /unavailable/);
  } finally {
    store.close();
  }
});

async function finish(store: JobStore, id: string) {
  for (let i = 0; i < 100; i++) {
    const j = store.get(id);
    if (
      !j.owner &&
      !['queued', 'running'].includes(j.sam.status) &&
      !['queued', 'running'].includes(j.scene?.status ?? '')
    )
      return j;
    await pause();
  }
  throw Error('Worker did not settle.');
}
test('HTTP camera scan executes exactly four SAM calls, persists provenance, blocks legacy retries and replays', async () => {
  const config = testConfig({ DYNAMIC_SCENE_ENABLED: 'true' }),
    store = new JobStore(config, ':memory:');
  let calls = 0;
  const client = {
    async post(_path: any, body: any, _signal: any, operation: any) {
      calls++;
      assert.equal(operation.maxRetries, 0);
      operation.evidence.request(JSON.stringify(body));
      const response =
        _path === 'chat/completions'
          ? completion({
              endpoints: ['A', 'B'].map((role) => ({
                role,
                proposedImagePosition: null,
                connectorJunctionPosition: null,
                evidence: 'insufficient',
              })),
            })
          : samEnvelope(calls === 4 ? samWireRecord() : '');
      operation.evidence.response({
        bytes: Buffer.from(JSON.stringify(response)),
        upstreamStatus: 200,
        contentType: 'application/json',
        truncated: false,
      });
      return response;
    },
  };
  const app = await buildApp(config, undefined, () => {}, undefined, {
    store,
    experimentClient: client,
  });
  await app.ready();
  try {
    const initial = (
        await app.inject({ method: 'POST', url: '/api/circuit-sessions' })
      ).json(),
      id = initial.session.sessionId,
      bytes = await imageBytes(),
      prepare = await app.inject({
        method: 'POST',
        url: `/api/circuit-sessions/${id}/prepare-capture`,
        payload: {
          expectedRevision: 0,
          purpose: 'setup',
          frameHash: frameHash(bytes),
          width: 100,
          height: 80,
          capturedAt: Date.now(),
        },
      });
    assert.equal(prepare.statusCode, 200, prepare.body);
    const plan = prepare.json().captures[0].plan;
    assert.equal(plan.budget.samRequests, 4);
    assert.equal(calls, 0);
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      ...multipartBody(await imageBytes(101, 80)),
      headers: {
        ...multipartBody(bytes).headers,
        'x-praxis-capture-plan': plan.planId,
      },
    });
    assert.equal(wrong.statusCode, 409);
    assert.equal(calls, 0);
    const upload = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      ...multipartBody(bytes),
      headers: {
        ...multipartBody(bytes).headers,
        'x-praxis-capture-plan': plan.planId,
      },
    });
    assert.equal(upload.statusCode, 202, upload.body);
    const j = await finish(store, upload.json().analysisId);
    assert.equal(j.status, 'completed');
    assert.equal(j.muse.status, 'not_started');
    assert.equal(j.scene, undefined);
    assert.equal(calls, 4);
    assert.equal(j.recovery.status, 'not_started');
    assert.equal(publicJob(j).captureContext?.planId, plan.planId);
    for (const action of [
      'retry-sam',
      'retry-muse',
      'retry-scene',
      'start-scene',
      'audit-wires',
      'refresh-scene',
    ]) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/analyses/${j.analysisId}/${action}`,
        payload: {},
      });
      assert.equal(r.statusCode, 409, action);
    }
    const replay = await app.inject({
      method: 'POST',
      url: '/api/analyses',
      ...multipartBody(bytes),
      headers: {
        ...multipartBody(bytes).headers,
        'x-praxis-capture-plan': plan.planId,
      },
    });
    assert.equal(replay.statusCode, 409);
    assert.equal(calls, 4);
    const preview = await app.inject({
      method: 'POST',
      url: `/api/circuit-sessions/${id}/prepare-endpoints`,
      payload: { captureId: plan.captureId, wireCandidateId: 'jumper_wire_1' },
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(calls, 4);
    const ep = preview.json().captures[0].endpointPlan;
    assert.ok(ep.pixels > 0);
    assert.deepEqual(Object.keys(ep.dimensions[0]).sort(), ['height', 'width']);
    const run = await app.inject({
      method: 'POST',
      url: `/api/circuit-sessions/${id}/run-endpoints`,
      payload: {
        captureId: plan.captureId,
        endpointPlanHash: ep.hash,
        authorize: true,
      },
    });
    assert.equal(run.statusCode, 202, run.body);
    await finish(store, j.analysisId);
    assert.equal(calls, 5);
    const second = await app.inject({
      method: 'POST',
      url: `/api/circuit-sessions/${id}/run-endpoints`,
      payload: {
        captureId: plan.captureId,
        endpointPlanHash: ep.hash,
        authorize: true,
      },
    });
    assert.notEqual(second.statusCode, 202);
    assert.equal(calls, 5);
    const evidence = (
      await app.inject({ url: `/api/circuit-sessions/${id}/evidence` })
    ).json();
    assert.equal(evidence.requests.length, 5);
    assert.equal(
      JSON.stringify(evidence.requests).includes('data:image/'),
      false,
    );
    assert.equal(
      evidence.requests.reduce((n: number, r: any) => n + r.pixels, 0),
      32000 + ep.pixels,
    );
    assert.ok(evidence.analyses[0].snapshots.length);
    assert.equal(
      evidence.analyses[0].requests.filter((r: any) => r.response && r.request)
        .length,
      5,
    );
    assert.equal(evidence.analyses[0].image.sha256, frameHash(bytes));
  } finally {
    await app.close();
    store.close();
  }
});
test('stale plans, oversize frames and unqualified physical profiles are rejected before inference', async () => {
  const config = testConfig(),
    store = new JobStore(config, ':memory:'),
    s = new CircuitSessionService(store);
  try {
    const v = s.create(),
      id = v.session.sessionId;
    assert.throws(
      () =>
        s.prepare(id, {
          expectedRevision: 0,
          purpose: 'assessment',
          frameHash: 'a'.repeat(64),
          width: 100,
          height: 80,
          capturedAt: Date.now(),
        }),
      /verified physical/,
    );
    assert.throws(
      () =>
        s.prepare(id, {
          expectedRevision: 0,
          purpose: 'setup',
          frameHash: 'a'.repeat(64),
          width: 2000,
          height: 2000,
          capturedAt: Date.now(),
        }),
      /1.5 million/,
    );
    const bytes = await imageBytes(),
      p = s.prepare(id, {
        expectedRevision: 0,
        purpose: 'setup',
        frameHash: frameHash(bytes),
        width: 100,
        height: 80,
        capturedAt: Date.now(),
      });
    s.prepare(id, {
      expectedRevision: p.session.revision,
      purpose: 'setup',
      frameHash: frameHash(bytes),
      width: 100,
      height: 80,
      capturedAt: Date.now(),
    });
    const awaitImage = await prepareImage(bytes, config);
    assert.throws(
      () => s.upload(p.captures[0]!.plan.planId, bytes, awaitImage),
      /stale/,
    );
  } finally {
    store.close();
  }
});
// No physical circuit is implied by this test: generated pixels and simulated human attestations exercise persistence only.
test('registered capture clears both old contacts; fresh review, repair and a different reviewed photo resolve the synthetic scenario', async () => {
  const config = testConfig(),
    store = new JobStore(config, ':memory:'),
    service = new CircuitSessionService(store);
  try {
    const noise = Buffer.alloc(640 * 900 * 3);
    let seed = 11;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[i] = seed >>> 24;
    }
    const healthy = await sharp(noise, {
        raw: { width: 640, height: 900, channels: 3 },
      })
        .jpeg({ quality: 98 })
        .toBuffer(),
      setup = store.create(healthy, await prepareImage(healthy, config));
    setup.sam.status = 'succeeded';
    setup.sam.attempts[0]!.status = 'succeeded';
    setup.status = 'completed';
    store.save(setup);
    const { input, profile } = syntheticTwoLed();
    input.analysisId = setup.analysisId;
    input.imageHash = setup.imageHash;
    input.validationScope = 'photograph'; // Simulated photo review for API testing; never exported as a real validation result.
    for (const proof of [
      input.coverage,
      ...input.boards,
      ...input.components,
      ...input.terminals,
      ...input.associations,
    ].flatMap((v) => v.evidence)) {
      proof.source = 'human_review';
      proof.note = 'SYNTHETIC test of simulated human review, no real rig.';
    }
    store.db.prepare('INSERT INTO connectivity_sources VALUES (?,?)').run(
      setup.analysisId,
      JSON.stringify({
        input,
        workspace: null,
        sourceSceneHash: null,
        sourceAnalysisRevision: setup.revision,
        sourcePerceptionHash: connectivityPerceptionHash(setup),
      }),
    );
    let v = service.create();
    v = service.saveProfile(v.session.sessionId, {
      expectedRevision: v.session.revision,
      analysisId: setup.analysisId,
      qualification: 'verified_human',
      parts: profile.parts,
      mapping: profile.mapping,
      poseAnchors: profile.poseAnchors,
      physicalDetailsVerified: true,
      reviewer: 'synthetic test',
      reason: 'Simulated review for persistence test only.',
    });
    const capture = async (
      variant: number,
      purpose: 'assessment' | 'verification',
    ) => {
      const modified = Buffer.from(noise);
      modified[(500 * 640 + 400) * 3] = variant;
      const bytes = await sharp(modified, {
        raw: { width: 640, height: 900, channels: 3 },
      })
        .jpeg({ quality: 99 })
        .toBuffer();
      v = service.prepare(v.session.sessionId, {
        expectedRevision: v.session.revision,
        purpose,
        frameHash: frameHash(bytes),
        width: 640,
        height: 900,
        capturedAt: Date.now(),
      });
      const c = v.captures.at(-1)!,
        job = service.upload(
          c.plan.planId,
          bytes,
          await prepareImage(bytes, config),
        );
      job.sam.status = 'succeeded';
      job.sam.attempts[0]!.status = 'succeeded';
      job.status = 'completed';
      job.sam.snapshot!.candidates = [
        { id: 'jumper_wire_1', type: 'jumper_wire', bbox: [300, 300, 50, 80] },
      ];
      store.save(job);
      v = await service.seed(v.session.sessionId, {
        captureId: c.plan.captureId,
      });
      assert.equal((v.captures.at(-1)!.poseEvidence as any).valid, true);
      assert.equal(
        v
          .input!.associations.filter((a) => a.terminalId.startsWith('J1:'))
          .every((a) => a.target === null && a.state === 'unresolved'),
        true,
      );
      return c.plan.captureId;
    };
    const review = (captureId: string, moving: string) => {
      v = service.review(v.session.sessionId, {
        captureId,
        expectedInputHash: canonicalHash(v.input),
        wireCandidateId: 'jumper_wire_1',
        anchored: { boardId: 'board_1', holeId: 'b5' },
        moving: { boardId: 'board_1', holeId: moving },
        staticContactsUnchanged: true,
        bothInsertionsVisible: true,
        wireIdentityConfirmed: true,
        reviewer: 'synthetic test',
        reason: 'Simulated visible contacts for persistence test only.',
      });
    };
    const first = await capture(20, 'assessment');
    review(first, 'a7');
    assert.equal(v.session.state, 'fault_found');
    v = service.repair(v.session.sessionId, {
      captureId: first,
      expectedInputHash: canonicalHash(v.input),
      target: { boardId: 'board_1', holeId: 'c6' },
      destinationVisibleAndEmpty: true,
      reviewer: 'synthetic test',
      reason: 'Simulated empty hole for API test only.',
    });
    const repair = v.repairs[0]!;
    assert.equal(v.session.state, 'repair_guidance');
    assert.throws(
      () =>
        service.verify(v.session.sessionId, {
          captureId: first,
          repairId: repair.repairId,
        }),
      /not prepared/,
    );
    const second = await capture(220, 'verification');
    review(second, 'c6');
    v = service.verify(v.session.sessionId, {
      captureId: second,
      repairId: repair.repairId,
    });
    assert.equal(v.verifications[0]!.status, 'resolved');
    assert.equal(v.verifications[0]!.electricalOperationVerified, false);
    assert.equal(service.evidence(v.session.sessionId).analyses.length, 3);
    assert.equal(
      service.evidence(v.session.sessionId).captureReviews.length,
      2,
    );
    assert.equal(v.requests.length, 0);
  } finally {
    store.close();
  }
});
test('dispatch intent survives restart and forbids silent replay after unknown usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-camera-')),
    config = testConfig();
  let store = new JobStore(config, dir),
    id = '',
    captureId = '',
    owner = 'synthetic-worker',
    attemptId = '';
  try {
    const s = new CircuitSessionService(store),
      v = s.create(),
      bytes = await imageBytes(),
      p = s.prepare(v.session.sessionId, {
        expectedRevision: 0,
        purpose: 'setup',
        frameHash: frameHash(bytes),
        width: 100,
        height: 80,
        capturedAt: Date.now(),
      });
    captureId = p.captures[0]!.plan.captureId;
    const j = s.upload(
      p.captures[0]!.plan.planId,
      bytes,
      await prepareImage(bytes, config),
    );
    id = j.analysisId;
    const claim = store.claim(owner)!;
    attemptId = claim.attemptId;
    let calls = 0;
    const client = circuitCaptureClient(
      store,
      claim.job,
      owner,
      'sam',
      attemptId,
      {
        async post() {
          calls++;
          throw Error('synthetic transport loss');
        },
      },
    );
    await assert.rejects(() =>
      client.post(
        'responses',
        { model: config.META_SAM_MODEL },
        new AbortController().signal,
        {
          stage: 'sam.breadboard',
          imageDimensions: [{ width: 100, height: 80 }],
        },
      ),
    );
    assert.equal(calls, 1);
    store.close();
    store = new JobStore(config, dir);
    const restored = store.get(id),
      again = circuitCaptureClient(store, restored, owner, 'sam', attemptId, {
        async post() {
          calls++;
          return {};
        },
      });
    await assert.rejects(
      () =>
        again.post(
          'responses',
          { model: config.META_SAM_MODEL },
          new AbortController().signal,
          {
            stage: 'sam.breadboard',
            imageDimensions: [{ width: 100, height: 80 }],
          },
        ),
      /already attempted/,
    );
    assert.equal(calls, 1);
    const sessionId = restored.captureContext!.sessionId,
      evidence = new CircuitSessionService(store).evidence(sessionId);
    assert.equal(evidence.captures[0]!.plan.captureId, captureId);
    assert.equal(evidence.requests[0]!.status, 'unknown');
    assert.throws(() => store.retry(id, 'sam'), /frozen/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
