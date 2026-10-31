import { createHash, randomUUID } from 'node:crypto';
import type { JobStore, Job } from './store.js';
import {
  sceneGraphSchema,
  type SceneGraph,
  type SceneSnapshotRef,
} from '../schemas/scene.js';
import type { NativeSceneObservation } from '../services/scene.js';
import { AppError } from '../lib/errors.js';

export interface SceneSnapshot {
  ref: SceneSnapshotRef;
  graph: SceneGraph;
  native: NativeSceneObservation[];
}
function digest(value: {
  graph: SceneGraph;
  native: NativeSceneObservation[];
}) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function checkpointScene(
  store: JobStore,
  job: Job,
  graph: SceneGraph,
  native: NativeSceneObservation[],
  attemptId: string,
): SceneSnapshotRef {
  const parsed = sceneGraphSchema.parse(graph);
  if (
    parsed.imageHash !== job.imageHash ||
    parsed.image.width !== job.image.width ||
    parsed.image.height !== job.image.height
  )
    throw new AppError(
      409,
      'SCENE_IMAGE_MISMATCH',
      'Scene evidence belongs to a different photograph.',
    );
  const payload = { graph: parsed, native };
  const ref: SceneSnapshotRef = {
    snapshotId: randomUUID(),
    snapshotHash: digest(payload),
    imageHash: job.imageHash,
    sourceAttemptId: attemptId,
    createdAt: Date.now(),
    ...(job.scene?.snapshotRef
      ? { parentSnapshotId: job.scene.snapshotRef.snapshotId }
      : {}),
  };
  store.db
    .prepare('INSERT INTO scene_snapshots VALUES (?,?,?,?)')
    .run(
      ref.snapshotId,
      job.analysisId,
      JSON.stringify(ref),
      JSON.stringify(payload),
    );
  job.scene!.snapshotRef = ref;
  return ref;
}
export function getSceneSnapshot(store: JobStore, id: string): SceneSnapshot {
  const row = store.db
    .prepare('SELECT metadata,data FROM scene_snapshots WHERE id=?')
    .get(id);
  if (!row)
    throw new AppError(
      409,
      'SCENE_SNAPSHOT_NOT_FOUND',
      'Scene evidence was not found.',
    );
  const ref = JSON.parse(row.metadata as string) as SceneSnapshotRef;
  const payload = JSON.parse(row.data as string) as Pick<
    SceneSnapshot,
    'graph' | 'native'
  >;
  if (digest(payload) !== ref.snapshotHash)
    throw new AppError(
      409,
      'SCENE_HASH_MISMATCH',
      'Scene evidence failed its integrity check.',
    );
  return { ref, ...payload };
}
export function sceneSnapshots(store: JobStore, analysisId: string) {
  return store.db
    .prepare(
      'SELECT id FROM scene_snapshots WHERE analysis_id=? ORDER BY rowid',
    )
    .all(analysisId)
    .map((row) => getSceneSnapshot(store, row.id as string));
}
