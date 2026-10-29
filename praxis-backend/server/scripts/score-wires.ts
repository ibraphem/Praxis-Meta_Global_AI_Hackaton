import { readFileSync, writeFileSync } from 'node:fs';
import { recoveryReportSchema } from '../src/schemas/wire-recovery.js';
import {
  evaluateWires,
  wireTruthSchema,
} from '../src/services/wire-evaluation.js';
const usage =
  'Usage: npm run wire:score -- REPORT.json TRUTH.json EVALUATION.json NEW_SCORE.json\nOffline only; refuses to overwrite an existing score.';
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log(usage);
  else {
    if (args.length !== 4) throw new Error(usage);
    const read = (path: string) =>
      JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const report = recoveryReportSchema.parse(read(args[0]!)),
      truth = wireTruthSchema.parse(read(args[1]!));
    const score = evaluateWires(report, truth.imageHash, truth, read(args[2]!));
    writeFileSync(args[3]!, JSON.stringify(score, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.table(score.metrics);
    console.log(`Acceptance targets met on this image: ${score.targetsMet}`);
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Wire scoring failed.',
  );
  process.exitCode = 1;
}
