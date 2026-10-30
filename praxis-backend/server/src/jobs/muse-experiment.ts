import { RUNTIME } from '../lib/runtime.js';
import { admittedClient } from './model-admission.js';
import { auditWireCoverage } from '../services/wire-coverage.js';
import { createWireVerifier } from '../services/wire-verification.js';
import type { MetaClient } from '../lib/meta-client.js';
import type { WireModelReview } from '../schemas/wire-recovery.js';
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
  { name: 'focused-candidates', maxDimension: 1280, minimalPrompt: true },
] as const;
export interface ExperimentMeasurement {
  variant: string;
  status: 'succeeded' | 'timed_out' | 'failed' | 'skipped';
  candidateId?: string;
  evidenceHash?: string;
  modelReview?: WireModelReview;
  elapsedMs: number;
  upstreamOutcome: 'not_sent' | 'response_received' | 'unknown';
  diagnostics: Diagnostics;
  confirmedComponents?: number;
  unverifiedWires?: number;
  result?: Analysis;
  errorCode?: string;
}
export interface MuseExperimentReport {
  schemaVersion: 2;
  runtime: typeof RUNTIME;
  phaseBudgetMs: number;
  focusedPlan: {
    candidateId: string;
    evidenceHash: string;
    cropTruncated: boolean;
  }[];
  phaseTimings: { variant: string; elapsedMs: number }[];
  experimentId: string;
  analysisId: string;
  imageHash: string;
  snapshotRef: SnapshotRef;
  model: string;
  providerDeadlineMs: number;
  stageDeadlineMs: number;
  automaticRetries: 0;
  status: 'running' | 'completed' | 'interrupted';
  variants: readonly (typeof MUSE_EXPERIMENT_VARIANTS)[number][];
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
    variants?: (typeof MUSE_EXPERIMENT_VARIANTS)[number]['name'][];
    snapshotId?: string;
    candidateIds?: string[];
    phaseBudgetMs?: number;
    verificationClient?: MetaClient;
    stagesFactory?: (settings: Config) => VisionStages;
    onProgress?: (report: MuseExperimentReport) => void;
  } = {},
): Promise<MuseExperimentReport> {
  const names =
    options.variants ?? MUSE_EXPERIMENT_VARIANTS.slice(0, 3).map((v) => v.name);
  if (
    !names.length ||
    names.length > 4 ||
    new Set(names).size !== names.length ||
    names.some((n) => !MUSE_EXPERIMENT_VARIANTS.some((v) => v.name === n)) ||
    (options.candidateIds &&
      (!options.candidateIds.length ||
        options.candidateIds.length > 4 ||
        new Set(options.candidateIds).size !== options.candidateIds.length ||
        options.candidateIds.some(
          (id) => !/^jumper_wire_[1-9]\d*$/.test(id),
        ))) ||
    (options.phaseBudgetMs !== undefined &&
      (!Number.isInteger(options.phaseBudgetMs) ||
        options.phaseBudgetMs < 1 ||
        options.phaseBudgetMs > config.PROVIDER_TIMEOUT_MS))
  )
    throw new AppError(
      400,
      'INVALID_EXPERIMENT',
      'Choose distinct variants, up to four candidate IDs, and a phase budget within the provider deadline.',
    );
  if (options.candidateIds && !names.includes('focused-candidates'))
    throw new AppError(
      400,
      'INVALID_EXPERIMENT',
      'Candidate IDs require the focused-candidates variant.',
    );
  const phaseBudgetMs = Math.min(
    options.phaseBudgetMs ?? config.PROVIDER_TIMEOUT_MS,
    config.ANALYSIS_TIMEOUT_MS,
  );
  const variants = names.map((n) =>
    MUSE_EXPERIMENT_VARIANTS.find((v) => v.name === n)!,
  );
  const reservation = store.experiments.reserve(analysisId, options.snapshotId),
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
    schemaVersion: 2,
    runtime: RUNTIME,
    phaseBudgetMs,
    focusedPlan: [],
    phaseTimings: [],
    experimentId: reservation.experimentId,
    analysisId,
    imageHash: job.imageHash,
    snapshotRef: reservation.snapshotRef,
    model: job.settings.museModel,
    providerDeadlineMs: config.PROVIDER_TIMEOUT_MS,
    stageDeadlineMs: config.ANALYSIS_TIMEOUT_MS,
    automaticRetries: 0,
    status: 'running',
    variants,
    measurements: [],
    note: 'Admission is reserved across jobs and legacy requests sharing this database. Other provider clients are outside this reservation. A timeout leaves upstream execution unknown and can confound later variants. Original jobs and predictions are unchanged. Unknown upstream outcomes stop the experiment; request success and model identity decisions are not physical-wire accuracy. Focused checks never localize insertion holes.',
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
    for (const variant of variants) {
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
        phaseBudgetMs,
      );
      const variantSignal = AbortSignal.any([signal, deadline.signal]);
      try {
        if (variant.name === 'focused-candidates') {
          const audit = await bounded(
            auditWireCoverage(snapshot, reservation.snapshotRef),
            variantSignal,
          );
          const available = audit.candidates.filter(
            (c) => c.geometryAccepted && c.mask,
          );
          const candidates = options.candidateIds
            ? options.candidateIds
                .map((id) => available.find((c) => c.id === id))
                .filter((c) => !!c)
            : [...available]
                .sort(
                  (a, b) =>
                    Number(b.source === 'sam_crop') -
                      Number(a.source === 'sam_crop') ||
                    a.id.localeCompare(b.id),
                )
                .slice(0, 3);
          if (
            (options.candidateIds &&
              candidates.length !== options.candidateIds.length) ||
            !candidates.length
          )
            throw new AppError(
              400,
              'INVALID_EXPERIMENT_CANDIDATE',
              'Choose geometry-passing native checkpoint candidates; no inference was dispatched.',
            );
          report.focusedPlan = candidates.map((c) => ({
            candidateId: c.id,
            evidenceHash: c.evidenceHash!,
            cropTruncated: !!c.touchesCropBoundary,
          }));
          persist();
          const verify = createWireVerifier(
            settings,
            admittedClient(
              store,
              { experimentId: reservation.experimentId, owner },
              options.verificationClient,
            ),
            { identityOnly: true, maxDimension: variant.maxDimension },
          );
          for (const candidate of candidates) {
            variantSignal.throwIfAborted();
            const candidateTrace = new AnalysisTrace(
              randomUUID(),
              () => undefined,
            );
            try {
              const review = await bounded(
                verify(
                  snapshot.image,
                  candidate,
                  variantSignal,
                  candidateTrace,
                ),
                variantSignal,
              );
              report.measurements.push({
                variant: variant.name,
                candidateId: candidate.id,
                evidenceHash: candidate.evidenceHash!,
                status: candidate.touchesCropBoundary ? 'skipped' : 'succeeded',
                upstreamOutcome: candidate.touchesCropBoundary
                  ? 'not_sent'
                  : 'response_received',
                elapsedMs: candidateTrace.elapsedMs,
                diagnostics: candidateTrace.snapshot(),
                modelReview: review,
              });
            } catch (error) {
              const code =
                error instanceof AppError ? error.code : 'EXPERIMENT_FAILED';
              const timedOut = [
                'PROVIDER_TIMEOUT',
                'META_API_TIMEOUT',
                'ANALYSIS_TIMEOUT',
              ].includes(code);
              report.measurements.push({
                variant: variant.name,
                candidateId: candidate.id,
                evidenceHash: candidate.evidenceHash!,
                status: timedOut ? 'timed_out' : 'failed',
                upstreamOutcome:
                  timedOut ||
                  signal.aborted ||
                  code === 'EXPERIMENT_FAILED' ||
                  code === 'PROVIDER_CONNECTION_ERROR'
                    ? 'unknown'
                    : 'response_received',
                errorCode: code,
                elapsedMs: candidateTrace.elapsedMs,
                diagnostics: candidateTrace.snapshot(),
              });
              persist();
              throw error;
            }
            persist();
          }
        } else {
          const stages = options.stagesFactory
            ? options.stagesFactory(settings)
            : createVisionStages(
                settings,
                admittedClient(store, {
                  experimentId: reservation.experimentId,
                  owner,
                }),
              );
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
              (o) =>
                o.type !== 'jumper_wire' && o.interpretation === 'confirmed',
            ).length,
            unverifiedWires: result.objects.filter(
              (o) => o.type === 'jumper_wire',
            ).length,
            result,
          });
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const code =
          error instanceof AppError ? error.code : 'EXPERIMENT_FAILED';
        const timedOut = [
          'PROVIDER_TIMEOUT',
          'META_API_TIMEOUT',
          'ANALYSIS_TIMEOUT',
        ].includes(code);
        if (!(
          variant.name === 'focused-candidates' &&
          report.measurements.some((m) => m.variant === variant.name)
        ))
          report.measurements.push({
            variant: variant.name,
            status: timedOut ? 'timed_out' : 'failed',
            upstreamOutcome:
              code === 'INVALID_EXPERIMENT_CANDIDATE'
                ? 'not_sent'
                : timedOut ||
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
        report.phaseTimings.push({
          variant: variant.name,
          elapsedMs: trace.elapsedMs,
        });
      }
      persist();
      if (report.measurements.at(-1)?.upstreamOutcome === 'unknown')
        throw new AppError(
          503,
          'EXPERIMENT_INTERRUPTED',
          'An upstream outcome is unknown; remaining variants will not be dispatched.',
        );
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
