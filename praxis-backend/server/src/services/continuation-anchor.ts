import { decodeMaskToRaster } from '@meta-sam/parser';
import type { Detection } from '../schemas/vision.js';
/** Choose one anchor on one observed boundary-touching component, never across disconnected fragments. */
export function uncertainContinuationAnchor(
  c: Detection,
):
  | { point: [number, number] }
  | { reason: 'no_safe_anchor' | 'ambiguous_boundary_components' } {
  const m = c.encodedMask,
    crop = c.cropOrigin;
  if (!m || !crop || m.width * m.height > 4_000_000)
    return { reason: 'no_safe_anchor' };
  try {
    const raster = decodeMaskToRaster(m),
      seen = new Uint8Array(raster.length),
      queue = new Int32Array(raster.length);
    const components: {
      area: number;
      anchor: [number, number];
      inset: number;
    }[] = [];
    const point = (i: number): [number, number] => [
      Math.floor(c.bbox[0] + (((i % m.width) + 0.5) * c.bbox[2]) / m.width),
      Math.floor(
        c.bbox[1] + ((Math.floor(i / m.width) + 0.5) * c.bbox[3]) / m.height,
      ),
    ];
    const inset = ([x, y]: [number, number]) =>
      Math.min(
        x - crop[0],
        y - crop[1],
        crop[0] + crop[2] - 1 - x,
        crop[1] + crop[3] - 1 - y,
      );
    for (let i = 0; i < raster.length; i++) {
      if (!raster[i] || seen[i]) continue;
      let head = 0,
        tail = 1,
        touches = false,
        best = -Infinity,
        anchor = point(i);
      queue[0] = i;
      seen[i] = 1;
      while (head < tail) {
        const j = queue[head++]!,
          x = j % m.width,
          y = Math.floor(j / m.width),
          p = point(j),
          d = inset(p);
        if (d <= Math.max(2, c.bbox[2] / m.width, c.bbox[3] / m.height))
          touches = true;
        if (d > best) {
          best = d;
          anchor = p;
        }
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy,
              n = ny * m.width + nx;
            if (
              nx < 0 ||
              ny < 0 ||
              nx >= m.width ||
              ny >= m.height ||
              seen[n] ||
              !raster[n]
            )
              continue;
            seen[n] = 1;
            queue[tail++] = n;
          }
      }
      if (touches && tail >= 6 && best >= 2)
        components.push({ area: tail, anchor, inset: best });
    }
    components.sort((a, b) => b.area - a.area);
    if (!components.length) return { reason: 'no_safe_anchor' };
    if (components[1] && components[0]!.area < components[1].area * 1.25)
      return { reason: 'ambiguous_boundary_components' };
    return { point: components[0]!.anchor };
  } catch {
    return { reason: 'no_safe_anchor' };
  }
}
