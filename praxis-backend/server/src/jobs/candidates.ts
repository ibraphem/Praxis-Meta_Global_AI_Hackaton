import { RUNTIME } from '../lib/runtime.js';
import type { Config } from '../config.js';
import type { Job, JobStore } from './store.js';
import type { SnapshotRef } from './snapshots.js';
import type { SamSnapshot } from '../services/vision.js';
import type { AnalysisTrace } from '../lib/diagnostics.js';
import { AppError } from '../lib/errors.js';
import { partialAnalysis } from '../services/partial-analysis.js';
import { reconcileWireSelection } from '../services/wire-selection.js';

/** Local publication is checkpointed under the worker lease, never a model confirmation. */
export function publishRecoveredCandidates(
  store: JobStore,
  job: Job,
  snapshot: SamSnapshot,
  ref: SnapshotRef,
  attemptId: string,
  config: Config,
  trace: AnalysisTrace,
) {
  const finish = trace.begin('wire.selection');
  try {
    const previous = job.candidateResult ?? job.muse.result ?? job.sam.result;
    const geometry = partialAnalysis(snapshot, config);
    const observed = {
      ...geometry,
      ...(previous
        ? {
            objects: [
              ...previous.objects.filter((c) => c.type !== 'jumper_wire'),
              ...geometry.objects.filter((c) => c.type === 'jumper_wire'),
            ],
            ...(previous.breadboardAudit
              ? { breadboardAudit: previous.breadboardAudit }
              : {}),
          }
        : {}),
      provenance: {
        ...(previous?.provenance ?? geometry.provenance),
        runtime: RUNTIME,
        jobAnalysisId: job.analysisId,
        samSnapshotId: ref.samSnapshotId,
        samSnapshotHash: ref.samSnapshotHash,
        snapshotProcessingVersion: ref.processingVersion,
        candidateLayer: {
          version: 'sam-candidate-layer-v1' as const,
          publication: 'local_geometry' as const,
          snapshotId: ref.samSnapshotId,
          snapshotHash: ref.samSnapshotHash,
          sourceAttemptId: attemptId,
        },
      },
    };
    job.candidateResult = previous?.provenance.samSnapshotId
      ? reconcileWireSelection(previous, observed, {
          observationOnly: true,
          previousAttemptId:
            previous.provenance.candidateLayer?.sourceAttemptId ??
            job.muse.resultAttemptId ??
            job.sam.snapshotRef!.sourceAttemptId,
          currentAttemptId: attemptId,
          previousRef: store.getSnapshot(previous.provenance.samSnapshotId).ref,
          currentRef: ref,
          getRef: (id) => store.getSnapshot(id).ref,
        })
      : observed;
    delete job.candidatePublicationError;
    job.revision = ref.samSnapshotId;
    finish('completed');
  } catch (error) {
    finish('failed');
    if (!(error instanceof AppError) || error.code !== 'WIRE_SELECTION_BUDGET')
      throw error;
    // Preserve the immutable raw checkpoint even when the published view cannot fit.
    job.candidatePublicationError = 'WIRE_SELECTION_BUDGET';
  }
}
