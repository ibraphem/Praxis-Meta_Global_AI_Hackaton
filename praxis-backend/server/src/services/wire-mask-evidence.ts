import { decodeMaskToRaster } from '@meta-sam/parser';
import type { Detection } from '../schemas/vision.js';

/** Native image pixels, bounded per operation. Boxes and coarse signatures are not wire identity. */
export function maskEvidenceReader(limit = 12_000_000) {
  const cache = new Map<Detection, Set<number> | undefined>();
  let decoded = 0;
  return (c: Detection): Set<number> | undefined => {
    if (cache.has(c)) return cache.get(c);
    const m = c.encodedMask;
    cache.set(c, undefined);
    if (
      !m ||
      m.width * m.height > 4_000_000 ||
      decoded + m.width * m.height > limit
    )
      return;
    decoded += m.width * m.height;
    try {
      const raster = decodeMaskToRaster(m),
        pixels = new Set<number>();
      for (let y = 0; y < m.height; y++)
        for (let x = 0; x < m.width; x++)
          if (raster[y * m.width + x]) {
            const gx = Math.floor(
                c.bbox[0] + ((x + 0.5) * c.bbox[2]) / m.width,
              ),
              gy = Math.floor(c.bbox[1] + ((y + 0.5) * c.bbox[3]) / m.height);
            pixels.add(gy * 32768 + gx);
            if (pixels.size > 100_000) return;
          }
      cache.set(c, pixels);
      return pixels;
    } catch {
      return;
    }
  };
}

/** Give new seed-validated observations a chance within existing decode/path quotas.
 * Earlier public masks are retained separately by checkpoint reconciliation; raw order never changes.
 */
export function prioritizeWireEvidence<T extends Detection>(
  candidates: T[],
): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        Number(b.candidate.recoveryPromptMatched === true) -
          Number(a.candidate.recoveryPromptMatched === true) ||
        (a.candidate.recoveryPromptMatched === true &&
        b.candidate.recoveryPromptMatched === true
          ? b.index - a.index
          : a.index - b.index),
    )
    .map(({ candidate }) => candidate);
}
