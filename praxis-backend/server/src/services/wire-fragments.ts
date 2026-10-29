import { decodeMaskToRaster } from '@meta-sam/parser';
import type { Candidate, BoundingBox } from '../schemas/vision.js';
/** A crop edge is an observation boundary, never proof of a physical terminus. */
export function cropFragment(c: Pick<Candidate, 'bbox' | 'encodedMask'>): {
  cropOrigin?: BoundingBox;
  touchesCropBoundary: boolean;
  cropExitPoints: [number, number][];
} {
  const crop = (c as Candidate & { cropOrigin?: BoundingBox }).cropOrigin,
    m = c.encodedMask;
  if (!crop || !m || m.width * m.height > 4000000)
    return { touchesCropBoundary: false, cropExitPoints: [] };
  const points: [number, number][] = [];
  try {
    const pixels = decodeMaskToRaster(m);
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < m.width; x++)
        if (pixels[y * m.width + x]) {
          const gx = c.bbox[0] + ((x + 0.5) * c.bbox[2]) / m.width,
            gy = c.bbox[1] + ((y + 0.5) * c.bbox[3]) / m.height;
          if (
            Math.min(
              gx - crop[0],
              gy - crop[1],
              crop[0] + crop[2] - gx,
              crop[1] + crop[3] - gy,
            ) <= Math.max(2, c.bbox[2] / m.width, c.bbox[3] / m.height) &&
            !points.some((p) => Math.hypot(p[0] - gx, p[1] - gy) < 8)
          )
            points.push([gx, gy]);
        }
  } catch {
    return { cropOrigin: crop, touchesCropBoundary: true, cropExitPoints: [] };
  }
  return {
    cropOrigin: crop,
    touchesCropBoundary: points.length > 0,
    cropExitPoints: points.slice(0, 16),
  };
}

export function supportsSpatialPrompt(
  c: Pick<Candidate, 'bbox' | 'encodedMask'>,
  positive: [number, number][],
  negative: [number, number][],
): boolean {
  const m = c.encodedMask;
  if (!m || m.width * m.height > 4000000) return false;
  try {
    const raster = decodeMaskToRaster(m);
    const hit = (p: [number, number], radius: number) => {
      const x = Math.floor(((p[0] - c.bbox[0]) * m.width) / c.bbox[2]),
        y = Math.floor(((p[1] - c.bbox[1]) * m.height) / c.bbox[3]);
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++)
          if (
            x + dx >= 0 &&
            y + dy >= 0 &&
            x + dx < m.width &&
            y + dy < m.height &&
            raster[(y + dy) * m.width + x + dx]
          )
            return true;
      return false;
    };
    return positive.every((p) => hit(p, 1)) && !negative.some((p) => hit(p, 0));
  } catch {
    return false;
  }
}
