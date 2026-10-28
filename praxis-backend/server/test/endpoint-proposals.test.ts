import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import { createEndpointProposalService } from '../src/services/endpoint-proposals.js';
import {
  completion,
  imageBytes,
  multipartBody,
  queuedClient,
  testConfig,
} from './helpers.js';

const context = {
  analysisId: 'analysis-1',
  imageId: 'photo-1',
  image: { width: 100, height: 80 },
  wire: {
    id: 'jumper_wire_1',
    bbox: [10, 10, 20, 20],
    mask: {
      format: 'svg_path',
      width: 20,
      height: 20,
      path: 'M1 1L3 1L3 18L1 18Z',
    },
  },
};
const endpoints = [
  {
    role: 'A',
    proposedImagePosition: [11.5, 22],
    evidence: 'visible_insertion',
  },
  { role: 'B', proposedImagePosition: null, evidence: 'occluded' },
];
function upload(bytes: Buffer, data: unknown = context) {
  return multipartBody(
    bytes,
    'image',
    `--praxis-test-boundary\r\nContent-Disposition: form-data; name="context"\r\n\r\n${JSON.stringify(data)}\r\n`,
  );
}

test('Muse proposes original image pixels and evidence only, with selection provenance', async () => {
  const { client, calls } = queuedClient([completion({ endpoints })]);
  const service = createEndpointProposalService(testConfig(), client);
  const result = await service(
    await imageBytes(),
    new AbortController().signal,
    undefined,
    context,
  );
  assert.deepEqual(result, {
    analysisId: 'analysis-1',
    imageId: 'photo-1',
    wireCandidateId: 'jumper_wire_1',
    model: 'muse-spark-1.3',
    endpoints,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, 'chat/completions');
  const payload = JSON.stringify(calls[0]!.body);
  assert.match(payload, /original-image/);
  assert.match(payload, /never return board IDs or hole IDs/);
  assert.match(payload, /M1 1L3 1L3 18L1 18Z/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /holeId|electricalContact|confirmed/,
  );
});

test('invalid roles, fabricated hole IDs, out-of-image pixels and hidden guessed positions fail closed', async () => {
  for (const output of [
    [{ ...endpoints[0], role: 'B' }, endpoints[1]],
    [{ ...endpoints[0], holeId: 'e14' }, endpoints[1]],
    [{ ...endpoints[0], proposedImagePosition: [100, 20] }, endpoints[1]],
    [{ ...endpoints[0], evidence: 'occluded' }, endpoints[1]],
    [{ ...endpoints[0], proposedImagePosition: [-1, 20] }, endpoints[1]],
  ]) {
    const { client } = queuedClient([completion({ endpoints: output })]);
    await assert.rejects(
      () =>
        createEndpointProposalService(testConfig(), client)(
          imageBytesBuffer!,
          new AbortController().signal,
          undefined,
          context,
        ),
      (error: unknown) =>
        error instanceof AppError && error.code === 'INVALID_PROVIDER_OUTPUT',
    );
  }
});
let imageBytesBuffer: Buffer;
test.before(async () => {
  imageBytesBuffer = await imageBytes();
});

test('invalid wire context and mismatched image dimensions are rejected before inference', async () => {
  const { client, calls } = queuedClient([]);
  const service = createEndpointProposalService(testConfig(), client);
  for (const data of [
    undefined,
    { ...context, holeId: 'a1' },
    { ...context, image: { width: 999, height: 80 } },
    { ...context, wire: { ...context.wire, id: 'led_1' } },
  ])
    await assert.rejects(
      () =>
        service(
          imageBytesBuffer,
          new AbortController().signal,
          undefined,
          data,
        ),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    );
  assert.equal(calls.length, 0);
});

test('endpoint HTTP multipart route uses authentication and returns no-store validated suggestions', async (t) => {
  const token = 'endpoint-test-token-at-least-32-characters';
  const config = testConfig({ PRAXIS_API_TOKEN: token });
  const { client } = queuedClient([completion({ endpoints })]);
  const app = await buildApp(
    config,
    undefined,
    undefined,
    createEndpointProposalService(config, client),
  );
  t.after(() => app.close());
  const request = upload(imageBytesBuffer);
  const unauthorized = await app.inject({
    method: 'POST',
    url: '/api/vision/endpoints',
    ...request,
  });
  assert.equal(unauthorized.statusCode, 401);
  const response = await app.inject({
    method: 'POST',
    url: '/api/vision/endpoints',
    ...request,
    headers: { ...request.headers, authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().endpoints, endpoints);
  assert.equal(response.headers['cache-control'], 'no-store');
  const missing = await app.inject({
    method: 'POST',
    url: '/api/vision/endpoints',
    ...multipartBody(imageBytesBuffer),
    headers: { ...request.headers, authorization: `Bearer ${token}` },
  });
  assert.equal(missing.statusCode, 400);
});

test('endpoint and analysis routes share capacity and release it after completion', async (t) => {
  const config = testConfig({ MAX_CONCURRENT_ANALYSES: '1' });
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = await buildApp(config, undefined, undefined, async () => {
    entered();
    await pending;
    return {
      analysisId: context.analysisId,
      imageId: context.imageId,
      wireCandidateId: context.wire.id,
      model: 'muse',
      endpoints: endpoints as [
        {
          role: 'A';
          proposedImagePosition: [number, number];
          evidence: 'visible_insertion';
        },
        { role: 'B'; proposedImagePosition: null; evidence: 'occluded' },
      ],
    };
  });
  t.after(() => app.close());
  const first = app.inject({
    method: 'POST',
    url: '/api/vision/endpoints',
    ...upload(imageBytesBuffer),
  });
  await started;
  const busy = await app.inject({
    method: 'POST',
    url: '/api/vision/analyze',
    ...multipartBody(imageBytesBuffer),
  });
  assert.equal(busy.statusCode, 503);
  release();
  assert.equal((await first).statusCode, 200);
});
