import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateAutomaticTargetingReport } from '../src/services/automatic-targeting-evaluation.js';
import { boundaryProfileSchema } from '../src/services/connector-boundary.js';
import type { runConnectorExperiment } from '../src/jobs/scene-connector-experiment.js';
try {
  const args = process.argv.slice(2);
  if (args.length !== 3)
    throw Error(
      'Usage: npm run scene:score-targeting -- REPORT.json FROZEN_PROFILE.json NEW_OUTPUT.json',
    );
  const report = JSON.parse(readFileSync(args[0]!, 'utf8')) as Awaited<
    ReturnType<typeof runConnectorExperiment>
  >;
  const profile = boundaryProfileSchema.parse(
    JSON.parse(readFileSync(args[1]!, 'utf8')),
  );
  const result = evaluateAutomaticTargetingReport(report, profile);
  writeFileSync(args[2]!, JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    'Saved offline targeting evaluation. No inference or production changes.',
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Targeting evaluation failed.',
  );
  process.exitCode = 1;
}
