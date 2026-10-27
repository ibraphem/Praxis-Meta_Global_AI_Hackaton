import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import { createVisionService } from '../src/services/vision.js';
import {
  completion,
  imageBytes,
  multipartBody,
  queuedClient,
  testConfig,
} from './helpers.js';

const token = 'praxis-test-token-at-least-32-characters';
const empty = {
  image: { width: 100, height: 80 },
  objects: [],
  provenance: {
    mode: 'reasoning-only' as const,
    reasoningModel: 'muse-spark-1.3',
  },
};

test('HTTP upload flows through decoding and provider adapter to validated JSON', async (t) => {
  const config = testConfig({
    VISION_MODE: 'reasoning-only',
    PRAXIS_API_TOKEN: token,
  });
  const { client } = queuedClient([
    completion({
      objects: [
        {
          type: 'resistor',
          box: [0, 0, 1000, 1000],
          color: null,
          interpretation: 'confirmed',
        },
      ],
    }),
  ]);
  const app = await buildApp(config, createVisionService(config, client));
  t.after(() => app.close());
  const request = multipartBody(await imageBytes());
  const response = await app.inject({
    method: 'POST',
    url: '/api/vision/analyze',
    ...request,
    headers: { ...request.headers, authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().objects[0].bbox, [0, 0, 100, 80]);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(response.headers['x-content-type-options']);
  assert.ok(response.headers['x-request-id']);
});

test('authentication and browser-origin checks happen before inference', async (t) => {
  let calls = 0;
  const app = await buildApp(
    testConfig({ PRAXIS_API_TOKEN: token }),
    async () => {
      calls++;
      return empty;
    },
  );
  t.after(() => app.close());
  const unauthorized = await app.inject({
    method: 'POST',
    url: '/api/vision/analyze',
  });
  assert.equal(unauthorized.statusCode, 401);
  const crossOrigin = await app.inject({
    method: 'POST',
    url: '/api/vision/analyze',
    headers: {
      authorization: `Bearer ${token}`,
      origin: 'https://untrusted.example',
    },
  });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(calls, 0);
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
});

test('reject missing image, wrong field, extra fields, duplicate files and non-multipart', async (t) => {
  let calls = 0;
  const app = await buildApp(testConfig(), async () => {
    calls++;
    return empty;
  });
  t.after(() => app.close());
  const bytes = await imageBytes();
  const requests = [
    { headers: { 'content-type': 'application/json' }, payload: '{}' },
    {
      headers: {
        'content-type': 'multipart/form-data; boundary=praxis-test-boundary',
      },
      payload: '--praxis-test-boundary--\r\n',
    },
    multipartBody(bytes, 'file'),
    multipartBody(
      bytes,
      'image',
      '--praxis-test-boundary\r\nContent-Disposition: form-data; name="extra"\r\n\r\nvalue\r\n',
    ),
    multipartBody(
      bytes,
      'image',
      '--praxis-test-boundary\r\nContent-Disposition: form-data; name="image"; filename="other.jpg"\r\nContent-Type: image/jpeg\r\n\r\nbytes\r\n',
    ),
  ];
  for (const request of requests) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/vision/analyze',
      ...request,
    });
    assert.ok(
      response.statusCode >= 400 && response.statusCode < 500,
      response.body,
    );
  }
  assert.equal(calls, 0);
});

test('oversized uploads fail before inference', async (t) => {
  const app = await buildApp(
    testConfig({ MAX_UPLOAD_BYTES: '64' }),
    async () => {
      throw new Error('Must not analyze');
    },
  );
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/vision/analyze',
    ...multipartBody(await imageBytes()),
  });
  assert.equal(response.statusCode, 413, response.body);
});

test('malformed multipart yields a client error', async (t) => {
  const app = await buildApp(testConfig(), async () => empty);
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/vision/analyze',
    headers: { 'content-type': 'multipart/form-data; boundary=broken' },
    payload: 'not-multipart',
  });
  assert.equal(response.statusCode, 400, response.body);
});

test('concurrent requests are bounded and capacity is released after errors', async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const app = await buildApp(
    testConfig({ MAX_CONCURRENT_ANALYSES: '1' }),
    async () => {
      count++;
      if (count === 1) {
        entered();
        await pending;
        throw new AppError(502, 'PROVIDER_ERROR', 'Provider failed.');
      }
      return empty;
    },
  );
  t.after(() => app.close());
  const request = multipartBody(await imageBytes());
  const first = app.inject({
    method: 'POST',
    url: '/api/vision/analyze',
    ...request,
  });
  await started;
  const second = await app.inject({
    method: 'POST',
    url: '/api/vision/analyze',
    ...request,
  });
  assert.equal(second.statusCode, 503);
  assert.equal(second.json().error.code, 'SERVER_BUSY');
  release();
  assert.equal((await first).statusCode, 502);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/vision/analyze',
        ...request,
      })
    ).statusCode,
    200,
  );
});

test('rate limiting bounds repeated requests', async (t) => {
  const app = await buildApp(
    testConfig({ RATE_LIMIT_MAX: '1' }),
    async () => empty,
  );
  t.after(() => app.close());
  const request = multipartBody(await imageBytes());
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/vision/analyze',
        ...request,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/vision/analyze',
        ...request,
      })
    ).statusCode,
    429,
  );
});

test('unexpected errors do not leak secrets, filenames, stacks or provider text', async (t) => {
  const app = await buildApp(testConfig(), async () => {
    throw new Error('secret-provider-key private.jpg');
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/vision/analyze',
    ...multipartBody(await imageBytes()),
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(response.body, /secret|private\.jpg|stack/);
});

test('overall deadline cancels analysis and releases its capacity slot', async (t) => {
  let calls = 0;
  const app = await buildApp(
    testConfig({ ANALYSIS_TIMEOUT_MS: '20', MAX_CONCURRENT_ANALYSES: '1' }),
    async (_bytes, signal) => {
      calls++;
      if (calls > 1) return empty;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
  );
  t.after(() => app.close());
  const request = multipartBody(await imageBytes());
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/vision/analyze',
      ...request,
    });
    assert.equal(response.statusCode, 504);
    assert.equal(response.json().error.code, 'ANALYSIS_TIMEOUT');
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/vision/analyze',
          ...request,
        })
      ).statusCode,
      200,
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
