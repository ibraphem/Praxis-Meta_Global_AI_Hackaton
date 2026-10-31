import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { MetaClient } from '../lib/meta-client.js';
import type { AnalysisTrace } from '../lib/diagnostics.js';
import { AppError } from '../lib/errors.js';
import type { Job, JobStore } from './store.js';
import { lastAttempt } from './store.js';
import { checkpointScene, getSceneSnapshot } from './scene-snapshots.js';
import { reconcileSceneGraph } from '../services/scene-reconciliation.js';
import {
  discoverTerminals,
  terminalCrop,
} from '../services/scene-terminals.js';

export async function runTerminalStage(
  store: JobStore,
  job: Job,
  owner: string,
  attemptId: string,
  config: Config,
  client: MetaClient,
  signal: AbortSignal,
  trace: AnalysisTrace,
) {
  const attempt = lastAttempt(job, 'scene')!;
  if (!attempt.sceneSnapshotId || !attempt.terminalObjectIds?.length)
    throw new AppError(
      409,
      'SCENE_SNAPSHOT_REQUIRED',
      'Terminal discovery requires a bound scene and selected objects.',
    );
  const input = getSceneSnapshot(store, attempt.sceneSnapshotId);
  if (
    input.ref.snapshotHash !== attempt.sceneSnapshotHash ||
    input.graph.imageHash !== job.imageHash
  )
    throw new AppError(
      409,
      'SCENE_HASH_MISMATCH',
      'Terminal input evidence changed.',
    );
  const image = attempt.samSnapshotId
    ? store.getSnapshot(attempt.samSnapshotId).snapshot.image
    : job.sam.snapshot!.image;
  if (
    attempt.samSnapshotId &&
    store.getSnapshot(attempt.samSnapshotId).ref.samSnapshotHash !==
      attempt.samSnapshotHash
  )
    throw new AppError(
      409,
      'INVALID_SNAPSHOT_BINDING',
      'Terminal image checkpoint changed.',
    );
  let graph = reconcileSceneGraph(input.graph);
  const commit = (work: Parameters<JobStore['owned']>[4]) => {
    signal.throwIfAborted();
    if (!store.owned(job.analysisId, owner, 'scene', attemptId, work))
      throw new AppError(
        503,
        'WORKER_INTERRUPTED',
        'Terminal worker ownership was lost.',
      );
  };
  for (const objectId of attempt.terminalObjectIds) {
    const current = store.get(job.analysisId).scene!;
    const crop = terminalCrop(graph, objectId),
      pixels = crop[2] * crop[3];
    if (
      (current.budget.terminalRequests ?? 0) >=
        (current.settings?.maxTerminalRequests ?? 0) ||
      (current.budget.terminalPixels ?? 0) + pixels >
        (current.settings?.maxTerminalPixels ?? 0)
    )
      throw new AppError(
        409,
        'TERMINAL_BUDGET',
        'The terminal budget was exhausted before dispatch.',
      );
    const requestId = randomUUID();
    commit((j, a) => {
      j.scene!.budget.terminalRequests =
        (j.scene!.budget.terminalRequests ?? 0) + 1;
      j.scene!.budget.terminalPixels =
        (j.scene!.budget.terminalPixels ?? 0) + pixels;
      (j.scene!.terminalWork ??= []).push({
        requestId,
        attemptId,
        objectId,
        inputSnapshotId: input.ref.snapshotId,
        inputSnapshotHash: input.ref.snapshotHash,
        crop,
        status: 'running',
        upstreamOutcome: 'unknown',
        startedAt: Date.now(),
      });
      const ref = checkpointScene(store, j, graph, input.native, attemptId);
      a.outputSnapshotId = ref.snapshotId;
      a.outputSnapshotHash = ref.snapshotHash;
    });
    try {
      graph = await discoverTerminals({
        config,
        client,
        image,
        graph,
        objectId,
        attemptId,
        requestId,
        signal,
        trace,
      });
      commit((j, a) => {
        const work = j.scene!.terminalWork!.find(
          (w) => w.requestId === requestId,
        )!;
        work.status = 'succeeded';
        work.upstreamOutcome = 'response_received';
        work.finishedAt = Date.now();
        const ref = checkpointScene(store, j, graph, input.native, attemptId);
        a.outputSnapshotId = ref.snapshotId;
        a.outputSnapshotHash = ref.snapshotHash;
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const code = error instanceof AppError ? error.code : 'STAGE_FAILED';
      commit((j) => {
        const work = j.scene!.terminalWork!.find(
          (w) => w.requestId === requestId,
        )!;
        work.status = ['PROVIDER_TIMEOUT', 'META_API_TIMEOUT'].includes(code)
          ? 'timed_out'
          : 'failed';
        work.upstreamOutcome = [
          'PROVIDER_TIMEOUT',
          'META_API_TIMEOUT',
          'PROVIDER_CONNECTION_ERROR',
          'STAGE_FAILED',
        ].includes(code)
          ? 'unknown'
          : 'response_received';
        work.errorCode = code;
        work.finishedAt = Date.now();
      });
      // Prior successful object evidence survives; never fan out after a failed request.
      throw error;
    }
  }
  commit((j, a) => {
    a.status = 'succeeded';
    a.upstreamOutcome = 'response_received';
    a.retryPolicy = 'not_retryable';
    a.finishedAt = Date.now();
    a.diagnostics = trace.snapshot();
    j.scene!.status = 'succeeded';
    j.status = j.muse.result
      ? 'completed'
      : j.sam.result
        ? 'partial'
        : 'failed';
    delete j.owner;
    delete j.leaseUntil;
  });
}
