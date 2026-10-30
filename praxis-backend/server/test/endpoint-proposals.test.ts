import { RUNTIME } from '../src/lib/runtime.js';
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
    connectorJunctionPosition: [11.5, 18],
    evidence: 'visible_insertion',
  },
  {
    role: 'B',
    proposedImagePosition: null,
    connectorJunctionPosition: [40, 50],
    evidence: 'occluded_insertion',
  },
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
    runtime: RUNTIME,
    endpoints,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, 'chat/completions');
  const payload = JSON.stringify(calls[0]!.body);
  assert.match(payload, /original-image/);
  assert.match(payload, /never return board IDs or hole IDs/);
  assert.doesNotMatch(payload, /M1 1L3 1L3 18L1 18Z/);
  const messages = calls[0]!.body.messages as { content: unknown }[];
  const content = messages[1]!.content as {
    type: string;
    image_url?: { url: string };
  }[];
  assert.equal(content.filter((part) => part.type === 'image_url').length, 2);
  assert.notEqual(
    content.filter((part) => part.type === 'image_url')[0]!.image_url!.url,
    content.filter((part) => part.type === 'image_url')[1]!.image_url!.url,
  );
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
    [{ ...endpoints[0], evidence: 'occluded_insertion' }, endpoints[1]],
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
          connectorJunctionPosition: [number, number] | null;
          evidence: 'visible_insertion';
        },
        {
          role: 'B';
          proposedImagePosition: null;
          connectorJunctionPosition: [number, number] | null;
          evidence: 'occluded_insertion';
        },
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

test('connector junctions are returned separately while hidden insertion points stay null', async () => {
  const output = [
    {
      role: 'A',
      proposedImagePosition: null,
      connectorJunctionPosition: [12, 20],
      evidence: 'visible_connector_junction',
    },
    {
      role: 'B',
      proposedImagePosition: null,
      connectorJunctionPosition: [40, 50],
      evidence: 'occluded_insertion',
    },
  ];
  const { client } = queuedClient([completion({ endpoints: output })]);
  const result = await createEndpointProposalService(testConfig(), client)(
    imageBytesBuffer,
    new AbortController().signal,
    undefined,
    context,
  );
  assert.deepEqual(result.endpoints, output);
  assert.ok(
    result.endpoints.every(
      (endpoint) => endpoint.proposedImagePosition === null,
    ),
  );
});

test('insertion evidence and positions must agree, and junction coordinates are bounded', async () => {
  for (const endpoint of [
    { ...endpoints[0], evidence: 'visible_connector_junction' },
    { ...endpoints[0], proposedImagePosition: null },
    {
      ...endpoints[0],
      proposedImagePosition: null,
      evidence: 'visible_connector_junction',
      connectorJunctionPosition: null,
    },
    { ...endpoints[0], connectorJunctionPosition: [100, 50] },
    { ...endpoints[0], connectorJunctionPosition: [-1, 50] },
  ]) {
    const { client } = queuedClient([
      completion({ endpoints: [endpoint, endpoints[1]] }),
    ]);
    await assert.rejects(
      () =>
        createEndpointProposalService(testConfig(), client)(
          imageBytesBuffer,
          new AbortController().signal,
          undefined,
          context,
        ),
      (error: unknown) =>
        error instanceof AppError && error.code === 'INVALID_PROVIDER_OUTPUT',
    );
  }
});

test('grounding validates neighboring wire identities, image bounds and safe SVG geometry before inference', async () => {
  const { client, calls } = queuedClient([]);
  for (const otherWires of [
    [context.wire],
    [{ ...context.wire, id: 'jumper_wire_2', bbox: [90, 10, 20, 20] }],
    [
      {
        ...context.wire,
        id: 'jumper_wire_2',
        mask: { ...context.wire.mask, path: '<script>alert(1)</script>' },
      },
    ],
  ]) {
    await assert.rejects(
      () =>
        createEndpointProposalService(testConfig(), client)(
          imageBytesBuffer,
          new AbortController().signal,
          undefined,
          { ...context, otherWires },
        ),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    );
  }
  assert.equal(calls.length, 0);
});

test('one endpoint request uses one bounded Muse attempt and includes original plus annotated pixels', async () => {
  let requests = 0;
  const service = createEndpointProposalService(testConfig(), {
    async post(_path, body, _signal, operation) {
      requests++;
      assert.equal(operation?.stage, 'muse.endpoints');
      assert.equal(operation?.maxRetries, 0);
      const messages = body.messages as { content: unknown }[];
      const parts = messages[1]!.content as {
        type: string;
        image_url?: { url: string };
      }[];
      const images = parts.filter((part) => part.type === 'image_url');
      assert.equal(images.length, 2);
      const sharp = (await import('sharp')).default;
      for (const image of images) {
        const metadata = await sharp(
          Buffer.from(image.image_url!.url.split(',')[1]!, 'base64'),
        ).metadata();
        assert.equal(metadata.width, 100);
        assert.equal(metadata.height, 80);
      }
      return completion({ endpoints });
    },
  });
  await service(imageBytesBuffer, new AbortController().signal, undefined, {
    ...context,
    otherWires: [
      { ...context.wire, id: 'jumper_wire_2', bbox: [50, 10, 20, 20] },
    ],
  });
  assert.equal(requests, 1);
});

test('focused endpoint crops preserve raw coordinates and map both insertion and junction back to original pixels', async () => {
  const data = {
    ...context,
    image: { width: 2048, height: 1200 },
    wire: { ...context.wire, bbox: [300, 300, 1700, 300] },
    view: 'candidate_crop',
    gridPoints: [
      [300, 300],
      [2000, 600],
    ],
  };
  let dimensions: { width: number; height: number }[] = [];
  const service = createEndpointProposalService(testConfig(), {
    async post(_path, body, _signal, op) {
      dimensions = op!.imageDimensions!;
      assert.equal(op!.maxRetries, 0);
      assert.equal(dimensions.length, 4);
      assert.equal(dimensions[0]!.width, 1600);
      assert.deepEqual(dimensions[0], dimensions[1]);
      const prompt = JSON.stringify(body);
      assert.match(prompt, /local-crop/);
      assert.match(prompt, /artificial calibrated grid/);
      assert.match(prompt, /crop boundary is not/);
      return completion({ endpoints });
    },
  });
  const result = await service(
    await imageBytes(2048, 1200),
    new AbortController().signal,
    undefined,
    data,
  );
  assert.equal(result.inputVariant, 'candidate_crop');
  const frame = result.inputFrame!;
  const expected = [
    frame.bbox[0] + (11.5 * frame.bbox[2]) / 1600,
    frame.bbox[1] + (22 * frame.bbox[3]) / frame.height,
  ];
  assert.deepEqual(result.endpoints[0]!.proposedImagePosition, expected);
  assert.deepEqual(
    (result.endpoints[0] as { sourceFramePosition?: unknown })
      .sourceFramePosition,
    [11.5, 22],
  );
  assert.equal(result.endpoints[1]!.proposedImagePosition, null);
  assert.deepEqual(result.endpoints[1]!.connectorJunctionPosition, [
    frame.bbox[0] + (40 * frame.bbox[2]) / 1600,
    frame.bbox[1] + (50 * frame.bbox[3]) / frame.height,
  ]);
  assert.deepEqual(dimensions[3], dimensions[0]);
});
