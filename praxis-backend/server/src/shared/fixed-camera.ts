export interface PixelFrame {
  width: number;
  height: number;
  data: Uint8Array;
}
export interface CameraAnchor {
  x: number;
  y: number;
}
const luma = (f: PixelFrame, x: number, y: number) => {
  const i = (y * f.width + x) * 3;
  return (
    (f.data[i]! * 299 + f.data[i + 1]! * 587 + f.data[i + 2]! * 114) / 1000
  );
};
export const fixedCameraPolicy = Object.freeze({
  version: 'fixed-camera-patches-v1' as const,
  radius: 8,
  maxMeanAbsoluteError: 12,
  minStdDeviation: 12,
  minDistinctiveness: 7,
  searchRadius: 20,
});
function patchError(
  a: PixelFrame,
  b: PixelFrame,
  p: CameraAnchor,
  dx = 0,
  dy = 0,
) {
  let sum = 0,
    n = 0;
  for (let y = -8; y <= 8; y++)
    for (let x = -8; x <= 8; x++) {
      sum += Math.abs(
        luma(a, Math.round(p.x) + x, Math.round(p.y) + y) -
          luma(b, Math.round(p.x) + x + dx, Math.round(p.y) + y + dy),
      );
      n++;
    }
  return sum / n;
}
export function checkFixedCamera(
  reference: PixelFrame,
  current: PixelFrame,
  anchors: CameraAnchor[],
) {
  const base = {
    policyVersion: fixedCameraPolicy.version,
    transform: 'identity' as const,
    observedAt: Date.now(),
  };
  if (
    reference.width !== current.width ||
    reference.height !== current.height ||
    anchors.length !== 4 ||
    reference.data.length !== reference.width * reference.height * 3 ||
    current.data.length !== current.width * current.height * 3
  )
    return {
      ...base,
      valid: false,
      reason: 'Frame dimensions or landmarks differ from the reviewed setup.',
      errors: [] as number[],
    };
  const xs = anchors.map((p) => p.x),
    ys = anchors.map((p) => p.y);
  const spread =
    Math.max(...xs) - Math.min(...xs) >= reference.width * 0.25 &&
    Math.max(...ys) - Math.min(...ys) >= reference.height * 0.25;
  const separated = anchors.every((a, i) =>
    anchors.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) >= 58),
  );
  let area = 0;
  for (const a of anchors)
    for (const b of anchors)
      for (const c of anchors)
        area = Math.max(
          area,
          Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2,
        );
  if (!spread || !separated || area < reference.width * reference.height * 0.03)
    return {
      ...base,
      valid: false,
      reason:
        'Use four separate, well-spread landmarks around the fixed circuit.',
      errors: [] as number[],
    };
  const errors: number[] = [];
  for (const p of anchors) {
    if (
      p.x < 29 ||
      p.y < 29 ||
      p.x >= reference.width - 29 ||
      p.y >= reference.height - 29
    )
      return {
        ...base,
        valid: false,
        reason:
          'Use four landmarks at least 29 pixels from the image boundary.',
        errors,
      };
    const values: number[] = [];
    for (let y = -8; y <= 8; y++)
      for (let x = -8; x <= 8; x++)
        values.push(luma(reference, Math.round(p.x) + x, Math.round(p.y) + y));
    const mean = values.reduce((a, b) => a + b, 0) / values.length,
      std = Math.sqrt(
        values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length,
      );
    if (std < fixedCameraPolicy.minStdDeviation)
      return {
        ...base,
        valid: false,
        reason:
          'A landmark is too uniform. Use distinctive fixed marks outside the movable wire.',
        errors,
      };
    let competitor = Infinity;
    for (let dy = -20; dy <= 20; dy += 4)
      for (let dx = -20; dx <= 20; dx += 4)
        if (dx * dx + dy * dy >= 64)
          competitor = Math.min(
            competitor,
            patchError(reference, reference, p, dx, dy),
          );
    if (competitor < fixedCameraPolicy.minDistinctiveness)
      return {
        ...base,
        valid: false,
        reason:
          'A landmark repeats nearby. Select distinctive fixed marks instead of a repeated hole pattern.',
        errors,
      };
    const error = patchError(reference, current, p);
    errors.push(error);
    if (error > fixedCameraPolicy.maxMeanAbsoluteError)
      return {
        ...base,
        valid: false,
        reason:
          'The camera/board landmarks changed or are obscured. Re-establish a clear, fixed view.',
        errors,
      };
  }
  return {
    ...base,
    valid: true,
    reason:
      'The four distinctive setup landmarks match at fixed image coordinates. This validates registration, not contact visibility.',
    errors,
  };
}
/** Conservative image-change check at both reviewed junctions; no object/hand classifier. */
export function junctionRegionsUnchanged(
  reference: PixelFrame,
  current: PixelFrame,
  points: CameraAnchor[],
) {
  if (
    points.length !== 2 ||
    reference.width !== current.width ||
    reference.height !== current.height
  )
    return false;
  return points.every((p) => {
    if (
      p.x < 6 ||
      p.y < 6 ||
      p.x >= reference.width - 6 ||
      p.y >= reference.height - 6
    )
      return false;
    const errors: number[] = [];
    for (let dy = -5; dy <= 5; dy++)
      for (let dx = -5; dx <= 5; dx++) {
        const i =
          ((Math.round(p.y) + dy) * reference.width + Math.round(p.x) + dx) * 3;
        errors.push(
          (Math.abs(reference.data[i]! - current.data[i]!) +
            Math.abs(reference.data[i + 1]! - current.data[i + 1]!) +
            Math.abs(reference.data[i + 2]! - current.data[i + 2]!)) /
            3,
        );
      }
    errors.sort((a, b) => b - a);
    return errors.slice(0, 18).reduce((a, b) => a + b, 0) / 18 <= 12;
  });
}
