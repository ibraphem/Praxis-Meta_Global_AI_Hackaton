import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMetaClient } from '../src/lib/meta-client.js';
import { AppError } from '../src/lib/errors.js';
import { loadConfig } from '../src/config.js';
import { testConfig } from './helpers.js';

const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;

test('configuration fails safely for missing credentials, unsafe endpoints and public unauthenticated hosts', () => {
  for (const overrides of [
    { META_API_KEY: '' },
    { META_BASE_URL: 'http://api.meta.ai/v1' },
    { META_BASE_URL: 'https://user:secret@api.meta.ai/v1' },
    { HOST: '0.0.0.0' },
    { NODE_ENV: 'production' },
    { VISION_MODE: 'auto-fallback' },
    { MAX_UPLOAD_BYTES: '-1' },
  ])
    assert.throws(() => testConfig(overrides));
  assert.throws(
    () => loadConfig({ META_API_KEY: 'secret-key', PORT: 'invalid' }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes('secret-key'),
  );
  assert.doesNotThrow(() =>
    testConfig({ NODE_ENV: 'production', PRAXIS_API_TOKEN: 'a'.repeat(32) }),
  );
});

test('HTTP adapter sends only configured endpoints, server auth, and disables redirects', async () => {
  const client = createMetaClient(testConfig(), async (url, options) => {
    assert.equal(url, 'https://api.meta.ai/v1/responses');
    assert.equal(options?.redirect, 'error');
    assert.equal(
      (options?.headers as Record<string, string>).Authorization,
      'Bearer test-provider-key',
    );
    return Response.json({ ok: true });
  });
  assert.deepEqual(
    await client.post(
      'responses',
      { model: 'sam-3.1' },
      new AbortController().signal,
    ),
    { ok: true },
  );
});

test('transient failures retry within the configured bound', async () => {
  let calls = 0;
  const client = createMetaClient(testConfig(), async () =>
    ++calls === 1
      ? Response.json({}, { status: 503 })
      : Response.json({ ok: true }),
  );
  await client.post('responses', {}, new AbortController().signal);
  assert.equal(calls, 2);
});

test('account/model failures do not retry or disclose provider response bodies', async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    const client = createMetaClient(testConfig(), async () => {
      calls++;
      return Response.json({ secret: 'provider-debug-secret' }, { status });
    });
    await assert.rejects(
      client.post('responses', {}, new AbortController().signal),
      (error: unknown) =>
        error instanceof AppError &&
        !error.message.includes('provider-debug-secret') &&
        error.statusCode >= 500,
    );
    assert.equal(calls, 1);
  }
});

test('invalid JSON, non-JSON content and oversized responses fail closed', async () => {
  for (const response of [
    new Response('{', { headers: { 'content-type': 'application/json' } }),
    new Response('<html>error</html>', {
      headers: { 'content-type': 'text/html' },
    }),
    new Response('x'.repeat(16 * 1024 * 1024 + 1), {
      headers: { 'content-type': 'application/json' },
    }),
  ]) {
    const client = createMetaClient(testConfig(), async () => response);
    await assert.rejects(
      client.post('responses', {}, new AbortController().signal),
      code('INVALID_PROVIDER_OUTPUT'),
    );
  }
});

test('provider timeout aborts inference and maps to a safe gateway timeout', async () => {
  const client = createMetaClient(
    testConfig({ PROVIDER_TIMEOUT_MS: '10', PROVIDER_MAX_RETRIES: '0' }),
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => reject(new Error('network timeout')),
          { once: true },
        );
      }),
  );
  // AbortSignal.timeout uses unref'd timers; keep the test alive until it fires.
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    await assert.rejects(
      client.post('responses', {}, new AbortController().signal),
      code('PROVIDER_TIMEOUT'),
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test('caller cancellation does not retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createMetaClient(testConfig(), async () => {
    calls++;
    controller.abort();
    throw new Error('cancelled');
  });
  await assert.rejects(
    client.post('responses', {}, controller.signal),
    code('REQUEST_CANCELLED'),
  );
  assert.equal(calls, 1);
});

test('optional refinement has a shorter operation deadline and never retries transient failures', async () => {
  let calls = 0;
  const config = testConfig({
    PROVIDER_TIMEOUT_MS: '200',
    PROVIDER_MAX_RETRIES: '2',
  });
  const client = createMetaClient(config, async (_url, options) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => reject(options.signal?.reason),
        { once: true },
      );
    });
  });
  // The production timer is unref'd; keep this synthetic fetch alive until abort.
  const keepAlive = setInterval(() => undefined, 100);
  try {
    await assert.rejects(
      client.post(
        'responses',
        { model: 'sam-3.1' },
        new AbortController().signal,
        { stage: 'sam.wire_refine', timeoutMs: 10, maxRetries: 0 },
      ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'PROVIDER_TIMEOUT' &&
        error.details?.timeoutMs === 10 &&
        error.details.stage === 'sam.wire_refine' &&
        error.details.attempt === 1,
    );
    assert.equal(calls, 1);
  } finally {
    clearInterval(keepAlive);
  }
});
