import {
  annotationContentSchema,
  type AnnotationContent,
} from '../schemas/connector-validation.js';
/** End-exclusive horizontal spans in orientation-corrected source-image pixels. */
export function rasterizeRuns(runs: number[][], width: number, height: number) {
  if (width * height > 4000000)
    throw new Error('Reference exceeds the pixel quota.');
  const raster = new Uint8Array(width * height);
  let previousY = -1,
    previousEnd = 0;
  for (const [y, x, end] of runs) {
    if (
      y === undefined ||
      x === undefined ||
      end === undefined ||
      y >= height ||
      end > width ||
      end <= x ||
      y < previousY ||
      (y === previousY && x <= previousEnd)
    )
      throw new Error(
        'Reference spans must be sorted, disjoint and canonical.',
      );
    raster.fill(1, y * width + x, y * width + end);
    previousY = y;
    previousEnd = end;
  }
  return raster;
}
export function validateAnnotation(
  input: AnnotationContent,
  image: { width: number; height: number },
  requireComplete = false,
) {
  const content = annotationContentSchema.parse(input);
  const regions = Object.fromEntries(
    Object.entries(content.regions).map(([name, runs]) => [
      name,
      rasterizeRuns(runs, image.width, image.height),
    ]),
  ) as Record<keyof AnnotationContent['regions'], Uint8Array>;
  const counts = { connector: 0, redWire: 0, blackWire: 0, uncertain: 0 };
  for (let i = 0; i < image.width * image.height; i++) {
    let owners = 0;
    for (const name of [
      'connector',
      'redWire',
      'blackWire',
      'uncertain',
    ] as const) {
      if (regions[name][i]) {
        owners++;
        counts[name]++;
      }
    }
    if (owners > 1)
      throw new Error(
        'Reference classes overlap. Label disputed pixels uncertain instead.',
      );
  }
  if (
    requireComplete &&
    (!counts.connector || !counts.redWire || !counts.blackWire)
  )
    throw new Error(
      'Freeze requires connector, red-wire and black-wire foreground.',
    );
  return { content, regions, counts };
}
/** Deterministic uncertainty band applied at freeze: every pixel within this
 * Chebyshev distance of a differently labelled pixel (background included) is
 * moved to the uncertain class. Boundary pixels are where blinded annotators
 * disagree most; excluding them makes the reference reproducible without
 * touching the prediction. Same role as the void border in PASCAL VOC. */
export const referenceBoundaryBandPx = 2;
export function encodeRuns(raster: Uint8Array, width: number, height: number) {
  const runs: [number, number, number][] = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; ) {
      if (!raster[row + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < width && raster[row + x]) x++;
      runs.push([y, start, x]);
    }
  }
  if (runs.length > 120000)
    throw new Error('Reference exceeds the run quota.');
  return runs;
}
/** Returns new region runs with the boundary band moved to uncertain.
 * Pure function of the annotation; the prediction is never consulted. */
export function applyBoundaryBand(
  regions: Record<keyof AnnotationContent['regions'], Uint8Array>,
  width: number,
  height: number,
  band = referenceBoundaryBandPx,
) {
  const names = ['connector', 'redWire', 'blackWire'] as const;
  const label = new Uint8Array(width * height);
  for (let i = 0; i < label.length; i++)
    label[i] = regions.uncertain[i]
      ? 4
      : regions.connector[i]
        ? 1
        : regions.redWire[i]
          ? 2
          : regions.blackWire[i]
            ? 3
            : 0;
  const uncertain = new Uint8Array(regions.uncertain),
    out = Object.fromEntries(
      names.map((n) => [n, new Uint8Array(regions[n])]),
    ) as Record<(typeof names)[number], Uint8Array>;
  let moved = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        own = label[i]!;
      if (own === 4) continue;
      let edge = false;
      for (let dy = -band; dy <= band && !edge; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -band; dx <= band; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const other = label[ny * width + nx]!;
          // Background next to background is not an edge; labelled pixels next
          // to anything different, and background next to any label, are.
          if (other !== own && other !== 4 && (own !== 0 || other !== 0)) {
            edge = true;
            break;
          }
        }
      }
      if (!edge) continue;
      uncertain[i] = 1;
      moved++;
      if (own) out[names[own - 1]!][i] = 0;
    }
  return {
    regions: { ...out, uncertain },
    runs: {
      connector: encodeRuns(out.connector, width, height),
      redWire: encodeRuns(out.redWire, width, height),
      blackWire: encodeRuns(out.blackWire, width, height),
      uncertain: encodeRuns(uncertain, width, height),
    },
    movedPixels: moved,
  };
}
export function pixelMetrics(
  prediction: Uint8Array,
  body: Uint8Array,
  red: Uint8Array,
  black: Uint8Array,
  uncertain: Uint8Array,
) {
  let ground = 0,
    predicted = 0,
    intersection = 0,
    redLeak = 0,
    blackLeak = 0,
    excluded = 0;
  if ([body, red, black, uncertain].some((r) => r.length !== prediction.length))
    throw new Error('Pixel canvas mismatch.');
  for (let i = 0; i < body.length; i++) {
    if (uncertain[i]) {
      excluded++;
      continue;
    }
    ground += body[i] ? 1 : 0;
    if (prediction[i]) {
      predicted++;
      if (body[i]) intersection++;
      if (red[i]) redLeak++;
      if (black[i]) blackLeak++;
    }
  }
  if (!ground) throw new Error('No valid reference connector foreground.');
  return {
    iou: intersection / (ground + predicted - intersection),
    recall: intersection / ground,
    precision: predicted ? intersection / predicted : null,
    leakage: predicted ? (redLeak + blackLeak) / predicted : null,
    redWireLeakage: predicted ? redLeak / predicted : null,
    blackWireLeakage: predicted ? blackLeak / predicted : null,
    foregroundPixels: predicted,
    excludedPixels: excluded,
  };
}
