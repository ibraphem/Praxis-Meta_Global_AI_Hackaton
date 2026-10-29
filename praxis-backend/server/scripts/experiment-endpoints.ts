import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs/store.js';
import {
  runEndpointExperiment,
  type GroundingVariant,
} from '../src/jobs/endpoint-experiment.js';
const usage =
  'Usage: npm run experiment:endpoints -- ANALYSIS_ID BUNDLE.json NEW_DIRECTORY [--variants full,candidate_crop] [--concurrency 1|2] [--runs 1|2|3] [--coordinates pixels|normalized_1000]\nLIVE MODEL EXPERIMENT: at most 30 planned requests, no automatic retries. Frozen inputs and saved predictions are preserved. Ground truth is never read by this runner.';
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log(usage);
  else {
    if (args.length < 3 || (args.length - 3) % 2) throw new Error(usage);
    const opts: Record<string, string> = {};
    for (let i = 3; i < args.length; i += 2) {
      if (
        !['--variants', '--concurrency', '--runs', '--coordinates'].includes(
          args[i]!,
        ) ||
        opts[args[i]!]
      )
        throw new Error(usage);
      opts[args[i]!] = args[i + 1]!;
    }
    const variants = (opts['--variants'] ?? 'full,candidate_crop').split(
        ',',
      ) as GroundingVariant[],
      concurrency = Number(opts['--concurrency'] ?? 1),
      coordinates = opts['--coordinates'] ?? 'pixels';
    if (
      variants.some(
        (v) => !['full', 'candidate_crop', 'endpoint_crops'].includes(v),
      ) ||
      ![1, 2].includes(concurrency) ||
      !['pixels', 'normalized_1000'].includes(coordinates)
    )
      throw new Error(usage);
    const bytes = readFileSync(args[1]!);
    mkdirSync(args[2]!, { mode: 0o700 });
    const store = new JobStore(loadConfig()),
      controller = new AbortController(),
      stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const report = await runEndpointExperiment(store, args[0]!, bytes, {
        variants,
        concurrency: concurrency as 1 | 2,
        runs: Number(opts['--runs'] ?? 1),
        coordinateSpace: coordinates as 'pixels' | 'normalized_1000',
        signal: controller.signal,
        onProgress: (report) => {
          const temp = join(args[2]!, 'progress.tmp');
          writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', {
            mode: 0o600,
          });
          renameSync(temp, join(args[2]!, 'report.json'));
        },
      });
      console.table(report.batches);
      console.table(
        report.measurements.map((m) => ({
          variant: m.variant,
          run: m.run,
          wire: m.wireCandidateId,
          execution: m.outcomes.execution,
          localization: m.outcomes.localization,
          endpointA: m.outcomes.endpoints[0]?.status,
          endpointB: m.outcomes.endpoints[1]?.status,
          providerRequests: m.outcomes.providerRequests.length,
        })),
      );
      console.log(
        'Execution and localization outcomes are not accuracy scores. Use benchmark:grounding with blinded truth.',
      );
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      store.close();
    }
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Endpoint experiment failed.',
  );
  process.exitCode = 1;
}
