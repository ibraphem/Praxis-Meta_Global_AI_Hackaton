import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  frozenSceneTruthSchema,
  sceneTruthHash,
  type SceneTruth,
} from '../src/services/scene-evaluation.js';
import { imageBytes } from './helpers.js';

test('annotation freeze binds exact photo bytes and truth, refuses assistant truth and preserves existing files', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-truth-freeze-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const photo = join(dir, 'photo.png'),
    truthPath = join(dir, 'truth.json'),
    output = join(dir, 'freeze.json');
  const bytes = await imageBytes(100, 80);
  writeFileSync(photo, bytes);
  // Synthetic annotations exercise the artifact workflow, not photographic accuracy.
  const truth: SceneTruth = {
    version: 'scene-truth-v1',
    imageHash: createHash('sha256').update(bytes).digest('hex'),
    source: 'human_visual',
    inventoryComplete: true,
    attachmentsComplete: true,
    terminalTolerancePx: 4,
    objects: [{ id: 'synthetic', label: 'fixture' }],
    terminals: [],
    attachments: [],
  };
  writeFileSync(truthPath, JSON.stringify(truth));
  const run = (target = output) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/freeze-scene-truth.ts',
        photo,
        truthPath,
        target,
      ],
      { encoding: 'utf8' },
    );
  const before = Date.now();
  assert.equal(run().status, 0);
  const saved = readFileSync(output, 'utf8'),
    freeze = frozenSceneTruthSchema.parse(JSON.parse(saved));
  assert.equal(freeze.imageHash, truth.imageHash);
  assert.equal(freeze.truthHash, sceneTruthHash(truth));
  assert.ok(freeze.frozenAt >= before && freeze.frozenAt <= Date.now());
  assert.equal(run().status, 1);
  assert.equal(readFileSync(output, 'utf8'), saved);
  truth.source = 'assistant_visual';
  writeFileSync(truthPath, JSON.stringify(truth));
  assert.equal(run(join(dir, 'assistant.json')).status, 1);
  assert.equal(existsSync(join(dir, 'assistant.json')), false);
  truth.source = 'human_visual';
  writeFileSync(truthPath, JSON.stringify(truth));
  writeFileSync(photo, Buffer.from('different photo'));
  assert.equal(run(join(dir, 'mismatch.json')).status, 1);
  assert.equal(existsSync(join(dir, 'mismatch.json')), false);
});
