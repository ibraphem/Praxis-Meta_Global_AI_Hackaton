import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/lib/errors.js';
import type { MetaClient } from '../src/lib/meta-client.js';
import { analysisSchema } from '../src/schemas/vision.js';
import { createVisionService } from '../src/services/vision.js';
import { buildWirePrompt, parseSamOutput } from '../src/services/sam.js';
import { WireGeometry } from '../src/services/wire-geometry.js';
import {
  completion,
  imageBytes,
  queuedClient,
  samEnvelope,
  samWireRecord,
  maskFixture,
  testConfig,
} from './helpers.js';

const noSam = () => Array.from({ length: 4 }, () => samEnvelope(''));
const image = { width: 100, height: 80 };
const hint = {
  box: [100, 250, 300, 500],
  color: 'green',
  positivePoints: [[130, 375]],
  negativePoints: [[200, 375]],
};
const nativePrompt = {
  id: 0,
  bbox: [10, 20, 20, 20] as [number, number, number, number],
  positivePoints: [[13, 30]] as [number, number][],
  negativePoints: [[20, 30]] as [number, number][],
};
const fail = (error: unknown) =>
  error instanceof AppError && error.code === 'INVALID_PROVIDER_OUTPUT';

test('spatial prompts use inclusive native corners, positive/negative points and no noun phrase', () => {
  const text = buildWirePrompt([nativePrompt], image);
  assert.equal(
    text,
    '<0f>0<|box;x1=10;y1=20;x2=29;y2=39;w=100;h=80|><|point;x=13;y=30;w=100;h=80|>-<|point;x=20;y=30;w=100;h=80|>',
  );
  assert.throws(
    () => buildWirePrompt([{ ...nativePrompt, positivePoints: [] }], image),
    fail,
  );
  assert.throws(
    () => buildWirePrompt([nativePrompt, nativePrompt], image),
    fail,
  );
  assert.throws(
    () =>
      buildWirePrompt([{ ...nativePrompt, positivePoints: [[50, 50]] }], image),
    fail,
  );
  assert.throws(
    () =>
      parseSamOutput(
        samWireRecord('wire', 9007199254740992),
        'jumper_wire',
        image,
        true,
      ),
    fail,
  );
});

test('valid wire masks decode into bounded SVG contours; blobs, branches, empty and disconnected masks remain ambiguous', () => {
  const geometry = new WireGeometry(image);
  const good = geometry.resolve(
    {
      type: 'jumper_wire',
      bbox: nativePrompt.bbox,
      encodedMask: maskFixture(),
    },
    nativePrompt,
  );
  assert.equal(good.ok, true);
  if (good.ok) assert.match(good.mask.geometry.path, /^M/);
  for (const kind of ['blob', 'split', 'empty', 'branch'] as const) {
    const result = new WireGeometry(image).resolve({
      type: 'jumper_wire',
      bbox: nativePrompt.bbox,
      encodedMask: maskFixture(kind),
    });
    assert.deepEqual(result, { ok: false, reason: 'ambiguous_mask' });
  }
});

test('seed consistency, duplicate masks, corrupt payloads and decode quotas are checked', () => {
  const detection = {
    type: 'jumper_wire' as const,
    bbox: nativePrompt.bbox,
    encodedMask: maskFixture(),
  };
  assert.deepEqual(
    new WireGeometry(image).resolve(detection, {
      ...nativePrompt,
      positivePoints: [[20, 30]],
    }),
    { ok: false, reason: 'prompt_mismatch' },
  );
  assert.deepEqual(
    new WireGeometry(image).resolve(detection, {
      ...nativePrompt,
      negativePoints: [[13, 30]],
    }),
    { ok: false, reason: 'prompt_mismatch' },
  );
  const geometry = new WireGeometry(image);
  assert.equal(geometry.resolve(detection).ok, true);
  assert.deepEqual(geometry.resolve(detection), {
    ok: false,
    reason: 'duplicate_mask',
  });
  assert.deepEqual(
    new WireGeometry(image).resolve({
      ...detection,
      encodedMask: { ...maskFixture(), payload: '!bad' },
    }),
    { ok: false, reason: 'invalid_mask' },
  );
  assert.deepEqual(
    new WireGeometry(image).resolve({
      ...detection,
      encodedMask: { ...maskFixture(), width: 50000, height: 50000 },
    }),
    { ok: false, reason: 'geometry_budget' },
  );
});

test('Muse regions become wire candidates only after usable SAM refinement, with no guidance eligibility', async () => {
  const { client, calls } = queuedClient([
    ...noSam(),
    completion({ objects: [], missingWires: [hint] }),
    samEnvelope(samWireRecord('wire', 0)),
  ]);
  const result = await createVisionService(testConfig(), client)(
    await imageBytes(),
    new AbortController().signal,
  );
  assert.equal(calls.length, 6);
  assert.equal(result.objects.length, 1);
  assert.deepEqual(result.proposals, []);
  const wire = result.objects[0]!;
  assert.equal(wire.id, 'jumper_wire_1');
  assert.equal(wire.localizationSource, 'sam');
  assert.equal(wire.detectionSource, 'muse');
  assert.equal(wire.geometryStatus, 'segmented');
  assert.ok(wire.mask?.path);
  assert.equal(wire.guidanceEligible, false);
  assert.equal(wire.identityStatus, 'unverified');
  assert.equal(wire.interpretation, 'uncertain');
  assert.equal('encodedMask' in wire, false);
  assert.equal('samObjectId' in wire, false);
  assert.equal(result.provenance.wireAudit?.recoveredByMuse, 1);
});

test('missing anchors and capped proposals remain separately labeled regions without extra calls or inflated wire counts', async () => {
  const hints = [
    { ...hint, positivePoints: [] },
    { ...hint, positivePoints: [] },
  ];
  const { client, calls } = queuedClient([
    ...noSam(),
    completion({ objects: [], missingWires: hints }),
  ]);
  const result = await createVisionService(testConfig(), client)(
    await imageBytes(),
    new AbortController().signal,
  );
  assert.equal(calls.length, 5);
  assert.deepEqual(result.objects, []);
  assert.equal(result.proposals?.length, 2);
  assert.equal(result.proposals?.[0]?.id, 'wire_region_1');
  assert.equal(result.proposals?.[0]?.reason, 'missing_anchor');
  const capped = queuedClient([
    ...noSam(),
    completion({ objects: [], missingWires: [hint] }),
  ]);
  const result2 = await createVisionService(
    testConfig({ MAX_WIRE_REFINEMENTS: '0' }),
    capped.client,
  )(await imageBytes(), new AbortController().signal);
  assert.equal(result2.proposals?.[0]?.reason, 'budget_exhausted');
  assert.equal(capped.calls.length, 5);
});

test('empty and ambiguous SAM refinements retain uncertain regions rather than wire IDs', async () => {
  for (const native of [
    '',
    samWireRecord('blob', 0),
    samWireRecord('split', 0),
  ]) {
    const { client } = queuedClient([
      ...noSam(),
      completion({ objects: [], missingWires: [hint] }),
      samEnvelope(native),
    ]);
    const result = await createVisionService(testConfig(), client)(
      await imageBytes(),
      new AbortController().signal,
    );
    assert.deepEqual(result.objects, []);
    assert.equal(result.proposals?.length, 1);
    assert.equal(result.proposals?.[0]?.guidanceEligible, false);
  }
});

test('accepted SAM masks render directly; duplicate refinement masks are not counted twice', async () => {
  const { client } = queuedClient([
    samEnvelope(''),
    samEnvelope(''),
    samEnvelope(''),
    samEnvelope(samWireRecord()),
    completion({
      objects: [{ id: 'jumper_wire_1', decision: 'confirmed', color: 'red' }],
      missingWires: [hint],
    }),
    samEnvelope(samWireRecord('wire', 0)),
  ]);
  const result = await createVisionService(testConfig(), client)(
    await imageBytes(),
    new AbortController().signal,
  );
  assert.equal(result.objects.length, 1);
  assert.equal(result.objects[0]?.confidence, 0.91);
  assert.equal(result.proposals?.[0]?.reason, 'duplicate_mask');
  assert.equal(result.provenance.wireAudit?.acceptedSam, 1);
});

test('optional refinement timeouts retain existing results and explicit failure reasons', async () => {
  const queue = queuedClient([
    samEnvelope(''),
    samEnvelope(''),
    samEnvelope(''),
    samEnvelope(samWireRecord()),
    completion({
      objects: [{ id: 'jumper_wire_1', decision: 'confirmed', color: 'red' }],
      missingWires: [hint],
    }),
  ]);
  const client: MetaClient = {
    async post(path, body, signal, operation) {
      if (operation?.stage === 'sam.wire_refine')
        throw new AppError(
          504,
          'PROVIDER_TIMEOUT',
          'Bounded optional timeout.',
        );
      return queue.client.post(path, body, signal, operation);
    },
  };
  const result = await createVisionService(testConfig(), client)(
    await imageBytes(),
    new AbortController().signal,
  );
  assert.equal(result.objects.length, 1);
  assert.ok(result.objects[0]?.mask);
  assert.equal(result.proposals?.[0]?.refinementStatus, 'timed_out');
  assert.equal(result.proposals?.[0]?.refinementCode, 'PROVIDER_TIMEOUT');
});

test('reasoning-only wires are unresolved regions, not actionable numbered wires', async () => {
  const { client } = queuedClient([
    completion({
      objects: [
        {
          type: 'jumper_wire',
          box: [100, 250, 300, 500],
          color: 'green',
          interpretation: 'confirmed',
        },
      ],
    }),
  ]);
  const result = await createVisionService(
    testConfig({ VISION_MODE: 'reasoning-only' }),
    client,
  )(await imageBytes(), new AbortController().signal);
  assert.deepEqual(result.objects, []);
  assert.equal(result.proposals?.[0]?.reason, 'sam_unavailable');
});

test('mask retention is opt-in and public contracts reject broad, executable, or guidance-ready wire objects', () => {
  assert.ok(
    parseSamOutput(samWireRecord(), 'jumper_wire', image, true)[0]?.encodedMask,
  );
  assert.equal(
    parseSamOutput(samWireRecord(), 'jumper_wire', image)[0]?.encodedMask,
    undefined,
  );
  const object = {
    id: 'jumper_wire_1',
    type: 'jumper_wire',
    bbox: [10, 20, 20, 20],
    interpretation: 'confirmed',
    localizationSource: 'sam',
    guidanceEligible: false,
    identityStatus: 'unverified',
    geometryStatus: 'segmented',
    mask: { format: 'svg_path', width: 20, height: 20, path: 'M0 0L5 0L5 5Z' },
  };
  const base = {
    image,
    objects: [object],
    provenance: { mode: 'combined', reasoningModel: 'muse-spark-1.3' },
  };
  assert.equal(analysisSchema.safeParse(base).success, true);
  for (const invalid of [
    { ...object, mask: undefined },
    { ...object, guidanceEligible: true },
    { ...object, mask: { ...object.mask, path: '<script>alert(1)</script>' } },
  ])
    assert.equal(
      analysisSchema.safeParse({ ...base, objects: [invalid] }).success,
      false,
    );
});

test('parent analysis cancellation during optional refinement still fails the entire request', async () => {
  const controller = new AbortController();
  const queue = queuedClient([
    ...noSam(),
    completion({ objects: [], missingWires: [hint] }),
  ]);
  const parentFailure = new AppError(
    504,
    'ANALYSIS_TIMEOUT',
    'Overall analysis deadline.',
  );
  const client: MetaClient = {
    async post(path, body, signal, operation) {
      if (operation?.stage === 'sam.wire_refine') {
        controller.abort(parentFailure);
        throw parentFailure;
      }
      return queue.client.post(path, body, signal, operation);
    },
  };
  await assert.rejects(
    createVisionService(testConfig(), client)(
      await imageBytes(),
      controller.signal,
    ),
    (error: unknown) => error === parentFailure,
  );
});

test('unexpected refinement IDs stay unresolved and refinement caps apply to the single batch', async () => {
  const queue = queuedClient([
    ...noSam(),
    completion({ objects: [], missingWires: [hint, hint, hint] }),
    samEnvelope(samWireRecord('wire', 9)),
  ]);
  const result = await createVisionService(
    testConfig({ MAX_WIRE_REFINEMENTS: '2' }),
    queue.client,
  )(await imageBytes(), new AbortController().signal);
  assert.equal(queue.calls.length, 6);
  assert.equal(result.objects.length, 0);
  assert.equal(result.provenance.wireAudit?.refinementAttempts, 2);
  assert.equal(
    result.proposals?.filter((region) => region.reason === 'budget_exhausted')
      .length,
    1,
  );
  assert.equal(
    result.proposals?.filter(
      (region) => region.refinementCode === 'INVALID_PROVIDER_OUTPUT',
    ).length,
    2,
  );
});
