import { decodeMaskToRaster, decodeMaskToSVGPath } from '@meta-sam/parser';
import type {
  BoundingBox,
  Detection,
  PreparedImage,
} from '../schemas/vision.js';
import {
  maskSchema,
  type MaskGeometry,
  type RegionReason,
  type WirePrompt,
} from '../schemas/geometry.js';

export interface ResolvedMask {
  geometry: MaskGeometry;
  signature: Set<number>;
}
type Resolution =
  { ok: true; mask: ResolvedMask } | { ok: false; reason: RegionReason };

/** Thin a small binary copy for a conservative endpoint/branch plausibility check. */
export function wireTopology(
  raster: Uint8Array,
  width: number,
  height: number,
): {
  valid: boolean;
  ends: number;
  branches: number;
  converged: boolean;
  scale: number;
} {
  const scale = Math.min(1, 128 / Math.max(width, height));
  const w = Math.max(1, Math.ceil(width * scale)) + 2;
  const h = Math.max(1, Math.ceil(height * scale)) + 2;
  const grid = new Uint8Array(w * h);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (raster[y * width + x])
        grid[(1 + Math.floor(y * scale)) * w + 1 + Math.floor(x * scale)] = 1;
  const neighbors = (i: number) => [
    grid[i - w]!,
    grid[i - w + 1]!,
    grid[i + 1]!,
    grid[i + w + 1]!,
    grid[i + w]!,
    grid[i + w - 1]!,
    grid[i - 1]!,
    grid[i - w - 1]!,
  ];
  for (let iteration = 0; iteration < 32; iteration++) {
    let changed = false;
    for (let phase = 0; phase < 2; phase++) {
      const remove: number[] = [];
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!grid[i]) continue;
          const p = neighbors(i);
          const count = p.reduce((a, b) => a + b, 0);
          const transitions = p.filter(
            (value, j) => !value && p[(j + 1) % 8],
          ).length;
          if (count < 2 || count > 6 || transitions !== 1) continue;
          const first =
            phase === 0 ? p[0]! * p[2]! * p[4]! : p[0]! * p[2]! * p[6]!;
          const second =
            phase === 0 ? p[2]! * p[4]! * p[6]! : p[0]! * p[4]! * p[6]!;
          if (!first && !second) remove.push(i);
        }
      for (const i of remove) grid[i] = 0;
      if (remove.length) changed = true;
    }
    if (!changed) break;
    if (iteration === 31)
      return { valid: false, ends: 0, branches: 0, converged: false, scale };
  }
  let ends = 0;
  let branches = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!grid[i]) continue;
      const p = neighbors(i);
      if (p.reduce((a, b) => a + b, 0) === 1) ends++;
      if (p.filter((value, j) => !value && p[(j + 1) % 8]).length >= 3)
        branches++;
    }
  return {
    valid: ends === 2 && branches === 0,
    ends,
    branches,
    converged: true,
    scale,
  };
}

export function maskComponents(
  raster: Uint8Array,
  width: number,
  height: number,
): { area: number; largest: number; perimeter: number; components: number } {
  const seen = new Uint8Array(raster.length);
  const queue = new Int32Array(raster.length);
  let area = 0,
    largest = 0,
    perimeter = 0,
    components = 0;
  for (let i = 0; i < raster.length; i++) {
    if (!raster[i]) continue;
    area++;
    const x = i % width,
      y = Math.floor(i / width);
    perimeter +=
      Number(x === 0 || !raster[i - 1]) +
      Number(x === width - 1 || !raster[i + 1]) +
      Number(y === 0 || !raster[i - width]) +
      Number(y === height - 1 || !raster[i + width]);
    if (seen[i]) continue;
    components++;
    let head = 0,
      tail = 1;
    queue[0] = i;
    seen[i] = 1;
    while (head < tail) {
      const offset = queue[head++]!,
        cx = offset % width,
        cy = Math.floor(offset / width);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx,
            ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (raster[next] && !seen[next]) {
            seen[next] = 1;
            queue[tail++] = next;
          }
        }
    }
    largest = Math.max(largest, tail);
  }
  return { area, largest, perimeter, components };
}

/** Simplify pixel contours without turning a thin outline into a broad rectangle. */
export function simplifyPath(path: string): string {
  const contours = path.match(/M[^M]+/g) ?? [];
  return contours
    .map((contour) => {
      const points: [number, number][] = [
        ...contour.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g),
      ].map((match) => [Number(match[1]), Number(match[2])]);
      if (points.length < 3) return '';
      const keep = new Set([0, points.length - 1]);
      const work: [number, number][] = [[0, points.length - 1]];
      while (work.length) {
        const [start, end] = work.pop()!,
          a = points[start]!,
          b = points[end]!;
        const dx = b[0] - a[0],
          dy = b[1] - a[1],
          length = dx * dx + dy * dy;
        let max = 0.35 * 0.35,
          index = -1;
        for (let i = start + 1; i < end; i++) {
          const p = points[i]!,
            t = length
              ? Math.max(
                  0,
                  Math.min(
                    1,
                    ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length,
                  ),
                )
              : 0;
          const distance =
            (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
          if (distance > max) {
            max = distance;
            index = i;
          }
        }
        if (index >= 0) {
          keep.add(index);
          work.push([start, index], [index, end]);
        }
      }
      const selected = points.filter((_p, i) => keep.has(i));
      return selected.length < 3
        ? ''
        : selected.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('') +
            'Z';
    })
    .join('');
}

function covers(
  raster: Uint8Array,
  width: number,
  height: number,
  bbox: BoundingBox,
  point: [number, number],
  radius: number,
): boolean {
  const x = Math.floor(((point[0] - bbox[0]) * width) / bbox[2]),
    y = Math.floor(((point[1] - bbox[1]) * height) / bbox[3]);
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++)
      if (
        x + dx >= 0 &&
        y + dy >= 0 &&
        x + dx < width &&
        y + dy < height &&
        raster[(y + dy) * width + x + dx]
      )
        return true;
  return false;
}

/** Per-analysis quotas bound decode work, contour complexity and serialized geometry. */
export class WireGeometry {
  private decodedPixels = 0;
  private pathBytes = 0;
  private readonly accepted: ResolvedMask[] = [];
  constructor(
    private readonly image: Pick<PreparedImage, 'width' | 'height'>,
  ) {}

  resolve(detection: Detection, prompt?: WirePrompt): Resolution {
    const raw = detection.encodedMask;
    if (!raw) return { ok: false, reason: 'no_mask' };
    const pixels = raw.width * raw.height;
    if (
      raw.width > 8192 ||
      raw.height > 8192 ||
      pixels > 4_000_000 ||
      this.decodedPixels + pixels > 12_000_000
    )
      return { ok: false, reason: 'geometry_budget' };
    this.decodedPixels += pixels;
    try {
      const raster = decodeMaskToRaster(raw);
      const { area, largest, perimeter } = maskComponents(
        raster,
        raw.width,
        raw.height,
      );
      const aspect = Math.max(
        detection.bbox[2] / detection.bbox[3],
        detection.bbox[3] / detection.bbox[2],
      );
      if (
        area < 6 ||
        largest / area < 0.95 ||
        (area / pixels > 0.5 && aspect < 4) ||
        perimeter > 6000 ||
        !wireTopology(raster, raw.width, raw.height).valid
      )
        return { ok: false, reason: 'ambiguous_mask' };
      if (
        prompt &&
        (!prompt.positivePoints.every((point) =>
          covers(raster, raw.width, raw.height, detection.bbox, point, 1),
        ) ||
          prompt.negativePoints.some((point) =>
            covers(raster, raw.width, raw.height, detection.bbox, point, 0),
          ))
      )
        return { ok: false, reason: 'prompt_mismatch' };
      const signature = new Set<number>();
      for (let y = 0; y < raw.height; y++)
        for (let x = 0; x < raw.width; x++)
          if (raster[y * raw.width + x]) {
            const gx = Math.min(
              255,
              Math.floor(
                ((detection.bbox[0] +
                  ((x + 0.5) * detection.bbox[2]) / raw.width) /
                  this.image.width) *
                  256,
              ),
            );
            const gy = Math.min(
              255,
              Math.floor(
                ((detection.bbox[1] +
                  ((y + 0.5) * detection.bbox[3]) / raw.height) /
                  this.image.height) *
                  256,
              ),
            );
            signature.add(gy * 256 + gx);
          }
      for (const other of this.accepted) {
        let intersection = 0;
        for (const pixel of signature)
          if (other.signature.has(pixel)) intersection++;
        const union = signature.size + other.signature.size - intersection;
        if (
          intersection / union > 0.65 ||
          (intersection / Math.min(signature.size, other.signature.size) >
            0.85 &&
            intersection / Math.max(signature.size, other.signature.size) > 0.5)
        )
          return { ok: false, reason: 'duplicate_mask' };
      }
      const path = simplifyPath(decodeMaskToSVGPath(raw));
      const parsed = maskSchema.safeParse({
        format: 'svg_path',
        width: raw.width,
        height: raw.height,
        path,
      });
      if (!parsed.success || this.pathBytes + path.length > 120000)
        return { ok: false, reason: 'geometry_budget' };
      this.pathBytes += path.length;
      const mask = { geometry: parsed.data, signature };
      this.accepted.push(mask);
      return { ok: true, mask };
    } catch {
      return { ok: false, reason: 'invalid_mask' };
    }
  }
}
