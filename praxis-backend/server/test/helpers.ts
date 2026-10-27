import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import type { EncodedMask } from '../src/schemas/geometry.js';
import { loadConfig } from '../src/config.js';
import type { MetaClient } from '../src/lib/meta-client.js';

export function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    META_API_KEY: 'test-provider-key',
    // Ordered fixtures use serial calls; concurrency behavior has dedicated tests.
    SAM_CONCURRENCY: '1',
    ...overrides,
  });
}

/** Generated pixels test the upload transport, not real-world detection accuracy. */
export function imageBytes(width = 100, height = 80) {
  return sharp({
    create: { width, height, channels: 3, background: '#ffffff' },
  })
    .jpeg()
    .toBuffer();
}

export function multipartBody(bytes: Buffer, field = 'image', extra = '') {
  const boundary = 'praxis-test-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n${extra}--${boundary}--\r\n`),
    ]),
  };
}

export const samEnvelope = (text: string) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
});
export const completion = (content: unknown) => ({
  choices: [
    { finish_reason: 'stop', message: { content: JSON.stringify(content) } },
  ],
});

export function queuedClient(responses: unknown[]) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const client: MetaClient = {
    async post(path, body) {
      calls.push({ path, body });
      if (!responses.length) throw new Error('Unexpected provider call');
      return responses.shift();
    },
  };
  return { client, calls };
}

// Opaque mask data is intentionally not decoded by the box-only adapter.
export const samRecord =
  '<0f>7<|box;x1=10;y1=20;x2=29;y2=39;w=100;h=80;c=0.91|><|mask;x=0;y=0;c=0.91;data=20,20,!opaque|>';

// Synthetic conformance data, generated once with the official codec. No user images.
const masks = JSON.parse(
  readFileSync(new URL('./fixtures/masks.json', import.meta.url), 'utf8'),
) as Record<'wire' | 'blob' | 'split' | 'empty' | 'branch', EncodedMask>;
export function maskFixture(kind: keyof typeof masks = 'wire'): EncodedMask {
  return masks[kind];
}
export function samWireRecord(
  kind: keyof typeof masks = 'wire',
  id = 7,
): string {
  const mask = maskFixture(kind);
  return `<0f>${id}<|box;x1=10;y1=20;x2=29;y2=39;w=100;h=80;c=0.91|><|mask;x=0;y=0;c=0.91;data=${mask.height},${mask.width},${mask.payload}|>`;
}
