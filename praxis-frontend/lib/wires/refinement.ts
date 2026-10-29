import type { Point } from "../breadboard/calibration";

export const REFINEMENT_POLICY = Object.freeze({
  version: "color-tip-experiment-v1",
  minContrast: 45,
  minComponentPixels: 8,
  minElongation: 4,
  maxMovementFraction: 0.65,
});
export interface RefinementResult {
  method: typeof REFINEMENT_POLICY.version;
  status: "supported_tip" | "rejected";
  originalPosition: Point;
  refinedPosition: Point | null;
  reason: string;
  physicalInsertion: "unverified";
  evidence: {
    contrast: number | null;
    componentPixels: number;
    elongation: number | null;
    movementPx: number | null;
  };
  elapsedMs: number;
}
export interface RefinementPatch {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  selectedMask: Uint8ClampedArray;
  origin: Point;
  seed: Point;
  searchRadius: number;
}
const median = (values: number[]) =>
  values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const distance = (a: number[], b: number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** No calibration or hole IDs enter this algorithm. Output is a review-only tip hypothesis. */
export function refineWireTip(patch: RefinementPatch): RefinementResult {
  const started = performance.now();
  const { width, height, rgba, selectedMask, origin, seed, searchRadius } =
    patch;
  const evidence: RefinementResult["evidence"] = {
    contrast: null,
    componentPixels: 0,
    elongation: null,
    movementPx: null,
  };
  const finish = (
    reason: string,
    refinedPosition: Point | null = null,
  ): RefinementResult => ({
    method: REFINEMENT_POLICY.version,
    status: refinedPosition ? "supported_tip" : "rejected",
    originalPosition: { ...seed },
    refinedPosition,
    physicalInsertion: "unverified",
    reason,
    evidence: { ...evidence },
    elapsedMs: Math.max(0, performance.now() - started),
  });
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 5 ||
    height < 5 ||
    width * height > 65536 ||
    rgba.length !== width * height * 4 ||
    selectedMask.length !== rgba.length ||
    ![seed.x, seed.y, origin.x, origin.y, searchRadius].every(
      Number.isFinite,
    ) ||
    searchRadius < 4 ||
    seed.x < origin.x ||
    seed.y < origin.y ||
    seed.x >= origin.x + width ||
    seed.y >= origin.y + height
  )
    return finish("invalid_patch");
  const samples = (inside: boolean) => {
    const channels: number[][] = [[], [], []];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (
          selectedMask[i + 3] > 127 !== inside ||
          Math.hypot(x + origin.x - seed.x, y + origin.y - seed.y) >
            searchRadius
        )
          continue;
        for (let c = 0; c < 3; c++) channels[c].push(rgba[i + c]);
      }
    return channels[0].length >= 8 ? channels.map(median) : null;
  };
  const foreground = samples(true),
    background = samples(false);
  if (!foreground || !background)
    return finish("insufficient_mask_or_background");
  const contrast = distance(foreground, background);
  evidence.contrast = contrast;
  if (contrast < REFINEMENT_POLICY.minContrast) return finish("low_contrast");
  const eligible = new Uint8Array(width * height);
  const tolerance = Math.max(25, contrast * 0.3);
  let start = -1,
    nearest = Infinity;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        rgb = [...rgba.subarray(i * 4, i * 4 + 3)];
      if (
        distance(rgb, foreground) > tolerance ||
        distance(rgb, background) < contrast * 0.5
      )
        continue;
      eligible[i] = 1;
      const d = Math.hypot(origin.x + x - seed.x, origin.y + y - seed.y);
      if (selectedMask[i * 4 + 3] > 127 && d < nearest) {
        start = i;
        nearest = d;
      }
    }
  if (start < 0 || nearest > searchRadius * 0.5)
    return finish("no_selected_wire_support");
  const component: number[] = [start],
    seen = new Uint8Array(eligible.length);
  seen[start] = 1;
  for (let head = 0; head < component.length; head++) {
    const i = component[head],
      x = i % width,
      y = Math.floor(i / width);
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const xx = x + dx,
        yy = y + dy,
        next = yy * width + xx;
      if (
        xx >= 0 &&
        yy >= 0 &&
        xx < width &&
        yy < height &&
        eligible[next] &&
        !seen[next]
      ) {
        seen[next] = 1;
        component.push(next);
      }
    }
  }
  evidence.componentPixels = component.length;
  if (component.length < REFINEMENT_POLICY.minComponentPixels)
    return finish("insufficient_wire_pixels");
  const points = component.map((i) => ({
    x: i % width,
    y: Math.floor(i / width),
  }));
  const mean = {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  };
  let xx = 0,
    yy = 0,
    xy = 0;
  for (const p of points) {
    xx += (p.x - mean.x) ** 2;
    yy += (p.y - mean.y) ** 2;
    xy += (p.x - mean.x) * (p.y - mean.y);
  }
  const root = Math.hypot(xx - yy, 2 * xy),
    major = (xx + yy + root) / 2,
    minor = (xx + yy - root) / 2;
  evidence.elongation = major / Math.max(1, minor);
  if (evidence.elongation < REFINEMENT_POLICY.minElongation)
    return finish("ambiguous_local_shape");
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy),
    axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const along = points.map((p) => ({
    ...p,
    t: (p.x - mean.x) * axis.x + (p.y - mean.y) * axis.y,
  }));
  const extrema = [
    Math.min(...along.map((p) => p.t)),
    Math.max(...along.map((p) => p.t)),
  ];
  const ends = extrema
    .map((t) => {
      const cap = along.filter((p) => Math.abs(p.t - t) <= 1);
      return {
        x: cap.reduce((s, p) => s + p.x, 0) / cap.length,
        y: cap.reduce((s, p) => s + p.y, 0) / cap.length,
      };
    })
    .sort(
      (a, b) =>
        Math.hypot(a.x + origin.x - seed.x, a.y + origin.y - seed.y) -
        Math.hypot(b.x + origin.x - seed.x, b.y + origin.y - seed.y),
    );
  const near = Math.hypot(
      ends[0].x + origin.x - seed.x,
      ends[0].y + origin.y - seed.y,
    ),
    far = Math.hypot(
      ends[1].x + origin.x - seed.x,
      ends[1].y + origin.y - seed.y,
    );
  if (far - near < 3) return finish("ambiguous_terminal_direction");
  const tip = ends[0];
  if (tip.x < 2 || tip.y < 2 || tip.x > width - 3 || tip.y > height - 3)
    return finish("terminal_truncated_by_patch");
  if (near > searchRadius * REFINEMENT_POLICY.maxMovementFraction)
    return finish("movement_too_large");
  const selectedPixels = points.filter(
    (p) => selectedMask[(p.y * width + p.x) * 4 + 3] > 127,
  ).length;
  if (selectedPixels < component.length * 0.4)
    return finish("foreground_not_selected_wire");
  evidence.movementPx = near;
  return finish("color_supported_tip_not_proof_of_insertion", {
    x: tip.x + origin.x,
    y: tip.y + origin.y,
  });
}
