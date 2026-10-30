import { Console } from 'node:console';
import { openSync, closeSync, ftruncateSync, writeSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs/store.js';
import {
  runMuseExperiment,
  MUSE_EXPERIMENT_VARIANTS,
} from '../src/jobs/muse-experiment.js';
import { AppError } from '../src/lib/errors.js';

async function main() {
  const args = process.argv.slice(2);
  const usage =
    'Usage: npm run experiment:muse -- ANALYSIS_ID [--output NEW_REPORT.json] [--variants original-current,1280-current,1280-minimal,focused-candidates] [--snapshot SNAPSHOT_ID] [--candidate-ids jumper_wire_31,jumper_wire_43] [--budget-ms 45000]\n       npm run experiment:muse -- --release INTERRUPTED_EXPERIMENT_ID\nLIVE MODEL EXPERIMENT. Default: three scene variants. Focused checks are opt-in, up to four candidates. Stops on unknown upstream outcome; no automatic retries. Output paths must be new.';
  if (args.includes('--help')) {
    console.log(usage);
    return;
  }
  const release = args[0] === '--release';
  const flags: Record<string, string> = {};
  if (release ? args.length !== 2 : !args[0] || (args.length - 1) % 2 !== 0)
    throw new Error(usage);
  if (!release)
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i]!;
      if (
        ![
          '--output',
          '--variants',
          '--snapshot',
          '--candidate-ids',
          '--budget-ms',
        ].includes(key) ||
        flags[key] ||
        !args[i + 1] ||
        args[i + 1]!.startsWith('--')
      )
        throw new Error(usage);
      flags[key] = args[i + 1]!;
    }
  const output = flags['--output'];
  const variants = flags['--variants']?.split(',') as
    (typeof MUSE_EXPERIMENT_VARIANTS)[number]['name'][] | undefined;
  if (
    variants?.some((n) => !MUSE_EXPERIMENT_VARIANTS.some((v) => v.name === n))
  )
    throw new Error(usage);
  const config = loadConfig(),
    store = new JobStore(config);
  let descriptor: number | undefined;
  let began = false;
  let printed = 0;
  const terminal = new Console({
    stdout: process.stderr,
    stderr: process.stderr,
  });
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
      ...(variants ? { variants } : {}),
      ...(flags['--snapshot'] ? { snapshotId: flags['--snapshot'] } : {}),
      ...(flags['--candidate-ids']
        ? { candidateIds: flags['--candidate-ids'].split(',') }
        : {}),
      ...(flags['--budget-ms']
        ? { phaseBudgetMs: Number(flags['--budget-ms']) }
        : {}),
      onProgress: (report) => {
        began = true;
        for (const measurement of report.measurements.slice(printed))
          terminal.log(
            `${measurement.variant}${measurement.candidateId ? `/${measurement.candidateId}` : ''}: ${measurement.status} (${measurement.elapsedMs} ms)${measurement.modelReview ? `; model decision=${measurement.modelReview.decision}` : ''}`,
          );
        printed = report.measurements.length;
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
    terminal.table(
      report.measurements.map((m) => {
        const sum = (stages: string[]) =>
          m.diagnostics.timings
            .filter((t) => stages.includes(t.stage))
            .reduce((n, t) => n + t.durationMs, 0);
        return {
          variant: m.variant,
          candidate: m.candidateId ?? 'scene',
          status: m.status,
          prepareMs: sum(['muse.prepare']),
          admissionMs: sum(['muse.admission']),
          providerMs: m.diagnostics.timings
            .filter((t) => t.kind === 'request')
            .reduce((n, t) => n + t.durationMs, 0),
          validationMs: sum(['muse.validate', 'response.validate']),
          selectionMs: sum(['wire.selection']),
          totalMs: m.elapsedMs,
          decision:
            m.modelReview?.decision ?? 'requires independent quality scoring',
        };
      }),
    );
    terminal.table(report.phaseTimings);
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
