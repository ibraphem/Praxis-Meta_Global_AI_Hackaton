import { openSync, closeSync, ftruncateSync, writeSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs/store.js';
import { runMuseExperiment } from '../src/jobs/muse-experiment.js';
import { AppError } from '../src/lib/errors.js';

async function main() {
  const args = process.argv.slice(2);
  const usage =
    'Usage: npm run experiment:muse -- ANALYSIS_ID [--output NEW_REPORT.json]\n       npm run experiment:muse -- --release INTERRUPTED_EXPERIMENT_ID\nMakes three provider requests against an immutable checkpoint; no automatic retries.';
  if (args.includes('--help')) {
    console.log(usage);
    return;
  }
  const release = args[0] === '--release',
    outputIndex = args.indexOf('--output'),
    output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (
    release
      ? args.length !== 2
      : !args[0] ||
        (outputIndex >= 0 && !output) ||
        args.some((a, i) => i > 0 && a !== '--output' && i !== outputIndex + 1)
  )
    throw new Error(usage);
  const config = loadConfig(),
    store = new JobStore(config);
  let descriptor: number | undefined;
  let began = false;
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(
      new AppError(
        503,
        'EXPERIMENT_INTERRUPTED',
        'The experiment process was stopped.',
      ),
    );
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    if (release) {
      store.experiments.releaseInterrupted(args[1]!);
      console.log(
        'Interrupted reservation released explicitly. Upstream execution may still be running.',
      );
      return;
    }
    if (output) {
      descriptor = openSync(output, 'wx', 0o600);
      writeSync(
        descriptor,
        JSON.stringify({ status: 'not_started', analysisId: args[0] }) + '\n',
        0,
        'utf8',
      );
    }
    const report = await runMuseExperiment(store, args[0]!, config, {
      signal: controller.signal,
      onProgress: (report) => {
        began = true;
        if (descriptor !== undefined) {
          ftruncateSync(descriptor, 0);
          writeSync(
            descriptor,
            JSON.stringify(report, null, 2) + '\n',
            0,
            'utf8',
          );
        }
      },
    });
    for (const measurement of report.measurements)
      console.error(
        `${measurement.variant}: ${measurement.status} (${measurement.elapsedMs} ms)`,
      );
    if (descriptor === undefined)
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    if (descriptor !== undefined && !began) {
      ftruncateSync(descriptor, 0);
      writeSync(
        descriptor,
        JSON.stringify({
          status: 'not_started',
          analysisId: args[0],
          errorCode:
            error instanceof AppError ? error.code : 'EXPERIMENT_FAILED',
        }) + '\n',
        0,
        'utf8',
      );
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (descriptor !== undefined) closeSync(descriptor);
    store.close();
  }
}
main().catch((error) => {
  console.error(
    error instanceof AppError
      ? error.message
      : error instanceof Error &&
          (error.message.startsWith('Usage: ') ||
            error.message.startsWith('Invalid configuration fields: '))
        ? error.message
        : 'The experiment could not run. Check the saved analysis, configuration, and new output path.',
  );
  process.exitCode = 1;
});
