import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  frozenSceneTruthSchema,
  sceneTruthHash,
  sceneTruthSchema,
} from '../src/services/scene-evaluation.js';

try {
  const args = process.argv.slice(2);
  if (args.length !== 3)
    throw new Error(
      'Usage: npm run scene:freeze-truth -- ORIGINAL_PHOTO TRUTH.json NEW_FREEZE.json',
    );
  const truth = sceneTruthSchema.parse(
    JSON.parse(readFileSync(args[1]!, 'utf8')),
  );
  const imageHash = createHash('sha256')
    .update(readFileSync(args[0]!))
    .digest('hex');
  if (truth.imageHash !== imageHash || truth.source === 'assistant_visual')
    throw new Error(
      'Freeze requires matching original photo bytes and independent annotations.',
    );
  const frozen = frozenSceneTruthSchema.parse({
    version: 'scene-truth-freeze-v1',
    imageHash,
    truthHash: sceneTruthHash(truth),
    frozenAt: Date.now(),
  });
  writeFileSync(args[2]!, JSON.stringify(frozen, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    'Saved annotation freeze. Keep this file and the original annotations unchanged before inference. No model requests were made.',
  );
} catch (error) {
  console.error(
    error instanceof Error && /^(Usage:|Freeze requires)/.test(error.message)
      ? error.message
      : 'Annotation freeze failed. Check the photo, truth format and unused output path.',
  );
  process.exitCode = 1;
}
