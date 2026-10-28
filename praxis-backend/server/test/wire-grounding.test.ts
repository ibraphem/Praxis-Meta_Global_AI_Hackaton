import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  renderWireGrounding,
  type GroundingWire,
} from '../src/services/wire-grounding.js';

const mask: GroundingWire['mask'] = {
  format: 'svg_path',
  width: 10,
  height: 10,
  path: 'M0 0L10 0L0 10Z',
};
const selected: GroundingWire = { bbox: [10, 10, 20, 20], mask };
const neighbor: GroundingWire = {
  bbox: [50, 10, 20, 20],
  mask: { ...mask, path: 'M0 0L10 0L10 10L0 10Z' },
};

test('grounding keeps pixel alignment and highlights mask geometry rather than its bounding rectangle', async () => {
  const original = await sharp({
    create: { width: 100, height: 80, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  const image = {
    width: 100,
    height: 80,
    dataUrl: `data:image/png;base64,${original.toString('base64')}`,
  };
  const before = JSON.stringify(image);
  const result = await renderWireGrounding(image, selected, [neighbor]);
  assert.equal(result.width, 100);
  assert.equal(result.height, 80);
  const { data, info } = await sharp(
    Buffer.from(result.dataUrl.split(',')[1]!, 'base64'),
  )
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 100);
  assert.equal(info.height, 80);
  const rgb = (x: number, y: number) => [
    ...data.subarray(
      (y * info.width + x) * info.channels,
      (y * info.width + x) * info.channels + 3,
    ),
  ];
  const mean = (x: number, y: number) =>
    rgb(x, y).reduce((sum, value) => sum + value, 0) / 3;
  assert.ok(
    mean(14, 14) > mean(40, 40) + 30,
    'selected mask retains bright pixels',
  );
  assert.ok(
    mean(60, 20) < mean(40, 40) - 30,
    'neighbor mask is further deemphasized',
  );
  assert.ok(
    Math.abs(mean(28, 28) - mean(40, 40)) < 15,
    'unmasked triangle corner stays background, not a filled box',
  );
  assert.ok(rgb(14, 14)[1]! > rgb(14, 14)[0]!, 'cyan emphasis is visible');
  assert.equal(JSON.stringify(image), before, 'original image is untouched');
});

test('selected pixels take precedence where other wire masks cross them', async () => {
  const bytes = await sharp({
    create: { width: 100, height: 80, channels: 3, background: '#ffffff' },
  })
    .jpeg()
    .toBuffer();
  const image = {
    width: 100,
    height: 80,
    dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
  };
  const result = await renderWireGrounding(image, selected, [
    { ...neighbor, bbox: [0, 0, 80, 60] },
  ]);
  const { data, info } = await sharp(
    Buffer.from(result.dataUrl.split(',')[1]!, 'base64'),
  )
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mean = (x: number, y: number) =>
    [
      ...data.subarray(
        (y * info.width + x) * info.channels,
        (y * info.width + x) * info.channels + 3,
      ),
    ].reduce((a, b) => a + b, 0) / 3;
  assert.ok(mean(14, 14) > mean(40, 40) + 80);
});
