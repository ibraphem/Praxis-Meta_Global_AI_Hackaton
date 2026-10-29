import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { AnalysisTrace, type Diagnostics } from '../lib/diagnostics.js';
import { createVisionStages } from '../services/vision.js';
import type { VisionStages } from './worker.js';
import type { Analysis } from '../schemas/vision.js';
import { JobStore } from './store.js';
import type { SnapshotRef } from './snapshots.js';

export const MUSE_EXPERIMENT_VARIANTS = [
  { name: 'original-current', maxDimension: 0, minimalPrompt: false },
  { name: '1280-current', maxDimension: 1280, minimalPrompt: false },
  { name: '1280-minimal', maxDimension: 1280, minimalPrompt: true },
] as const;
export interface ExperimentMeasurement {
  variant: string;
  status: 'succeeded' | 'timed_out' | 'failed';
  elapsedMs: number;
  upstreamOutcome: 'response_received' | 'unknown';
  diagnostics: Diagnostics;
  confirmedComponents?: number;
  unverifiedWires?: number;
  result?: Analysis;
  errorCode?: string;
}
export interface MuseExperimentReport {
  schemaVersion: 1;
  experimentId: string;
  analysisId: string;
  imageHash: string;
  snapshotRef: SnapshotRef;
  model: string;
  providerDeadlineMs: number;
  stageDeadlineMs: number;
  automaticRetries: 0;
  status: 'running' | 'completed' | 'interrupted';
  variants: typeof MUSE_EXPERIMENT_VARIANTS;
  measurements: ExperimentMeasurement[];
  note: string;
}
/** Useful for both workers and experiments: ignoring abort never grants a late write path. */
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}
export async function runMuseExperiment(
  store: JobStore,
  analysisId: string,
  config: Config,
  options: {
    signal?: AbortSignal;
    stagesFactory?: (settings: Config) => VisionStages;
    onProgress?: (report: MuseExperimentReport) => void;
  } = {},
): Promise<MuseExperimentReport> {
  const reservation = store.experiments.reserve(analysisId),
    owner = reservation.owner!;
  let job: ReturnType<JobStore['get']>,
    snapshot: ReturnType<JobStore['getSnapshot']>['snapshot'];
  try {
    job = store.get(analysisId);
    snapshot = store.getSnapshot(
      reservation.snapshotRef.samSnapshotId,
    ).snapshot;
  } catch {
    store.experiments.record(
      reservation.experimentId,
      owner,
      { errorCode: 'SNAPSHOT_UNAVAILABLE' },
      'interrupted',
    );
    throw new AppError(
      503,
      'EXPERIMENT_INTERRUPTED',
      `Experiment ${reservation.experimentId} could not load its checkpoint. Inspect and explicitly release its reservation.`,
    );
  }
  const ownership = new AbortController();
  const heartbeat = setInterval(() => {
    try {
      if (!store.experiments.renew(reservation.experimentId, owner))
        ownership.abort(
          new AppError(
            503,
            'EXPERIMENT_INTERRUPTED',
            'Experiment ownership was lost.',
          ),
        );
    } catch {
      ownership.abort(
        new AppError(
          503,
          'EXPERIMENT_INTERRUPTED',
          'Experiment ownership could not be renewed.',
        ),
      );
    }
  }, 3000);
  const signal = AbortSignal.any([
    ownership.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const report: MuseExperimentReport = {
    schemaVersion: 1,
    experimentId: reservation.experimentId,
    analysisId,
    imageHash: job.imageHash,
    snapshotRef: reservation.snapshotRef,
    model: job.settings.museModel,
    providerDeadlineMs: config.PROVIDER_TIMEOUT_MS,
    stageDeadlineMs: config.ANALYSIS_TIMEOUT_MS,
    automaticRetries: 0,
    status: 'running',
    variants: MUSE_EXPERIMENT_VARIANTS,
    measurements: [],
    note: 'Admission is reserved across jobs and legacy requests sharing this database. Other provider clients are outside this reservation. A timeout leaves upstream execution unknown and can confound later variants. Original jobs and predictions are unchanged.',
  };
  const persist = () => {
    if (
      !store.experiments.record(
        report.experimentId,
        owner,
        report,
        report.status,
      )
    )
      throw new AppError(
        503,
        'EXPERIMENT_INTERRUPTED',
        'Experiment ownership was lost before its result could be persisted.',
      );
    options.onProgress?.(report);
  };
  try {
    persist();
    for (const variant of MUSE_EXPERIMENT_VARIANTS) {
      signal.throwIfAborted();
      if (!store.experiments.renew(report.experimentId, owner))
        throw new AppError(
          503,
          'EXPERIMENT_INTERRUPTED',
          'Experiment ownership was lost.',
        );
      const trace = new AnalysisTrace(randomUUID(), () => undefined);
      const settings: Config = {
        ...config,
        VISION_MODE: 'combined',
        META_SAM_MODEL: job.settings.samModel,
        META_REASONING_MODEL: job.settings.museModel,
        MUSE_MAX_DIMENSION: variant.maxDimension,
        MUSE_MINIMAL_PROMPT: variant.minimalPrompt,
      };
      const deadline = new AbortController();
      const timer = setTimeout(
        () =>
          deadline.abort(
            new AppError(
              504,
              'ANALYSIS_TIMEOUT',
              'The experiment variant deadline expired.',
            ),
          ),
        config.ANALYSIS_TIMEOUT_MS,
      );
      const variantSignal = AbortSignal.any([signal, deadline.signal]);
      try {
        const stages = (options.stagesFactory ?? createVisionStages)(settings);
        const result = await bounded(
          stages.interpret(structuredClone(snapshot), variantSignal, trace),
          variantSignal,
        );
        variantSignal.throwIfAborted();
        report.measurements.push({
          variant: variant.name,
          status: 'succeeded',
          upstreamOutcome: 'response_received',
          elapsedMs: trace.elapsedMs,
          diagnostics: trace.snapshot(),
          confirmedComponents: result.objects.filter(
            (o) => o.type !== 'jumper_wire' && o.interpretation === 'confirmed',
          ).length,
          unverifiedWires: result.objects.filter(
            (o) => o.type === 'jumper_wire',
          ).length,
          result,
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const code =
          error instanceof AppError ? error.code : 'EXPERIMENT_FAILED';
        const timedOut = [
          'PROVIDER_TIMEOUT',
          'META_API_TIMEOUT',
          'ANALYSIS_TIMEOUT',
        ].includes(code);
        report.measurements.push({
          variant: variant.name,
          status: timedOut ? 'timed_out' : 'failed',
          upstreamOutcome:
            timedOut ||
            code === 'EXPERIMENT_FAILED' ||
            code === 'PROVIDER_CONNECTION_ERROR'
              ? 'unknown'
              : 'response_received',
          elapsedMs: trace.elapsedMs,
          errorCode: code,
          diagnostics: trace.snapshot(),
        });
      } finally {
        clearTimeout(timer);
      }
      persist();
    }
    signal.throwIfAborted();
    report.status = 'completed';
    persist();
    return report;
  } catch {
    report.status = 'interrupted';
    store.experiments.record(report.experimentId, owner, report, 'interrupted');
    options.onProgress?.(report);
    throw new AppError(
      503,
      'EXPERIMENT_INTERRUPTED',
      `Experiment ${report.experimentId} was interrupted. Its upstream outcome may be unknown; inspect it and explicitly release its reservation before more model work.`,
    );
  } finally {
    clearInterval(heartbeat);
  }
}
