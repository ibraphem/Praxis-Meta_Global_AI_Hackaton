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
