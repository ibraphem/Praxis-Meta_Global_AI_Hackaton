import { cropFragment } from './wire-fragments.js';
import { maskEvidenceReader } from './wire-mask-evidence.js';
import type { BoundingBox, Detection } from '../schemas/vision.js';
import type { RecoveryReport } from '../schemas/wire-recovery.js';
import type { SamSnapshot } from './vision.js';

export interface RecoveryTarget {
  crop: BoundingBox;
  bbox: BoundingBox;
  positivePoints: [number, number][];
  negativePoints: [number, number][];
  mode: 'continuation' | 'short' | 'human';
  candidateId?: string;
}

/** Supports a reviewable mask revision only; never establishes physical identity or bridges a gap. */
export function extendsCropFragment(
  old: Detection,
  next: Detection,
  read = maskEvidenceReader(),
): boolean {
  const fragment = cropFragment(old),
    crop = fragment.cropOrigin;
  if (!crop || !fragment.touchesCropBoundary) return false;
  const a = read(old),
    b = read(next);
  if (!a?.size || !b?.size || b.size < a.size * 1.15) return false;
  let overlap = 0,
    outside = 0;
  for (const p of a) if (b.has(p)) overlap++;
  for (const p of b) {
    const x = p % 32768,
      y = Math.floor(p / 32768);
    if (
      x < crop[0] ||
      y < crop[1] ||
      x >= crop[0] + crop[2] ||
      y >= crop[1] + crop[3]
    )
      outside++;
  }
  return overlap / a.size >= 0.95 && outside >= Math.max(6, b.size * 0.05);
}

/** Enclose the observed fragment plus unobserved margins at native resolution. No synthesized mask pixels. */
export function continuationRegions(
  snapshot: SamSnapshot,
  report: RecoveryReport,
  maxPixels: number,
): RecoveryTarget[] {
  const read = maskEvidenceReader(),
    targets: RecoveryTarget[] = [];
  for (const observed of report.candidates) {
    if (
      !observed.touchesCropBoundary ||
      observed.metrics.ends !== 2 ||
      observed.metrics.branches
    )
      continue;
    const source = snapshot.candidates.find((c) => c.id === observed.id);
    if (
      !source ||
      source.type !== 'jumper_wire' ||
      source.recoveryPromptMatched === false
    )
      continue;
    // A completed extension already exists: retain the old fragment, do not spend another request on it.
    if (
      snapshot.candidates.some(
        (c) =>
          c !== source &&
          c.type === 'jumper_wire' &&
          !cropFragment(c).touchesCropBoundary &&
          report.candidates.some((r) => r.id === c.id && r.geometryAccepted) &&
          extendsCropFragment(source, c, read),
      )
    )
      continue;
    const pixels = read(source);
    if (!pixels?.size) continue;
    const b = source.bbox,
      margin = Math.max(48, Math.max(b[2], b[3]) * 0.75);
    const make = (pad: number): BoundingBox => {
      const left = Math.max(0, Math.floor(b[0] - pad)),
        top = Math.max(0, Math.floor(b[1] - pad));
      return [
        left,
        top,
        Math.min(snapshot.image.width, Math.ceil(b[0] + b[2] + pad)) - left,
        Math.min(snapshot.image.height, Math.ceil(b[1] + b[3] + pad)) - top,
      ];
    };
    let crop = make(margin);
    if (crop[2] * crop[3] > maxPixels) {
      let low = 16,
        high = Math.ceil(margin);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2),
          trial = make(mid);
        if (trial[2] * trial[3] <= maxPixels) low = mid;
        else high = mid - 1;
      }
      crop = make(low);
    }
    if (
      crop[2] * crop[3] > maxPixels ||
      !observed.cropExitPoints?.some(
        ([x, y]) =>
          x > crop[0] + 8 &&
          y > crop[1] + 8 &&
          x < crop[0] + crop[2] - 8 &&
          y < crop[1] + crop[3] - 8,
      )
    )
      continue;
    // Anchor inside observed insulation, far from the artificial observation boundary.
    const oldCrop = observed.cropOrigin!;
    const anchors = [...pixels]
      .map((p) => [p % 32768, Math.floor(p / 32768)] as [number, number])
      .sort((a, b) => {
        const distance = ([x, y]: [number, number]) =>
          Math.min(
            x - oldCrop[0],
            y - oldCrop[1],
            oldCrop[0] + oldCrop[2] - x,
            oldCrop[1] + oldCrop[3] - y,
          );
        return distance(b) - distance(a);
      });
    const positivePoints: [number, number][] = [];
    for (const p of anchors) {
      if (
        positivePoints.every(
          (q) =>
            Math.hypot(p[0] - q[0], p[1] - q[1]) >
            Math.max(8, Math.max(b[2], b[3]) / 8),
        )
      )
        positivePoints.push(p);
      if (positivePoints.length === 3) break;
    }
    if (positivePoints.length)
      targets.push({
        crop,
        bbox: crop,
        positivePoints,
        negativePoints: [],
        mode: 'continuation',
        candidateId: source.id,
      });
  }
  // Long truncated traces need continuation; short jumpers also have their own discovery queue.
  const span = (target: RecoveryTarget) => {
    const box = snapshot.candidates.find(
      (c) => c.id === target.candidateId,
    )!.bbox;
    return Math.max(box[2], box[3]);
  };
  return targets.sort((a, b) => span(b) - span(a));
}
