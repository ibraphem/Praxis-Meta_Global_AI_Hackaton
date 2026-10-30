import { cropWorkAttempted, cropWorkKey, sameRegion } from './crop-attempts.js';
import type { CropAttempt } from '../schemas/wire-recovery.js';
import type { BoundingBox } from '../schemas/vision.js';
import type { RecoveryTarget } from './wire-continuation.js';
export interface CropWork {
  crop: BoundingBox;
  targets: RecoveryTarget[];
  mode: NonNullable<CropAttempt['mode']>;
  workKeys: string[];
}
/** Batch independent objects in one crop, with per-object evidence checks and a persistent work identity. */
export function recoveryPlan(
  continuations: RecoveryTarget[],
  short: RecoveryTarget[],
  tiles: BoundingBox[],
  attempts: CropAttempt[],
  reserveUncertain = false,
): CropWork[] {
  const groups = (targets: RecoveryTarget[]) => {
    const out: CropWork[] = [];
    for (const target of targets) {
      const prompt = {
        bbox: target.bbox,
        positivePoints: target.positivePoints,
        negativePoints: target.negativePoints,
      };
      const key = cropWorkKey(target.crop, prompt);
      if (
        cropWorkAttempted(attempts, target.crop, prompt) ||
        out.some((g) => g.workKeys.includes(key))
      )
        continue;
      const group = out.find(
        (g) =>
          g.mode === target.mode &&
          sameRegion(g.crop, target.crop) &&
          g.targets.length < 3,
      );
      if (group) {
        group.targets.push(target);
        group.workKeys.push(key);
      } else
        out.push({
          crop: target.crop,
          targets: [target],
          mode: target.mode,
          workKeys: [key],
        });
    }
    return out;
  };
  const uncertainWork = groups(
      continuations.filter((t) => t.mode === 'continuation_uncertain'),
    ),
    continuationWork = groups(
      continuations.filter((t) => t.mode !== 'continuation_uncertain'),
    ),
    shortWork = groups(short),
    out: CropWork[] = [];
  if (reserveUncertain && uncertainWork.length)
    out.push(uncertainWork.shift()!);
  // Reserve early request slots for both observed blockers; broad tiles consume only remaining slots.
  while (continuationWork.length || shortWork.length) {
    if (continuationWork.length) out.push(continuationWork.shift()!);
    if (shortWork.length) out.push(shortWork.shift()!);
  }
  out.push(...uncertainWork);
  for (const crop of tiles)
    if (
      !cropWorkAttempted(attempts, crop) &&
      !out.some((g) => !g.targets.length && sameRegion(g.crop, crop))
    )
      out.push({
        crop,
        targets: [],
        mode: 'tiles',
        workKeys: [cropWorkKey(crop)],
      });
  return out;
}
