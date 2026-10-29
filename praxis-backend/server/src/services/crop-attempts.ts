import { createHash } from 'node:crypto';
import type { CropAttempt } from '../schemas/wire-recovery.js';
import type { BoundingBox } from '../schemas/vision.js';
export const sameRegion = (a: BoundingBox, b: BoundingBox) =>
  a.every((n, i) => n === b[i]);
/** Old visited records prove an attempt only; never infer successful inspection. Stable IDs avoid read-time mutation. */
export function normalizeCropAttempts(
  visited: BoundingBox[],
  attempts: CropAttempt[] = [],
): CropAttempt[] {
  const out = structuredClone(attempts);
  for (const region of visited)
    if (!out.some((a) => sameRegion(a.region, region))) {
      const h = createHash('sha256')
        .update('legacy-crop:' + JSON.stringify(region))
        .digest('hex');
      const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
      out.push({
        attemptId: id,
        region,
        status: 'legacy_unknown',
        upstreamOutcome: 'unknown',
        startedAt: 0,
      });
    }
  return out;
}
export function finishRunningCrops(
  attempts: CropAttempt[],
  status: 'interrupted' | 'timed_out' | 'failed',
  errorCode: string,
  now = Date.now(),
) {
  for (const a of attempts)
    if (a.status === 'running') {
      a.status = status;
      a.finishedAt = now;
      a.errorCode = errorCode;
    }
}
