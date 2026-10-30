import { maskEvidenceReader } from './wire-mask-evidence.js';
import { cropWorkAttempted } from './crop-attempts.js';
import type { CropAttempt } from '../schemas/wire-recovery.js';
import sharp from 'sharp';
import { classicalTraces } from './wire-coverage.js';
import type { SamSnapshot } from './vision.js';
import type { RecoveryReport, ShortRegion } from '../schemas/wire-recovery.js';
import type { BoundingBox } from '../schemas/vision.js';
export function smallBox(
  center: [number, number],
  size: number,
  image: { width: number; height: number },
): BoundingBox {
  const width = Math.min(image.width, Math.round(size)),
    height = Math.min(image.height, Math.round(size));
  return [
    Math.max(
      0,
      Math.min(image.width - width, Math.round(center[0] - width / 2)),
    ),
    Math.max(
      0,
      Math.min(image.height - height, Math.round(center[1] - height / 2)),
    ),
    width,
    height,
  ];
}
/** Local native-resolution scans propose spatial prompts. No hole or connection is inferred. */
export async function shortWireRegions(
  snapshot: SamSnapshot,
  report: RecoveryReport,
  context?: { pitchPx: number; gridPoints: [number, number][] },
  manual?: [number, number],
  attempts: CropAttempt[] = [],
): Promise<ShortRegion[]> {
  const image = snapshot.image,
    pitch =
      context?.pitchPx ?? Math.max(8, Math.min(image.width, image.height) / 80),
    size = Math.min(512, Math.max(96, Math.round(pitch * 12)));
  if (manual) {
    const crop = smallBox(manual, size, image);
    return [
      {
        crop,
        bbox: crop,
        positivePoints: [manual],
        negativePoints: [],
        source: 'human',
        evidence: 'reviewer_seed',
      },
    ];
  }
  const centers: [number, number][] = [];
  const add = (p: [number, number]) => {
    if (!centers.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < size / 3))
      centers.push(p);
  };
  report.candidates
    .filter((c) => c.touchesCropBoundary)
    .flatMap((c) => c.cropExitPoints ?? [])
    .forEach(add);
  const components = snapshot.candidates.filter(
    (c) => c.type !== 'jumper_wire' && c.type !== 'breadboard',
  );
  components.forEach((c) => {
    add([c.bbox[0], c.bbox[1]]);
    add([c.bbox[0] + c.bbox[2], c.bbox[1] + c.bbox[3]]);
  });
  const grid = context?.gridPoints ?? [];
  for (let i = 0; i < Math.min(16, grid.length) && grid.length; i++)
    add(
      grid[
        Math.min(
          grid.length - 1,
          Math.floor(((i + 0.5) * grid.length) / Math.min(16, grid.length)),
        )
      ]!,
    );
  report.candidates
    .filter((c) => c.source === 'cv_trace' && c.candidateCoverage < 0.8)
    .sort(
      (a, b) => Math.max(a.bbox[2], a.bbox[3]) - Math.max(b.bbox[2], b.bbox[3]),
    )
    .forEach((c) =>
      add([c.bbox[0] + c.bbox[2] / 2, c.bbox[1] + c.bbox[3] / 2]),
    );
  snapshot.candidates
    .filter((c) => c.type === 'breadboard')
    .forEach((c) => {
      for (let y = c.bbox[1]; y < c.bbox[1] + c.bbox[3]; y += size * 0.75)
        for (let x = c.bbox[0]; x < c.bbox[0] + c.bbox[2]; x += size * 0.75)
          add([x + size / 2, y + size / 2]);
    });
  // Decode the original once; dozens of JPEG decodes would dominate this local pass.
  const { data: original } = await sharp(
    Buffer.from(image.dataUrl.split(',')[1]!, 'base64'),
  )
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const regions: ShortRegion[] = [];
  const read = maskEvidenceReader();
  const masks = snapshot.candidates
    .filter(
      (c) =>
        c.type === 'jumper_wire' &&
        report.candidates.some(
          (r) => r.id === c.id && r.candidateCoverage === 1,
        ),
    )
    .map((c) => read(c))
    .filter((p) => p?.size);
  const covered = (points: [number, number][]) =>
    points.filter(([x, y]) =>
      masks.some((mask) => {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (mask!.has((y + dy) * 32768 + x + dx)) return true;
        return false;
      }),
    ).length /
      points.length >=
    0.8;
  // Bound CPU/pixel work, but spread scans across the entire board instead of taking a prefix.
  const count = Math.min(
    64,
    centers.length,
    Math.floor(
      12_000_000 / (Math.min(size, image.width) * Math.min(size, image.height)),
    ),
  );
  const scan = Array.from(
    { length: count },
    (_, i) =>
      centers[
        Math.min(
          centers.length - 1,
          Math.floor(((i + 0.5) * centers.length) / count),
        )
      ]!,
  );
  for (const center of scan) {
    if (regions.length >= 128) break;
    const crop = smallBox(center, size, image),
      [left, top, width, height] = crop;
    const data = Buffer.alloc(width * height * 3);
    for (let row = 0; row < height; row++)
      original.copy(
        data,
        row * width * 3,
        ((top + row) * image.width + left) * 3,
        ((top + row) * image.width + left + width) * 3,
      );
    const traces = classicalTraces(data, width, height, { width, height }, 32, {
      short: true,
    }).candidates.sort(
      (a, b) =>
        Number(!['red/orange', 'dark'].includes(a.color ?? '')) -
        Number(!['red/orange', 'dark'].includes(b.color ?? '')),
    );
    for (const c of traces) {
      if (c.metrics.branches > 2 || c.points.length < 2) continue;
      const points = c.points.map(
        ([x, y]) =>
          [Math.floor(x + left), Math.floor(y + top)] as [number, number],
      );
      const bbox: BoundingBox = [
        c.bbox[0] + left,
        c.bbox[1] + top,
        c.bbox[2],
        c.bbox[3],
      ];
      if (
        regions.some(
          (r) => Math.hypot(r.bbox[0] - bbox[0], r.bbox[1] - bbox[1]) < pitch,
        ) ||
        covered(points)
      )
        continue;
      const seeds = [
        points[Math.floor(points.length / 3)]!,
        points[Math.floor((2 * points.length) / 3)]!,
      ];
      const negatives: [[number, number], [number, number]] = [
        [left, top],
        [left + width - 1, top + height - 1],
      ];
      const region: ShortRegion = {
        crop,
        bbox,
        positivePoints: seeds,
        negativePoints: negatives.filter(
          (n) =>
            !points.some((p) => Math.hypot(n[0] - p[0], n[1] - p[1]) < pitch),
        ),
        source: 'automatic',
        evidence: c.color === 'dark' ? 'dark_line' : 'color_line',
      };
      if (
        !cropWorkAttempted(attempts, crop, {
          bbox,
          positivePoints: seeds,
          negativePoints: region.negativePoints,
        })
      )
        regions.push(region);
      if (regions.length >= 128) break;
    }
  }
  return regions.slice(0, 16);
}
