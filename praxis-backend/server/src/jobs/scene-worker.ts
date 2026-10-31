import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { MetaClient } from '../lib/meta-client.js';
import type { AnalysisTrace } from '../lib/diagnostics.js';
import { AppError } from '../lib/errors.js';
import {
  buildSceneGraph,
  discoverInventory,
  planSceneTargets,
  segmentSceneTarget,
} from '../services/scene.js';
import type { SceneGraph, SceneWork } from '../schemas/scene.js';
import { checkpointScene, getSceneSnapshot } from './scene-snapshots.js';
import { JobStore, lastAttempt, newAttempt, type Job } from './store.js';
import { runTerminalStage } from './terminal-worker.js';

/** Optional stages share the existing fenced lease; broad results are published first. */
export async function runSceneStage(
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
  if (attempt.sceneOperation === 'terminals')
    return runTerminalStage(
      store,
      job,
      owner,
      attemptId,
      config,
      client,
      signal,
      trace,
    );
  const bound = attempt.samSnapshotId
    ? store.getSnapshot(attempt.samSnapshotId)
    : undefined;
  if (bound && bound.ref.samSnapshotHash !== attempt.samSnapshotHash)
    throw new AppError(
      409,
      'INVALID_SNAPSHOT_BINDING',
      'The scene attempt has an invalid SAM checkpoint binding.',
    );
  const snapshot = bound?.snapshot ?? job.sam.snapshot!;
  const commit = (work: Parameters<JobStore['owned']>[4]) => {
    signal.throwIfAborted();
    if (!store.owned(job.analysisId, owner, 'scene', attemptId, work))
      throw new AppError(
        503,
        'WORKER_INTERRUPTED',
        'Scene worker ownership was lost.',
      );
  };
  const finish = (j: Job) => {
    j.scene!.status = 'succeeded';
    const a = lastAttempt(j, 'scene')!;
    a.status = 'succeeded';
    a.upstreamOutcome =
      a.sceneOperation === 'inventory' ||
      j.scene!.work.some((w) => w.attemptId === attemptId)
        ? 'response_received'
        : 'not_sent';
    a.retryPolicy = 'not_retryable';
    a.finishedAt = Date.now();
    a.diagnostics = trace.snapshot();
    j.status = j.muse.result
      ? 'completed'
      : j.sam.result
        ? 'partial'
        : 'failed';
    delete j.owner;
    delete j.leaseUntil;
  };
  if (attempt.sceneOperation === 'inventory') {
    // Publish SAM-only hypotheses first, even if Muse fails, times out or returns invalid JSON.
    const baseline = buildSceneGraph({
      inventory: { objects: [] },
      imageHash: job.imageHash,
      snapshot,
      ...(bound ? { ref: bound.ref } : {}),
      ...(job.scene?.graph ? { previous: job.scene.graph } : {}),
      attemptId,
      model: config.META_REASONING_MODEL,
    });
    commit((j, a) => {
      const ref = checkpointScene(store, j, baseline, [], attemptId);
      a.outputSnapshotId = ref.snapshotId;
      a.outputSnapshotHash = ref.snapshotHash;
    });
    const inventory = await discoverInventory(
      config,
      client,
      snapshot.image,
      signal,
      trace,
    );
    const graph = buildSceneGraph({
      inventory,
      imageHash: job.imageHash,
      snapshot,
      ...(bound ? { ref: bound.ref } : {}),
      previous: baseline,
      attemptId,
      model: config.META_REASONING_MODEL,
    });
    commit((j, a) => {
      const ref = checkpointScene(store, j, graph, [], attemptId);
      a.outputSnapshotId = ref.snapshotId;
      a.outputSnapshotHash = ref.snapshotHash;
      finish(j);
      if (
        config.VISION_MODE === 'combined' &&
        config.SCENE_MAX_GUIDED_REQUESTS > j.scene!.budget.requests &&
        planSceneTargets(graph, snapshot.image, config.SCENE_MAX_CROP_PIXELS)
          .length
      ) {
        j.scene!.attempts.push({
          ...newAttempt(),
          sceneOperation: 'guided',
          sceneSnapshotId: ref.snapshotId,
          sceneSnapshotHash: ref.snapshotHash,
          ...(bound
            ? {
                samSnapshotId: bound.ref.samSnapshotId,
                samSnapshotHash: bound.ref.samSnapshotHash,
                snapshotBinding: 'recorded' as const,
              }
            : {}),
        });
        j.scene!.status = 'queued';
      }
    });
    return;
  }
  if (!attempt.sceneSnapshotId)
    throw new AppError(
      409,
      'SCENE_SNAPSHOT_REQUIRED',
      'Guided segmentation requires an inventory checkpoint.',
    );
  const input = getSceneSnapshot(store, attempt.sceneSnapshotId);
  if (
    input.ref.snapshotHash !== attempt.sceneSnapshotHash ||
    input.ref.imageHash !== job.imageHash
  )
    throw new AppError(
      409,
      'SCENE_HASH_MISMATCH',
      'Guided segmentation must use its bound scene inventory.',
    );
  const graph: SceneGraph = structuredClone(input.graph);
  const native = [...input.native];
  const targets = planSceneTargets(
    graph,
    snapshot.image,
    config.SCENE_MAX_CROP_PIXELS,
  );
  for (const target of targets) {
    signal.throwIfAborted();
    // Reserve space for a complete bounded provider response before spending a request.
    if (
      graph.observations.length + 32 > 450 ||
      graph.associations.length + 32 > 800
    )
      break;
    const current = store.get(job.analysisId).scene!;
    const pixels = target.crop[2] * target.crop[3];
    if (current.budget.requests >= config.SCENE_MAX_GUIDED_REQUESTS) break;
    // A large high-priority crop must not starve smaller eligible targets.
    if (current.budget.pixels + pixels > config.SCENE_MAX_GUIDED_PIXELS)
      continue;
    if (current.work.some((w) => w.objectId === target.objectId)) continue;
    const work: SceneWork = {
      requestId: randomUUID(),
      attemptId,
      objectId: target.objectId,
      inputSnapshotId: input.ref.snapshotId,
      inputSnapshotHash: input.ref.snapshotHash,
      prompt: target.prompt,
      crop: target.crop,
      reason: target.reason,
      status: 'running',
      upstreamOutcome: 'unknown',
      startedAt: Date.now(),
    };
    commit((j) => {
      j.scene!.budget.requests++;
      j.scene!.budget.pixels += pixels;
      j.scene!.work.push(work);
    });
    try {
      const result = await segmentSceneTarget(
        config,
        client,
        snapshot.image,
        target,
        attemptId,
        signal,
        trace,
      );
      for (const observation of result.observations)
        observation.requestId = work.requestId;
      let previewBytes = graph.observations.reduce(
        (n, o) => n + (o.mask?.path.length ?? 0),
        0,
      );
      for (const observation of result.observations)
        if (observation.mask) {
          previewBytes += observation.mask.path.length;
          if (previewBytes > 120000) delete observation.mask;
        }
      graph.observations.push(...result.observations);
      native.push(...result.native);
      for (const observation of result.observations)
        graph.associations.push({
          id: randomUUID(),
          objectId: target.objectId,
          observationId: observation.id,
          relation: 'unknown',
          basis: 'prompt_target',
          status: 'proposed',
          attemptId,
        });
      graph.objects.find((o) => o.id === target.objectId)!.segmentationStatus =
        result.observations.length ? 'candidates_returned' : 'no_match';
      commit((j, a) => {
        const saved = j.scene!.work.find(
          (w) => w.requestId === work.requestId,
        )!;
        saved.status = result.observations.length ? 'succeeded' : 'no_match';
        saved.upstreamOutcome = 'response_received';
        saved.finishedAt = Date.now();
        const ref = checkpointScene(store, j, graph, native, attemptId);
        a.outputSnapshotId = ref.snapshotId;
        a.outputSnapshotHash = ref.snapshotHash;
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const code = error instanceof AppError ? error.code : 'STAGE_FAILED';
      const timedOut = ['PROVIDER_TIMEOUT', 'META_API_TIMEOUT'].includes(code);
      graph.objects.find((o) => o.id === target.objectId)!.segmentationStatus =
        'failed';
      commit((j, a) => {
        const saved = j.scene!.work.find(
          (w) => w.requestId === work.requestId,
        )!;
        saved.status = timedOut ? 'timed_out' : 'failed';
        saved.errorCode = code;
        saved.finishedAt = Date.now();
        saved.upstreamOutcome =
          timedOut ||
          ['PROVIDER_CONNECTION_ERROR', 'STAGE_FAILED'].includes(code)
            ? 'unknown'
            : 'response_received';
        const ref = checkpointScene(store, j, graph, native, attemptId);
        a.outputSnapshotId = ref.snapshotId;
        a.outputSnapshotHash = ref.snapshotHash;
      });
      // Unknown upstream execution is not a signal to dispatch the next paid request.
      if (
        timedOut ||
        ['PROVIDER_CONNECTION_ERROR', 'STAGE_FAILED'].includes(code)
      )
        throw error;
    }
  }
  commit((j) => finish(j));
}
