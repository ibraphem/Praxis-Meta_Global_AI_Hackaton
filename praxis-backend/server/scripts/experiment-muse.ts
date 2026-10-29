import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs/store.js';
import { createVisionStages } from '../src/services/vision.js';
import { AnalysisTrace, type Diagnostics } from '../src/lib/diagnostics.js';
import { AppError } from '../src/lib/errors.js';
import { randomUUID } from 'node:crypto';

// Explicit CLI invocation performs THREE paid provider requests, never retries, and never rewrites a job.
async function main() {
  const args = process.argv.slice(2),
    id = args[0],
    outputIndex = args.indexOf('--output'),
    output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (args.includes('--help')) {
    console.log(
      'Usage: npm run experiment:muse -- ANALYSIS_ID [--output NEW_REPORT.json]\nMakes three provider requests against cached SAM results; no automatic retries.',
    );
    return;
  }
  if (
    !id ||
    (outputIndex >= 0 && !output) ||
    args.some((a, i) => i > 0 && a !== '--output' && i !== outputIndex + 1)
  )
    throw new Error(
      'Usage: npm run experiment:muse -- ANALYSIS_ID [--output NEW_REPORT.json]',
    );
  const config = loadConfig(),
    store = new JobStore(config);
  let job;
  try {
    job = store.get(id);
  } finally {
    store.close();
  }
  if (
    job.sam.status !== 'succeeded' ||
    !job.sam.snapshot ||
    job.settings.mode !== 'combined' ||
    job.owner ||
    job.muse.status === 'queued'
  )
    throw new Error(
      'Use a completed or partial combined analysis with saved SAM results and no active attempt.',
    );
  // Reserve output exclusively BEFORE incurring provider work; never overwrite an existing report.
  if (output)
    writeFileSync(
      output,
      JSON.stringify({ status: 'running', analysisId: id }),
      { flag: 'wx', mode: 0o600 },
    );
  const snapshot = job.sam.snapshot;
  const variants = [
    { name: 'original-current', maxDimension: 0, minimalPrompt: false },
    { name: '1280-current', maxDimension: 1280, minimalPrompt: false },
    { name: '1280-minimal', maxDimension: 1280, minimalPrompt: true },
  ];
  const measurements: {
    variant: string;
    status: string;
    elapsedMs: number;
    confirmedComponents?: number;
    unverifiedWires?: number;
    errorCode?: string;
    diagnostics: Diagnostics;
    result?: unknown;
  }[] = [];
  for (const v of variants) {
    const trace = new AnalysisTrace(randomUUID(), () => undefined);
    const settings = {
      ...config,
      VISION_MODE: 'combined' as const,
      META_SAM_MODEL: job.settings.samModel,
      META_REASONING_MODEL: job.settings.museModel,
      MUSE_MAX_DIMENSION: v.maxDimension,
      MUSE_MINIMAL_PROMPT: v.minimalPrompt,
    };
    try {
      const result = await createVisionStages(settings).interpret(
        snapshot,
        AbortSignal.timeout(config.ANALYSIS_TIMEOUT_MS),
        trace,
      );
      measurements.push({
        variant: v.name,
        status: 'succeeded',
        elapsedMs: trace.elapsedMs,
        confirmedComponents: result.objects.filter(
          (o) => o.type !== 'jumper_wire' && o.interpretation === 'confirmed',
        ).length,
        unverifiedWires: result.objects.filter((o) => o.type === 'jumper_wire')
          .length,
        diagnostics: trace.snapshot(),
        result,
      });
    } catch (e) {
      measurements.push({
        variant: v.name,
        status:
          e instanceof AppError &&
          ['PROVIDER_TIMEOUT', 'META_API_TIMEOUT'].includes(e.code)
            ? 'timed_out'
            : 'failed',
        elapsedMs: trace.elapsedMs,
        errorCode: e instanceof AppError ? e.code : 'EXPERIMENT_FAILED',
        diagnostics: trace.snapshot(),
      });
    }
    console.error(
      `${v.name}: ${measurements.at(-1)!.status} (${measurements.at(-1)!.elapsedMs} ms)`,
    );
  }
  const report = {
    analysisId: id,
    imageHash: job.imageHash,
    samSnapshotHash: createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex'),
    model: job.settings.museModel,
    providerDeadlineMs: config.PROVIDER_TIMEOUT_MS,
    automaticRetries: 0,
    variants,
    measurements,
    note: 'Three single attempts are an exploratory comparison, not a reliability estimate. Original job, masks and predictions are unchanged.',
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) writeFileSync(output, json, { mode: 0o600 });
  else process.stdout.write(json);
}
main().catch((e) => {
  console.error(
    e instanceof Error && !('code' in e)
      ? e.message
      : 'The experiment could not run. Check the saved analysis, configuration, and output path.',
  );
  process.exitCode = 1;
});
