import { admittedClient } from './model-admission.js';
import { finishRunningCrops } from '../services/crop-attempts.js';
import {
  createWireRecovery,
  type RecoveryProgress,
} from '../services/wire-recovery.js';
import type { SnapshotRef } from './snapshots.js';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { AnalysisTrace, type TraceLogger } from '../lib/diagnostics.js';
import { createVisionStages } from '../services/vision.js';
import { reconcileWireSelection } from '../services/wire-selection.js';
import type { Analysis } from '../schemas/vision.js';
import { partialAnalysis } from '../services/partial-analysis.js';
import { JobStore, newAttempt, lastAttempt } from './store.js';

export type VisionStages = ReturnType<typeof createVisionStages>;
/** Bounded, persisted queue. No worker lifetime depends on an HTTP connection. */
export class AnalysisWorker {
  readonly owner = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private stopped = false;
  constructor(
    readonly store: JobStore,
    readonly config: Config,
    readonly logger: TraceLogger,
    readonly stages?: VisionStages,
    readonly recoveryFactory?: (
      settings: Config,
    ) => ReturnType<typeof createWireRecovery>,
  ) {}
  start() {
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref();
    this.tick();
  }
  tick() {
    if (this.stopped) return;
    while (this.active.size < this.config.JOB_WORKER_CONCURRENCY) {
      let claim: ReturnType<JobStore['claim']>;
      try {
        claim = this.store.claim(this.owner);
      } catch {
        this.logger({
          event: 'analysis.worker_storage_failure',
          requestId: this.owner,
        });
        return;
      }
      if (!claim) break;
      const controller = new AbortController();
      const promise = this.run(claim, controller)
        .catch(() => {
          // Storage failures never turn an uncertain attempt into a retryable queue item.
          this.logger({
            event: 'analysis.worker_storage_failure',
            requestId: claim.attemptId,
          });
        })
        .finally(() => {
          this.active.delete(claim.attemptId);
        });
      this.active.set(claim.attemptId, { controller, promise });
    }
  }
  private async run(
    claim: NonNullable<ReturnType<JobStore['claim']>>,
    controller: AbortController,
  ) {
    const { job, stage, attemptId } = claim;
    const trace = new AnalysisTrace(attemptId, this.logger);
    const settings = {
      ...this.config,
      VISION_MODE: job.settings.mode,
      META_SAM_MODEL: job.settings.samModel,
      META_REASONING_MODEL: job.settings.museModel,
      MUSE_MAX_DIMENSION: job.settings.maxDimension,
      MUSE_MINIMAL_PROMPT: job.settings.minimalPrompt,
    };
    const client = admittedClient(this.store);
    const stages = this.stages ?? createVisionStages(settings, client);
    const heartbeat = setInterval(() => {
      try {
        if (
          !this.store.renewLease(job.analysisId, this.owner, stage, attemptId)
        )
          controller.abort(
            new AppError(
              503,
              'WORKER_INTERRUPTED',
              'Worker ownership was lost.',
            ),
          );
      } catch {
        controller.abort(
          new AppError(
            503,
            'WORKER_INTERRUPTED',
            'Worker ownership could not be renewed.',
          ),
        );
      }
    }, 3000);
    const timer = setTimeout(
      () =>
        controller.abort(
          new AppError(504, 'ANALYSIS_TIMEOUT', 'The stage deadline expired.'),
        ),
      this.config.ANALYSIS_TIMEOUT_MS,
    );
    let abort: (() => void) | undefined;
    let completedInterpretation: Analysis | undefined;
    try {
      // Race even a misbehaving adapter that ignores AbortSignal. Late responses have no write path.
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      const binding = lastAttempt(
        job,
        stage === 'recovery' ? 'recovery' : 'muse',
      );
      const bound =
        stage !== 'sam' && binding?.samSnapshotId
          ? this.store.getSnapshot(binding.samSnapshotId)
          : undefined;
      if (
        stage !== 'sam' &&
        (!bound || bound.ref.samSnapshotHash !== binding?.samSnapshotHash)
      )
        throw new AppError(
          409,
          'INVALID_SNAPSHOT_BINDING',
          'The Muse attempt has no valid SAM checkpoint binding.',
        );
      const snapshot = bound?.snapshot ?? job.sam.snapshot!;
      const result = await Promise.race([
        stage === 'sam'
          ? settings.VISION_MODE === 'combined'
            ? stages.segment(snapshot.image, controller.signal, trace)
            : Promise.resolve(snapshot)
          : stage === 'muse'
            ? stages.interpret(snapshot, controller.signal, trace)
            : (
                this.recoveryFactory?.(settings) ??
                createWireRecovery(settings, client)
              )(
                {
                  snapshot,
                  ref: bound!.ref,
                  reviews: job.wireIdentities,
                  budget: job.recovery.budget,
                  visited: job.recovery.visited,
                  cropAttempts: job.recovery.cropAttempts,
                  operation: job.recovery.operation,
                  ...(job.recovery.target
                    ? { target: job.recovery.target }
                    : {}),
                  ...(job.recovery.candidateId
                    ? { candidateId: job.recovery.candidateId }
                    : {}),
                  ...(job.recovery.report
                    ? { previous: job.recovery.report }
                    : {}),
                },
                controller.signal,
                trace,
                (value: RecoveryProgress) => {
                  let saved: SnapshotRef | undefined;
                  const valid = this.store.owned(
                    job.analysisId,
                    this.owner,
                    'recovery',
                    attemptId,
                    (j) => {
                      j.recovery.budget = value.budget;
                      j.recovery.visited = value.visited;
                      j.recovery.cropAttempts = value.cropAttempts;
                      if (value.changed) {
                        saved = this.store.checkpointSnapshot(
                          j,
                          value.snapshot,
                          attemptId,
                          'recorded',
                          j.recovery.snapshotRef ?? bound!.ref,
                        );
                        j.recovery.snapshotRef = saved;
                      } else j.recovery.report = value.report;
                    },
                  );
                  if (!valid)
                    throw new AppError(
                      503,
                      'WORKER_INTERRUPTED',
                      'Recovery worker ownership was lost.',
                    );
                  return saved;
                },
              ),
        aborted,
      ]);
      controller.signal.throwIfAborted();
      const partial =
        stage === 'sam' &&
        'candidates' in result &&
        settings.VISION_MODE === 'combined'
          ? partialAnalysis(result, settings)
          : undefined;
      this.store.owned(job.analysisId, this.owner, stage, attemptId, (j, a) => {
        a.status = 'succeeded';
        a.upstreamOutcome = 'response_received';
        a.retryPolicy = 'not_retryable';
        a.finishedAt = Date.now();
        a.diagnostics = trace.snapshot();
        j[stage].status = 'succeeded';
        delete j.owner;
        delete j.leaseUntil;
        if (stage === 'sam' && 'candidates' in result) {
          this.store.checkpointSnapshot(j, result, attemptId);
          if (partial) {
            partial.provenance = {
              ...partial.provenance,
              jobAnalysisId: j.analysisId,
              samSnapshotId: j.sam.snapshotRef!.samSnapshotId,
              samSnapshotHash: j.sam.snapshotRef!.samSnapshotHash,
              snapshotProcessingVersion: j.sam.snapshotRef!.processingVersion,
            };
            j.sam.result = partial;
          }
          if (settings.VISION_MODE === 'combined') {
            delete j.recovery.snapshotRef;
            delete j.recovery.report;
            const audit = newAttempt();
            Object.assign(audit, {
              samSnapshotId: j.sam.snapshotRef!.samSnapshotId,
              samSnapshotHash: j.sam.snapshotRef!.samSnapshotHash,
              snapshotBinding: 'recorded',
            });
            j.recovery.status = 'queued';
            j.recovery.operation = 'audit';
            j.recovery.attempts.push(audit);
          }
          j.muse.attempts.push(newAttempt());
          j.muse.status = 'queued';
          j.status = partial ? 'partial' : 'queued';
        } else if (stage === 'recovery' && 'report' in result) {
          j.recovery.report = result.report;
          j.recovery.budget = result.budget;
          j.recovery.visited = result.visited;
          j.recovery.cropAttempts = result.cropAttempts;
          a.recoveryReport = result.report;
          const output = j.recovery.snapshotRef ?? bound!.ref;
          a.outputSnapshotId = output.samSnapshotId;
          a.outputSnapshotHash = output.samSnapshotHash;
          j.status = j.muse.result ? 'completed' : 'partial';
        } else if ('objects' in result) {
          result.provenance = {
            ...result.provenance,
            jobAnalysisId: j.analysisId,
            samSnapshotId: bound!.ref.samSnapshotId,
            samSnapshotHash: bound!.ref.samSnapshotHash,
            snapshotProcessingVersion: bound!.ref.processingVersion,
          };
          completedInterpretation = result;
          const previous = j.muse.result;
          const refs = new Map([[bound!.ref.samSnapshotId, bound!.ref]]);
          const getRef = (id: string) => {
            if (!refs.has(id)) refs.set(id, this.store.getSnapshot(id).ref);
            return refs.get(id)!;
          };
          const selected =
            previous?.provenance.samSnapshotId && j.muse.resultAttemptId
              ? reconcileWireSelection(previous, result, {
                  previousAttemptId: j.muse.resultAttemptId,
                  currentAttemptId: attemptId,
                  previousRef: getRef(previous.provenance.samSnapshotId),
                  currentRef: bound!.ref,
                  getRef,
                  historical: j.muse.attempts
                    .filter(
                      (prior) =>
                        prior.status === 'succeeded' &&
                        prior.result &&
                        prior.samSnapshotId &&
                        prior.attemptId !== j.muse.resultAttemptId,
                    )
                    .reverse()
                    .map((prior) => ({
                      analysis: prior.result!,
                      attemptId: prior.attemptId,
                      ref: getRef(prior.samSnapshotId!),
                    })),
                })
              : result;
          a.result = result; // Original model-filtered prediction, before selectable-evidence reconciliation.
          j.muse.resultAttemptId = attemptId;
          j.muse.result = selected;
          j.revision = attemptId;
          j.status = 'completed';
        }
      });
    } catch (error) {
      const e =
        error instanceof AppError
          ? error
          : new AppError(502, 'STAGE_FAILED', 'The analysis stage failed.');
      this.store.owned(job.analysisId, this.owner, stage, attemptId, (j, a) => {
        a.status =
          e.code === 'WORKER_INTERRUPTED'
            ? 'interrupted'
            : [
                  'PROVIDER_TIMEOUT',
                  'META_API_TIMEOUT',
                  'ANALYSIS_TIMEOUT',
                ].includes(e.code)
              ? 'timed_out'
              : 'failed';
        a.upstreamOutcome =
          stage === 'sam' ||
          a.status === 'interrupted' ||
          a.status === 'timed_out' ||
          ['PROVIDER_CONNECTION_ERROR', 'STAGE_FAILED'].includes(e.code)
            ? 'unknown'
            : 'response_received';
        a.retryPolicy = [
          'INVALID_IMAGE',
          'UNSUPPORTED_IMAGE',
          'IMAGE_TOO_LARGE',
        ].includes(e.code)
          ? 'not_retryable'
          : 'manual_only';
        if (stage === 'muse' && completedInterpretation)
          a.result = completedInterpretation;
        a.errorCode = e.code;
        a.finishedAt = Date.now();
        a.diagnostics = trace.snapshot();
        j[stage].status = a.status;
        if (stage === 'recovery')
          finishRunningCrops(
            j.recovery.cropAttempts,
            a.status === 'interrupted'
              ? 'interrupted'
              : a.status === 'timed_out'
                ? 'timed_out'
                : 'failed',
            e.code,
          );
        if (stage === 'recovery' && j.recovery.report) {
          a.recoveryReport = j.recovery.report;
          const output = j.recovery.snapshotRef ?? j.sam.snapshotRef;
          if (output) {
            a.outputSnapshotId = output.samSnapshotId;
            a.outputSnapshotHash = output.samSnapshotHash;
          }
        }
        delete j.owner;
        delete j.leaseUntil;
        j.status = j.muse.result
          ? 'completed'
          : j.sam.result
            ? 'partial'
            : 'failed';
      });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timer);
      if (abort) controller.signal.removeEventListener('abort', abort);
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const a of this.active.values())
      a.controller.abort(
        new AppError(
          503,
          'WORKER_INTERRUPTED',
          'The worker shut down before completing this attempt.',
        ),
      );
    await Promise.all([...this.active.values()].map((a) => a.promise));
    // No implicit retries during shutdown or subsequent recovery.
  }
}
