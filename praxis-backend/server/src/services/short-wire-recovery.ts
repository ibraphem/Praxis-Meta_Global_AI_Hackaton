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
    .slice(0, 3)
    .forEach(add);
  const components = snapshot.candidates.filter(
    (c) => c.type !== 'jumper_wire' && c.type !== 'breadboard',
  );
  components.slice(0, 2).forEach((c) => {
    add([c.bbox[0], c.bbox[1]]);
    add([c.bbox[0] + c.bbox[2], c.bbox[1] + c.bbox[3]]);
  });
  const grid = context?.gridPoints ?? [];
  for (let i = 0; i < 4 && grid.length; i++)
    add(
      grid[
        Math.min(grid.length - 1, Math.floor(((i + 0.5) * grid.length) / 4))
      ]!,
    );
  report.candidates
    .filter((c) => c.source === 'cv_trace' && c.candidateCoverage < 0.8)
    .sort(
      (a, b) => Math.max(a.bbox[2], a.bbox[3]) - Math.max(b.bbox[2], b.bbox[3]),
    )
    .slice(0, 4)
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
  const bytes = Buffer.from(image.dataUrl.split(',')[1]!, 'base64'),
    regions: ShortRegion[] = [];
  for (const center of centers.slice(0, 12)) {
    const crop = smallBox(center, size, image),
      [left, top, width, height] = crop;
    const { data } = await sharp(bytes)
      .extract({ left, top, width, height })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
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
        report.candidates.some(
          (old) =>
            old.geometryAccepted &&
            bbox[0] >= old.bbox[0] &&
            bbox[1] >= old.bbox[1] &&
            bbox[0] + bbox[2] <= old.bbox[0] + old.bbox[2] &&
            bbox[1] + bbox[3] <= old.bbox[1] + old.bbox[3],
        )
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
      regions.push({
        crop,
        bbox,
        positivePoints: seeds,
        negativePoints: negatives.filter(
          (n) =>
            !points.some((p) => Math.hypot(n[0] - p[0], n[1] - p[1]) < pitch),
        ),
        source: 'automatic',
        evidence: c.color === 'dark' ? 'dark_line' : 'color_line',
      });
      if (regions.length >= 16) return regions;
    }
  }
  return regions;
}
