import { createHash } from 'node:crypto';
import type { SamSnapshot } from '../services/vision.js';

export const SNAPSHOT_PROCESSING_VERSION = 'sam-checkpoint-v1';
export interface SnapshotRef {
  samSnapshotId: string;
  samSnapshotHash: string;
  imageHash: string;
  model: string;
  processingVersion: string;
  sourceAttemptId: string;
  createdAt: number;
  origin: 'recorded' | 'legacy_import';
}
export interface SnapshotRecord {
  ref: SnapshotRef;
  snapshot: SamSnapshot;
}
/** Object key order must not change the identity of otherwise identical evidence. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function snapshotHash(
  snapshot: SamSnapshot,
  context: Pick<SnapshotRef, 'imageHash' | 'model' | 'processingVersion'>,
): string {
  return createHash('sha256')
    .update(
      canonical({
        imageHash: context.imageHash,
        model: context.model,
        processingVersion: context.processingVersion,
        snapshot,
      }),
    )
    .digest('hex');
}
