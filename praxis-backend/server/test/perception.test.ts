import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { AppError } from '../src/lib/errors.js';
import { prepareImage } from '../src/services/image.js';
import { parseSamOutput, createSamService } from '../src/services/sam.js';
import { createVisionService, deduplicate } from '../src/services/vision.js';
import {
  completion,
  imageBytes,
  queuedClient,
  samEnvelope,
  samRecord,
  testConfig,
} from './helpers.js';

const dimensions = { width: 100, height: 80 };
const image = { ...dimensions, dataUrl: 'data:image/jpeg;base64,test' };
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;

test('SAM converts inclusive native corners and preserves provider confidence', () => {
  assert.deepEqual(parseSamOutput(samRecord, 'led', dimensions), [
    { type: 'led', bbox: [10, 20, 20, 20], confidence: 0.91 },
  ]);
  const noConfidence = samRecord.replaceAll(';c=0.91', '');
  assert.equal(
    'confidence' in parseSamOutput(noConfidence, 'led', dimensions)[0]!,
    false,
  );
  assert.deepEqual(parseSamOutput('', 'led', dimensions), []);
});

test('SAM rejects malformed, truncated, mismatched and out-of-bounds output', () => {
  for (const invalid of [
    '{}',
    '<0f>',
    samRecord.replace('<0f>', '<1f>'),
    samRecord.replace('w=100', 'w=200'),
    samRecord.replace('x2=29', 'x2=100'),
    samRecord.replace('x1=10', 'x1=30'),
    samRecord.replaceAll('c=0.91', 'c=1.2'),
    samRecord.slice(0, -2),
    `${samRecord},`,
    `${samRecord}ignored`,
    samRecord.replace('data=20,20', 'data=999999999,20'),
  ])
    assert.throws(
      () => parseSamOutput(invalid, 'led', dimensions),
      code('INVALID_PROVIDER_OUTPUT'),
    );
});

test('SAM makes separate concept calls and treats completed empty output as no detections', async () => {
  const { client, calls } = queuedClient(
    Array.from({ length: 4 }, () => samEnvelope('')),
  );
  assert.deepEqual(
    await createSamService(testConfig(), client)(
      image,
      new AbortController().signal,
    ),
    [],
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.map(
      (call) =>
        (call.body.input as { content: { text: string }[] }[])[0]!.content[0]!
          .text,
    ),
    ['breadboard', 'LED', 'resistor', 'wire'],
  );
  assert.deepEqual(calls[0]!.body.metadata, {
    include_confidence: 'true',
    mask_encoding: 'one_bit',
  });
});

test('incomplete SAM responses fail rather than becoming empty success', async () => {
  const { client } = queuedClient([{ status: 'incomplete', output: [] }]);
  await assert.rejects(
    createSamService(testConfig(), client)(image, new AbortController().signal),
    code('INVALID_PROVIDER_OUTPUT'),
  );
});

test('image preparation rotates EXIF, strips metadata, and preserves corrected dimensions', async () => {
  const bytes = await sharp({
    create: { width: 100, height: 80, channels: 3, background: 'red' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const prepared = await prepareImage(bytes, testConfig());
  assert.equal(prepared.width, 80);
  assert.equal(prepared.height, 100);
  const metadata = await sharp(
    Buffer.from(prepared.dataUrl.split(',')[1]!, 'base64'),
  ).metadata();
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.orientation, undefined);
});

test('image validation rejects empty, spoofed, corrupt and oversized photographs', async () => {
  await assert.rejects(
    prepareImage(Buffer.alloc(0), testConfig()),
    code('EMPTY_IMAGE'),
  );
  await assert.rejects(
    prepareImage(Buffer.from('<svg/>'), testConfig()),
    code('UNSUPPORTED_IMAGE'),
  );
  await assert.rejects(
    prepareImage(Buffer.from([255, 216, 255, 0]), testConfig()),
    code('INVALID_IMAGE'),
  );
  await assert.rejects(
    prepareImage(await imageBytes(), testConfig({ MAX_IMAGE_PIXELS: '100' })),
    code('IMAGE_TOO_LARGE'),
  );
  await assert.rejects(
    prepareImage(await imageBytes(), testConfig({ MAX_UPLOAD_BYTES: '10' })),
    code('UPLOAD_TOO_LARGE'),
  );
});

test('combined pipeline keeps SAM geometry and confidence, with uncertainty from Muse', async () => {
  const { client, calls } = queuedClient([
    samEnvelope(''),
    samEnvelope(samRecord),
    samEnvelope(''),
    samEnvelope(''),
    completion({
      objects: [{ id: 'led_1', decision: 'uncertain', color: 'green' }],
      missingWires: [],
    }),
  ]);
  const result = await createVisionService(testConfig(), client)(
    await imageBytes(),
    new AbortController().signal,
  );
  assert.deepEqual(result.objects, [
    {
      id: 'led_1',
      type: 'led',
      bbox: [10, 20, 20, 20],
      confidence: 0.91,
      interpretation: 'uncertain',
      color: 'green',
      localizationSource: 'sam',
      geometryStatus: 'box_only',
      guidanceEligible: false,
    },
  ]);
  assert.equal(result.provenance.mode, 'combined');
  assert.equal(calls.at(-1)!.path, 'chat/completions');
});

test('Muse must account for every candidate, cannot invent IDs or confidence', async () => {
  for (const objects of [
    [],
    [{ id: 'unknown_1', decision: 'confirmed', color: null }],
    [{ id: 'led_1', decision: 'confirmed', color: null, confidence: 0.99 }],
  ]) {
    const { client } = queuedClient([
      samEnvelope(''),
      samEnvelope(samRecord),
      samEnvelope(''),
      samEnvelope(''),
      completion({ objects, missingWires: [] }),
    ]);
    await assert.rejects(
      createVisionService(testConfig(), client)(
        await imageBytes(),
        new AbortController().signal,
      ),
      code('INVALID_PROVIDER_OUTPUT'),
    );
  }
});

test('explicit reasoning-only mode converts normalized coordinates and omits confidence', async () => {
  const { client, calls } = queuedClient([
    completion({
      objects: [
        {
          type: 'led',
          box: [100, 250, 300, 500],
          color: null,
          interpretation: 'confirmed',
        },
      ],
    }),
  ]);
  const result = await createVisionService(
    testConfig({ VISION_MODE: 'reasoning-only' }),
    client,
  )(await imageBytes(), new AbortController().signal);
  assert.deepEqual(result.objects, [
    {
      id: 'led_1',
      type: 'led',
      bbox: [10, 20, 20, 20],
      interpretation: 'confirmed',
      localizationSource: 'muse',
      geometryStatus: 'box_only',
      guidanceEligible: false,
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(result.provenance.segmentationModel, undefined);
});

test('unsupported categories, invalid boxes and truncated Muse completions fail closed', async () => {
  for (const response of [
    completion({
      objects: [
        {
          type: 'capacitor',
          box: [1, 1, 5, 5],
          color: null,
          interpretation: 'confirmed',
        },
      ],
    }),
    completion({
      objects: [
        {
          type: 'led',
          box: [500, 0, 100, 100],
          color: null,
          interpretation: 'confirmed',
        },
      ],
    }),
    {
      choices: [
        { finish_reason: 'length', message: { content: '{"objects":[]}' } },
      ],
    },
  ]) {
    const { client } = queuedClient([response]);
    await assert.rejects(
      createVisionService(
        testConfig({ VISION_MODE: 'reasoning-only' }),
        client,
      )(await imageBytes(), new AbortController().signal),
      code('INVALID_PROVIDER_OUTPUT'),
    );
  }
});

test('deduplication retains highest confidence without merging different categories', () => {
  assert.equal(
    deduplicate([
      { type: 'led', bbox: [1, 1, 10, 10], confidence: 0.5 },
      { type: 'led', bbox: [1, 1, 10, 10], confidence: 0.9 },
      { type: 'resistor', bbox: [1, 1, 10, 10] },
    ]).length,
    2,
  );
});
