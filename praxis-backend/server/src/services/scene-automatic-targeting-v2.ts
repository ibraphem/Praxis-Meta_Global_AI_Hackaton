import { decodeMaskToRaster } from '@meta-sam/parser';
import type { SceneGraph } from '../schemas/scene.js';
import type { BoundingBox } from '../schemas/vision.js';
import type { TargetingMask } from './scene-automatic-targeting.js';
import { canonicalHash } from '../lib/canonical-json.js';
import { encodeRuns, rasterizeRuns } from './pixel-reference.js';
import { createHash } from 'node:crypto';
import {
  containsPixel,
  objectSpatialPrompt,
  type PixelPoint,
} from './object-spatial-prompt.js';

export const targetingV2Policy = Object.freeze({
  version: 'automatic-targeting-v2',
  exclusionMargin: 2,
  minimumInterior: 3,
  maxDecodedPixels: 2000000,
  maxDarkLuma: 72,
  maxDarkChroma: 48,
  minimumBodyCorePixels: 25,
  ambiguousComponentRatio: 0.6,
  // An uncertain neighbour box that covers more than this share of the target
  // box cannot separate body from neighbour (host surface or co-located
  // hypothesis); it is reported but not stamped. Reviewed native pixels always stamp.
  uncertainBoxCoverageLimit: 0.5,
  // Compact dark fragments within this gap of the dominant core are body parts
  // (e.g. shadowed hardware); sparse fragments are lead-like and fragments that
  // touch the inventory boundary may belong to the host object, so both stay out.
  componentMergeDistance: 6,
  compactComponentFill: 0.25,
  // Body box padding around the eroded core. Fixed: a proportional pad on a
  // 150 px housing reached 9 px and invited the terminal and host area below
  // the plastic; 2 px keeps specular hardware at the core's edge inside the box.
  bodyBoxPad: 2,
  // Positive cues are spread across the core by farthest-point sampling.
  positivePointCount: 3,
  positiveInterior: 4,
  // The bottom of a connector box is where terminals and leads attach. Drop
  // that band from the positive pool so FPS cannot put a cue on the terminal
  // face and leave the mid-housing uncovered.
  positiveBottomMarginRatio: 0.15,
  // Saturated-red lead pixels (hue within tolerance of 0°, HSV) supply one
  // negative cue from the original crop. Dark leads are not separable by colour.
  redHueTolerance: 12,
  redMinimumSaturation: 0.75,
  redMinimumValue: 0.45,
  // Neighbouring surfaces supply one negative each, from the original crop:
  // a bright low-saturation surface (host label, paper, metal case) and a
  // chromatic non-red surface (wood, coloured bench). Low-saturation mid tones
  // are not used: next to a dark body they are usually its own shading.
  neutralMinimumValue: 0.6,
  neutralMaximumSaturation: 0.2,
  hostMinimumSaturation: 0.25,
  hostMinimumValue: 0.35,
  minimumSurfacePixels: 200,
  surfaceInterior: 3,
  // A surface negative is the surface pixel nearest the body that still keeps
  // this clearance from every dark pixel and from the body box. Clearance from
  // dark alone can sit on brighter housing that the box already includes.
  negativeClearance: 8,
  // After SAM returns C, scoring keeps only prediction pixels that are dark or
  // within this Chebyshev distance of a dark crop pixel. Native bytes stay the
  // provider mask; the ring is a frozen original-image prior, not a reference.
  maskKeepDarkHaloPx: 1,
  maximumNegativePoints: 4,
});
/** Named scoring refinement. Acceptance may use this mask; native SAM bytes stay unchanged. */
export const keepDarkHaloRefinement = Object.freeze({
  version: 'keep-dark-halo-v1' as const,
  scoredMask: 'keep_dark_halo' as const,
});
function boxCoverage(neighbor: BoundingBox, target: BoundingBox) {
  const w =
      Math.min(neighbor[0] + neighbor[2], target[0] + target[2]) -
      Math.max(neighbor[0], target[0]),
    h =
      Math.min(neighbor[1] + neighbor[3], target[1] + target[3]) -
      Math.max(neighbor[1], target[1]);
  return w > 0 && h > 0 ? (w * h) / (target[2] * target[3]) : 0;
}
function boxGap(a: BoundingBox, b: BoundingBox) {
  const dx = Math.max(a[0] - (b[0] + b[2]), b[0] - (a[0] + a[2]), 0),
    dy = Math.max(a[1] - (b[1] + b[3]), b[1] - (a[1] + a[3]), 0);
  return Math.max(dx, dy);
}
function pixelBox(pixels: number[], w: number): BoundingBox {
  let left = Infinity,
    top = Infinity,
    right = -1,
    bottom = -1;
  for (const i of pixels) {
    const x = i % w,
      y = Math.floor(i / w);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return [left, top, right - left + 1, bottom - top + 1];
}
function isSaturatedRed(r: number, g: number, b: number) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  if (!max || max !== r || max === min) return false;
  if (
    (max - min) / max < targetingV2Policy.redMinimumSaturation ||
    max / 255 < targetingV2Policy.redMinimumValue
  )
    return false;
  let hue = (60 * (g - b)) / (max - min);
  if (hue < 0) hue += 360;
  return (
    hue <= targetingV2Policy.redHueTolerance ||
    hue >= 360 - targetingV2Policy.redHueTolerance
  );
}
function hsv(r: number, g: number, b: number) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  return { value: max / 255, saturation: max ? (max - min) / max : 0 };
}
/** Bright, nearly grey surface: host labels, paper, bare metal cases. */
function isBrightNeutral(r: number, g: number, b: number) {
  const { value, saturation } = hsv(r, g, b);
  return (
    value >= targetingV2Policy.neutralMinimumValue &&
    saturation <= targetingV2Policy.neutralMaximumSaturation
  );
}
/** Clearly coloured, non-red surface: wood or a coloured bench. */
function isChromaticHost(r: number, g: number, b: number) {
  const { value, saturation } = hsv(r, g, b);
  return (
    value >= targetingV2Policy.hostMinimumValue &&
    saturation >= targetingV2Policy.hostMinimumSaturation &&
    !isSaturatedRed(r, g, b)
  );
}
/** Four-connected components of interior pixels (distance >= minimumInterior). */
function coreComponents(
  distance: Uint32Array,
  w: number,
  h: number,
  minimumPixels: number,
  minimumInterior = targetingV2Policy.minimumInterior,
) {
  const visited = new Uint8Array(distance.length),
    components: Array<{ pixels: number[]; best: number }> = [];
  for (let start = 0; start < distance.length; start++) {
    if (visited[start] || distance[start]! < minimumInterior) continue;
    const pixels = [start];
    visited[start] = 1;
    let best = start;
    for (let j = 0; j < pixels.length; j++) {
      const i = pixels[j]!,
        x = i % w,
        y = Math.floor(i / w);
      if (distance[i]! > distance[best]!) best = i;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx! < 0 || ny! < 0 || nx! >= w || ny! >= h) continue;
        const next = ny! * w + nx!;
        if (!visited[next] && distance[next]! >= minimumInterior) {
          visited[next] = 1;
          pixels.push(next);
        }
      }
    }
    if (pixels.length >= minimumPixels) components.push({ pixels, best });
  }
  return components.sort(
    (a, b) => b.pixels.length - a.pixels.length || a.best - b.best,
  );
}
export interface OriginalCropPixels {
  width: number;
  height: number;
  rgb: Uint8Array;
}
interface Native {
  observationId: string;
  bbox: BoundingBox;
  raster: Uint8Array;
}
function depth(raster: Uint8Array, w: number, h: number) {
  const d = new Uint32Array(raster.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (raster[i]) d[i] = 1 + Math.min(x ? d[i - 1]! : 0, y ? d[i - w]! : 0);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (raster[i])
        d[i] = Math.min(
          d[i]!,
          1 + Math.min(x + 1 < w ? d[i + 1]! : 0, y + 1 < h ? d[i + w]! : 0),
        );
    }
  return d;
}
/** Chessboard (8-neighbour) distance to the nearest zero pixel or crop edge, so a
 * clearance of n means no dark pixel within n px along either axis. */
function chessboardDepth(raster: Uint8Array, w: number, h: number) {
  const d = new Uint32Array(raster.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!raster[i]) continue;
      d[i] =
        1 +
        Math.min(
          x ? d[i - 1]! : 0,
          y ? d[i - w]! : 0,
          x && y ? d[i - w - 1]! : 0,
          y && x + 1 < w ? d[i - w + 1]! : 0,
        );
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!raster[i]) continue;
      d[i] = Math.min(
        d[i]!,
        1 +
          Math.min(
            x + 1 < w ? d[i + 1]! : 0,
            y + 1 < h ? d[i + w]! : 0,
            x + 1 < w && y + 1 < h ? d[i + w + 1]! : 0,
            x && y + 1 < h ? d[i + w - 1]! : 0,
          ),
      );
    }
  return d;
}
/** Chebyshev distance from a point to a box. Zero when the point is inside. */
export function boxChebyshev(x: number, y: number, box: BoundingBox) {
  const dx = x < box[0] ? box[0] - x : x >= box[0] + box[2] ? x - (box[0] + box[2] - 1) : 0,
    dy = y < box[1] ? box[1] - y : y >= box[1] + box[3] ? y - (box[1] + box[3] - 1) : 0;
  return Math.max(dx, dy);
}
function dilateChebyshev(src: Uint8Array, w: number, h: number, radius: number) {
  if (radius <= 0) return src;
  const out = new Uint8Array(src);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue;
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = 1;
        }
    }
  return out;
}
export function applyKeepRing(
  prediction: Uint8Array,
  image: { width: number; height: number },
  ring: { crop: BoundingBox; runs: number[][] },
) {
  const [cx, cy, cw, ch] = ring.crop,
    keep = rasterizeRuns(ring.runs, cw, ch),
    out = new Uint8Array(prediction);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const px = cx + x,
        py = cy + y;
      if (px >= image.width || py >= image.height) continue;
      const i = py * image.width + px;
      if (out[i] && !keep[y * cw + x]) out[i] = 0;
    }
  return out;
}
/** Chebyshev distance to the given seeds. Crop edges are not treated as seeds. */
function distanceFromSeeds(seeds: number[], w: number, h: number) {
  const d = new Uint32Array(w * h).fill(0xffffffff),
    q = seeds.slice();
  for (const i of q) d[i] = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi]!,
      x = i % w,
      y = Math.floor(i / w),
      next = d[i]! + 1;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
      [x - 1, y - 1],
      [x + 1, y - 1],
      [x - 1, y + 1],
      [x + 1, y + 1],
    ]) {
      if (nx! < 0 || ny! < 0 || nx! >= w || ny! >= h) continue;
      const j = ny! * w + nx!;
      if (next < d[j]!) {
        d[j] = next;
        q.push(j);
      }
    }
  }
  return d;
}
/** Independent inputs only: original RGB crop and original broad-pass native masks.
 * The API has no reference, manual profile or experiment-prediction parameter.
 * Dark-region proposals are targeting hypotheses, never confirmed object boundaries. */
export function proposeAutomaticTargetingV2(
  graph: SceneGraph,
  objectId: string,
  crop: BoundingBox,
  native: TargetingMask[],
  original: OriginalCropPixels,
) {
  const object = graph.objects.find((o) => o.id === objectId);
  if (!object || object.category !== 'connector')
    throw Error('Automatic v2 requires a connector hypothesis.');
  if (
    original.width !== crop[2] ||
    original.height !== crop[3] ||
    original.rgb.length !== crop[2] * crop[3] * 3 ||
    crop[2] * crop[3] > 2000000
  )
    throw Error(
      'Original crop RGB dimensions exceed or disagree with the bounded crop.',
    );
  // Also validates the target/crop binding even if every improved arm abstains.
  const variants = [
    {
      name: 'A-inventory-box-v2',
      scope: 'connector_only',
      crop,
      prompt: objectSpatialPrompt(crop, object.bbox),
    },
  ];
  const nativeMap = new Map<string, Native>(),
    decodeReasons = new Map<string, string>();
  let decodedPixels = 0;
  const broad = graph.observations.filter((o) => o.source === 'sam');
  for (const o of broad) {
    if (o.requestId || !o.samSnapshotId || !o.samSnapshotHash) {
      decodeReasons.set(o.id, 'not_original_broad_sam');
      continue;
    }
    const matches = native.filter((n) => n.observationId === o.id),
      m = matches[0]?.encodedMask;
    if (matches.length !== 1 || !m) {
      decodeReasons.set(o.id, 'native_mask_unavailable_or_ambiguous');
      continue;
    }
    if (m.width !== o.bbox[2] || m.height !== o.bbox[3]) {
      decodeReasons.set(o.id, 'native_dimensions_mismatch');
      continue;
    }
    if (
      decodedPixels + m.width * m.height >
      targetingV2Policy.maxDecodedPixels
    ) {
      decodeReasons.set(o.id, 'decode_budget_exhausted');
      continue;
    }
    decodedPixels += m.width * m.height;
    try {
      const raster = decodeMaskToRaster(m);
      nativeMap.set(o.id, { observationId: o.id, bbox: o.bbox, raster });
    } catch {
      decodeReasons.set(o.id, 'native_decode_failed');
    }
  }
  const review = (id: string, oid: string) =>
    graph.maskIdentityReviews
      ?.filter((r) => r.objectId === id && r.observationId === oid)
      .at(-1);
  const targetIds = graph.associations
    .filter(
      (a) => a.objectId === objectId && a.basis === 'category_and_overlap',
    )
    .map((a) => a.observationId);
  for (const o of broad)
    if (
      review(objectId, o.id)?.source === 'human_review' &&
      review(objectId, o.id)?.decision === 'accepted'
    )
      targetIds.push(o.id);
  const neighbors = graph.objects.filter(
    (o) =>
      o.id !== objectId &&
      o.category !== 'board' &&
      o.bbox[0] < crop[0] + crop[2] &&
      o.bbox[1] < crop[1] + crop[3] &&
      o.bbox[0] + o.bbox[2] > crop[0] &&
      o.bbox[1] + o.bbox[3] > crop[1],
  );
  const exclusions = neighbors.map((o) => {
    const linked = graph.associations
      .filter((a) => a.objectId === o.id)
      .map((a) => a.observationId);
    const reliable = linked.flatMap((id) => {
      const r = review(o.id, id),
        m = nativeMap.get(id);
      const contested = graph.associations.some(
        (a) =>
          a.observationId === id &&
          a.objectId !== o.id &&
          a.basis !== 'inventory',
      );
      return m &&
        r?.source === 'human_review' &&
        r.decision === 'accepted' &&
        !contested
        ? [m]
        : [];
    });
    const coverage = boxCoverage(o.bbox, object.bbox);
    const mode = reliable.length
      ? ('native_mask_with_margin' as const)
      : coverage > targetingV2Policy.uncertainBoxCoverageLimit
        ? ('colocated_box_not_stamped' as const)
        : ('uncertain_bbox' as const);
    return {
      object: o,
      masks: reliable,
      mode,
      coverage: Math.round(coverage * 1000) / 1000,
      reason:
        mode === 'native_mask_with_margin'
          ? 'Human-reviewed broad-pass pixels; mask absence remains a proposal, not proof of free space.'
          : mode === 'colocated_box_not_stamped'
            ? `Box covers ${Math.round(coverage * 100)}% of the target box (host surface or co-located hypothesis); it cannot separate body from neighbour and is not stamped. No pixel evidence is claimed.`
            : 'Native pixels or unambiguous human identity review unavailable; box retained as uncertain exclusion.',
    };
  });
  // Stamp native pixels first, then uncertain boxes. Work scales with decoded mask
  // area rather than crop pixels times every neighboring object and mask margin.
  const blocked = new Uint8Array(crop[2] * crop[3]);
  const left = Math.max(crop[0], object.bbox[0]),
    top = Math.max(crop[1], object.bbox[1]),
    right = Math.min(crop[0] + crop[2], object.bbox[0] + object.bbox[2]),
    bottom = Math.min(crop[1] + crop[3], object.bbox[1] + object.bbox[3]);
  for (const e of exclusions)
    for (const m of e.masks) {
      for (let y = 0; y < m.bbox[3]; y++)
        for (let x = 0; x < m.bbox[2]; x++) {
          if (!m.raster[y * m.bbox[2] + x]) continue;
          const px = m.bbox[0] + x,
            py = m.bbox[1] + y,
            margin = targetingV2Policy.exclusionMargin,
            l = Math.max(left, px - margin),
            r = Math.min(right, px + margin + 1);
          if (l >= r) continue;
          for (
            let row = Math.max(top, py - margin);
            row < Math.min(bottom, py + margin + 1);
            row++
          )
            blocked.fill(
              1,
              (row - crop[1]) * crop[2] + l - crop[0],
              (row - crop[1]) * crop[2] + r - crop[0],
            );
        }
    }
  for (const e of exclusions.filter((e) => e.mode === 'uncertain_bbox')) {
    const l = Math.max(left, e.object.bbox[0]),
      r = Math.min(right, e.object.bbox[0] + e.object.bbox[2]);
    if (l >= r) continue;
    for (
      let row = Math.max(top, e.object.bbox[1]);
      row < Math.min(bottom, e.object.bbox[1] + e.object.bbox[3]);
      row++
    )
      blocked.fill(
        2,
        (row - crop[1]) * crop[2] + l - crop[0],
        (row - crop[1]) * crop[2] + r - crop[0],
      );
  }
  const diagnostics = broad.map((o) => ({
    observationId: o.id,
    reasons: [] as string[],
    pixelRejections: {
      insufficientInterior: 0,
      outsideTarget: 0,
      conductorOrNeighborPixels: 0,
      uncertainNeighborBox: 0,
    },
    eligibleInteriorPixels: 0,
  }));
  const points: Array<{
    observationId: string;
    point: PixelPoint;
    interiorDistance: number;
  }> = [];
  for (const item of diagnostics) {
    const o = graph.observations.find((o) => o.id === item.observationId)!;
    if (!targetIds.includes(o.id))
      item.reasons.push('no_target_baseline_association');
    if (decodeReasons.has(o.id)) item.reasons.push(decodeReasons.get(o.id)!);
    const r = review(objectId, o.id);
    if (r && r.decision !== 'accepted')
      item.reasons.push('mask_identity_rejected_or_uncertain');
    const competing = graph.associations.some(
      (a) =>
        a.observationId === o.id &&
        a.objectId !== objectId &&
        graph.objects.find((v) => v.id === a.objectId)?.category ===
          'conductor',
    );
    if (competing) item.reasons.push('competing_conductor_identity');
    if (item.reasons.length) continue;
    const m = nativeMap.get(o.id)!,
      d = depth(m.raster, m.bbox[2], m.bbox[3]);
    let best: (typeof points)[number] | undefined;
    for (let y = 0; y < m.bbox[3]; y++)
      for (let x = 0; x < m.bbox[2]; x++) {
        if (!m.raster[y * m.bbox[2] + x]) continue;
        const px = m.bbox[0] + x,
          py = m.bbox[1] + y,
          dist = d[y * m.bbox[2] + x]!;
        if (dist < targetingV2Policy.minimumInterior) {
          item.pixelRejections.insufficientInterior++;
          continue;
        }
        if (
          !containsPixel(object.bbox, px, py) ||
          !containsPixel(crop, px, py)
        ) {
          item.pixelRejections.outsideTarget++;
          continue;
        }
        const exclusion = blocked[(py - crop[1]) * crop[2] + px - crop[0]];
        if (exclusion) {
          if (exclusion === 2) item.pixelRejections.uncertainNeighborBox++;
          else item.pixelRejections.conductorOrNeighborPixels++;
          continue;
        }
        item.eligibleInteriorPixels++;
        if (!best || dist > best.interiorDistance)
          best = {
            observationId: o.id,
            point: [px, py],
            interiorDistance: dist,
          };
      }
    if (best) points.push(best);
    else item.reasons.push('no_safe_interior_pixels');
  }
  points.sort(
    (a, b) =>
      b.interiorDistance - a.interiorDistance ||
      a.observationId.localeCompare(b.observationId),
  );
  const cue = points[0];
  if (cue)
    variants.push({
      name: 'B-mask-interior-v2',
      scope: 'connector_only',
      crop,
      prompt: objectSpatialPrompt(crop, object.bbox, [cue.point]),
    });
  // Original-image heuristic: separated dark, low-chroma cores, not bbox-minus-wire "truth".
  const foreground = new Uint8Array(crop[2] * crop[3]),
    notDark = new Uint8Array(crop[2] * crop[3]),
    saturatedRed = new Uint8Array(crop[2] * crop[3]),
    brightNeutral = new Uint8Array(crop[2] * crop[3]),
    chromaticHost = new Uint8Array(crop[2] * crop[3]);
  const bodyPixels = {
    darkPixels: 0,
    excludedByNativeMasks: 0,
    excludedByUncertainBoxes: 0,
    remainingDarkPixels: 0,
    interiorCorePixels: 0,
  };
  let saturatedRedPixels = 0,
    brightNeutralPixels = 0,
    chromaticHostPixels = 0;
  for (let y = 0; y < crop[3]; y++)
    for (let x = 0; x < crop[2]; x++) {
      const i = y * crop[2] + x,
        r = original.rgb[i * 3]!,
        g = original.rgb[i * 3 + 1]!,
        b = original.rgb[i * 3 + 2]!;
      const dark =
        (r * 299 + g * 587 + b * 114) / 1000 <= targetingV2Policy.maxDarkLuma &&
        Math.max(r, g, b) - Math.min(r, g, b) <= targetingV2Policy.maxDarkChroma;
      // Clearance is measured from every dark pixel in the crop, including
      // leads and shadows outside the inventory box.
      if (!dark) notDark[i] = 1;
      if (!containsPixel(object.bbox, x + crop[0], y + crop[1])) continue;
      if (dark) {
        bodyPixels.darkPixels++;
        if (blocked[i] === 2) bodyPixels.excludedByUncertainBoxes++;
        else if (blocked[i] === 1) bodyPixels.excludedByNativeMasks++;
        else {
          foreground[i] = 1;
          bodyPixels.remainingDarkPixels++;
        }
      } else if (isSaturatedRed(r, g, b)) {
        saturatedRed[i] = 1;
        saturatedRedPixels++;
      } else if (isBrightNeutral(r, g, b)) {
        brightNeutral[i] = 1;
        brightNeutralPixels++;
      } else if (isChromaticHost(r, g, b)) {
        chromaticHost[i] = 1;
        chromaticHostPixels++;
      }
    }
  const distance = depth(foreground, crop[2], crop[3]);
  bodyPixels.interiorCorePixels = distance.reduce(
    (n, d) => n + (d >= targetingV2Policy.minimumInterior ? 1 : 0),
    0,
  );
  const touchesInventoryBoundary = (pixels: number[]) =>
    pixels.some((i) => {
      const x = (i % crop[2]) + crop[0],
        y = Math.floor(i / crop[2]) + crop[1];
      return (
        x - object.bbox[0] < 3 ||
        y - object.bbox[1] < 3 ||
        object.bbox[0] + object.bbox[2] - 1 - x < 3 ||
        object.bbox[1] + object.bbox[3] - 1 - y < 3
      );
    });
  const components = coreComponents(
    distance,
    crop[2],
    crop[3],
    targetingV2Policy.minimumBodyCorePixels,
  );
  const body = components[0];
  // Compact dark fragments adjacent to the dominant core (snap hardware, shadowed
  // faces) belong to the body; sparse fragments are lead-like and stay separate.
  const merged: number[] = [],
    separate: Array<{ pixels: number[]; best: number }> = [];
  let boundaryFragments = 0;
  if (body) {
    const mainBox = pixelBox(body.pixels, crop[2]);
    for (const c of components.slice(1)) {
      const box = pixelBox(c.pixels, crop[2]);
      if (touchesInventoryBoundary(c.pixels)) {
        boundaryFragments++;
        separate.push(c);
      } else if (
        boxGap(mainBox, box) <= targetingV2Policy.componentMergeDistance &&
        c.pixels.length / (box[2] * box[3]) >=
          targetingV2Policy.compactComponentFill
      )
        merged.push(...c.pixels);
      else separate.push(c);
    }
  }
  const bodyCore = body ? [...body.pixels, ...merged] : [];
  let reason = !body
    ? bodyPixels.darkPixels > 0 && !bodyPixels.remainingDarkPixels
      ? bodyPixels.excludedByUncertainBoxes
        ? 'body_pixels_blocked_by_uncertain_boxes'
        : 'body_pixels_blocked_by_neighbor_masks'
      : 'no_supported_dark_body_core'
    : touchesInventoryBoundary(body.pixels)
      ? 'body_core_touches_inventory_boundary'
      : separate[0] &&
          separate[0].pixels.length >=
            bodyCore.length * targetingV2Policy.ambiguousComponentRatio
        ? 'ambiguous_dark_body_components'
        : 'proposed';
  let bodyBox: BoundingBox | null = null;
  const positives: PixelPoint[] = [];
  if (body && reason === 'proposed') {
    const extent = pixelBox(bodyCore, crop[2]),
      pad = targetingV2Policy.bodyBoxPad;
    const minX = Math.max(object.bbox[0], extent[0] + crop[0] - pad),
      minY = Math.max(object.bbox[1], extent[1] + crop[1] - pad),
      maxX = Math.min(
        object.bbox[0] + object.bbox[2] - 1,
        extent[0] + extent[2] - 1 + crop[0] + pad,
      ),
      maxY = Math.min(
        object.bbox[1] + object.bbox[3] - 1,
        extent[1] + extent[3] - 1 + crop[1] + pad,
      );
    bodyBox = [minX, minY, maxX - minX + 1, maxY - minY + 1];
    if (
      Math.min(bodyBox[2], bodyBox[3]) < 8 ||
      Math.max(bodyBox[2] / bodyBox[3], bodyBox[3] / bodyBox[2]) > 4
    ) {
      reason = 'body_extent_too_thin';
      bodyBox = null;
    } else {
      // Farthest-point sampling spreads positives across every face of the core
      // so a shading seam cannot be read as the object boundary.
      const toPoint = (i: number): PixelPoint => [
        (i % crop[2]) + crop[0],
        Math.floor(i / crop[2]) + crop[1],
      ];
      const deep = bodyCore.filter(
        (i) => distance[i]! >= targetingV2Policy.positiveInterior,
      );
      const bottomMargin = Math.max(
        targetingV2Policy.positiveInterior,
        Math.round(
          bodyBox[3] * targetingV2Policy.positiveBottomMarginRatio,
        ),
      );
      const bottomLimit = bodyBox[1] + bodyBox[3] - bottomMargin;
      const raised = deep.filter((i) => {
        const y = Math.floor(i / crop[2]) + crop[1];
        return y < bottomLimit;
      });
      const pool =
        raised.length >= targetingV2Policy.positivePointCount ? raised : deep;
      const seed = pool.includes(body.best) ? body.best : pool[0]!;
      const chosen = [seed];
      const pickFarthest = (candidates: number[]) => {
        let next = -1,
          farthest = 0;
        for (const i of candidates) {
          const [x, y] = toPoint(i);
          let nearest = Infinity;
          for (const c of chosen) {
            const [cx, cy] = toPoint(c);
            nearest = Math.min(nearest, Math.hypot(x - cx, y - cy));
          }
          if (nearest > farthest || (nearest === farthest && i < next)) {
            farthest = nearest;
            next = i;
          }
        }
        return farthest >= targetingV2Policy.positiveInterior ? next : -1;
      };
      while (chosen.length < targetingV2Policy.positivePointCount - 1) {
        const next = pickFarthest(pool);
        if (next < 0) break;
        chosen.push(next);
      }
      // Last cue covers the right-middle face so a surface negative beside the
      // housing cannot erase that side. Ordinary FPS if that band is empty.
      if (chosen.length < targetingV2Policy.positivePointCount) {
        const midX = bodyBox[0] + bodyBox[2] / 2,
          midTop = bodyBox[1] + Math.round(bodyBox[3] * 0.25),
          midBot = bodyBox[1] + Math.round(bodyBox[3] * 0.75);
        const rightMiddle = pool.filter((i) => {
          const [x, y] = toPoint(i);
          return x >= midX && y >= midTop && y < midBot;
        });
        const next = pickFarthest(rightMiddle.length ? rightMiddle : pool);
        if (next >= 0) chosen.push(next);
      }
      positives.push(...chosen.map(toPoint));
    }
  }
  const negatives: Array<
    | {
        source: 'reviewed_conductor_mask';
        objectId: string;
        observationId: string;
        point: PixelPoint;
        reviewId: string;
      }
    | {
        source: 'saturated_red_pixels';
        point: PixelPoint;
        componentPixels: number;
        interiorDistance: number;
      }
    | {
        source: 'bright_neutral_surface' | 'chromatic_host_surface';
        point: PixelPoint;
        componentPixels: number;
        clearance: number;
      }
  > = [];
  if (bodyBox)
    for (const e of exclusions.filter(
      (e) => e.object.category === 'conductor',
    )) {
      let best: { point: PixelPoint; d: number; mask: Native } | undefined;
      for (const m of e.masks) {
        const d = depth(m.raster, m.bbox[2], m.bbox[3]);
        for (let y = 0; y < m.bbox[3]; y++)
          for (let x = 0; x < m.bbox[2]; x++) {
            const px = x + m.bbox[0],
              py = y + m.bbox[1],
              value = d[y * m.bbox[2] + x]!;
            if (
              value < targetingV2Policy.minimumInterior ||
              !containsPixel(crop, px, py) ||
              containsPixel(bodyBox, px, py) ||
              exclusions.some(
                (other) =>
                  other.object.id !== e.object.id &&
                  containsPixel(other.object.bbox, px, py),
              )
            )
              continue;
            if (!best || value > best.d)
              best = { point: [px, py], d: value, mask: m };
          }
      }
      if (best)
        negatives.push({
          source: 'reviewed_conductor_mask',
          objectId: e.object.id,
          observationId: best.mask.observationId,
          point: best.point,
          reviewId: review(e.object.id, best.mask.observationId)!.id,
        });
      if (negatives.length === targetingV2Policy.maximumNegativePoints) break;
    }
  // Chromatic lead cue: the deepest interior pixel of the largest saturated-red
  // component inside the target box. Original pixels only; no reference or mask.
  const redDistance = depth(saturatedRed, crop[2], crop[3]),
    redComponents = coreComponents(
      redDistance,
      crop[2],
      crop[3],
      targetingV2Policy.minimumBodyCorePixels,
    ),
    redCore = redComponents[0];
  const chromaticCue = {
    source: 'saturated_red_v1' as const,
    status: 'abstained' as 'proposed' | 'abstained',
    reason: !bodyBox
      ? 'no_body_box'
      : !saturatedRedPixels
        ? 'no_saturated_red_pixels'
        : !redCore
          ? 'no_saturated_red_core'
          : negatives.length >= targetingV2Policy.maximumNegativePoints
            ? 'negative_budget_spent_on_reviewed_masks'
            : 'proposed',
    saturatedRedPixels,
    componentCount: redComponents.length,
  };
  if (chromaticCue.reason === 'proposed' && redCore) {
    chromaticCue.status = 'proposed';
    negatives.push({
      source: 'saturated_red_pixels',
      point: [
        (redCore.best % crop[2]) + crop[0],
        Math.floor(redCore.best / crop[2]) + crop[1],
      ],
      componentPixels: redCore.pixels.length,
      interiorDistance: redDistance[redCore.best]!,
    });
  }
  // Surface cues: for each neighbouring surface class, the pixel of its largest
  // component that lies nearest the body core while keeping the clearance from
  // every dark pixel and from the body box. Placed beside the body, where SAM
  // has to decide where the plastic ends. Original pixels only; no reference
  // or prediction is consulted.
  const clearance = chessboardDepth(notDark, crop[2], crop[3]);
  const coreDistance = distanceFromSeeds(bodyCore, crop[2], crop[3]);
  const surfaceCues = (
    [
      ['bright_neutral_surface', brightNeutral, brightNeutralPixels],
      ['chromatic_host_surface', chromaticHost, chromaticHostPixels],
    ] as const
  ).map(([source, raster, pixels]) => {
    const surfaceDepth = depth(raster, crop[2], crop[3]),
      components = coreComponents(
        surfaceDepth,
        crop[2],
        crop[3],
        targetingV2Policy.minimumSurfacePixels,
        targetingV2Policy.surfaceInterior,
      ),
      component = components[0];
    let chosen = -1;
    if (bodyBox && component)
      for (const i of component.pixels) {
        const x = (i % crop[2]) + crop[0],
          y = Math.floor(i / crop[2]) + crop[1];
        if (
          clearance[i]! < targetingV2Policy.negativeClearance ||
          boxChebyshev(x, y, bodyBox) < targetingV2Policy.negativeClearance
        )
          continue;
        if (
          chosen < 0 ||
          coreDistance[i]! < coreDistance[chosen]! ||
          (coreDistance[i] === coreDistance[chosen] && i < chosen)
        )
          chosen = i;
      }
    const reason = !bodyBox
      ? 'no_body_box'
      : !pixels
        ? 'no_surface_pixels'
        : !component
          ? 'no_surface_core'
          : chosen < 0
            ? 'no_pixel_clear_of_body_and_dark'
            : negatives.length >= targetingV2Policy.maximumNegativePoints
              ? 'negative_budget_spent'
              : 'proposed';
    if (reason === 'proposed' && component)
      negatives.push({
        source,
        point: [
          (chosen % crop[2]) + crop[0],
          Math.floor(chosen / crop[2]) + crop[1],
        ],
        componentPixels: component.pixels.length,
        clearance: clearance[chosen]!,
      });
    return {
      source,
      status: reason === 'proposed' ? ('proposed' as const) : ('abstained' as const),
      reason,
      surfacePixels: pixels,
      componentCount: components.length,
    };
  });
  if (bodyBox)
    variants.push({
      name: 'C-body-aware-v2',
      scope: 'connector_only',
      crop,
      prompt: objectSpatialPrompt(
        crop,
        bodyBox,
        positives,
        negatives.map((n) => n.point),
      ),
    });
  return {
    version: 'automatic-targeting-v2' as const,
    objectId,
    source: 'persisted_inventory_original_crop_and_baseline_sam',
    inventoryBox: object.bbox,
    pointStatus: cue ? ('proposed' as const) : ('abstained' as const),
    pointCues: cue ? [cue] : [],
    variants,
    policy: targetingV2Policy,
    policyHash: canonicalHash(targetingV2Policy),
    originalPixelsHash: createHash('sha256').update(original.rgb).digest('hex'),
    diagnostics: {
      version: 'automatic-targeting-diagnostics-v2',
      decodedPixels,
      baseline: diagnostics,
      eligibleBaselineMasks: points.length,
      nativeSources: [...nativeMap.keys()].map((id) => {
        const o = broad.find((o) => o.id === id)!;
        return {
          observationId: id,
          samSnapshotId: o.samSnapshotId,
          samSnapshotHash: o.samSnapshotHash,
          nativeHash: canonicalHash(
            native.find((n) => n.observationId === id)!.encodedMask,
          ),
        };
      }),
      exclusions: exclusions.map((e) => ({
        objectId: e.object.id,
        mode: e.mode,
        coverage: e.coverage,
        reason: e.reason,
        observationIds: e.masks.map((m) => m.observationId),
      })),
      bodyProposal: {
        source: 'local_dark_core_v2',
        status: bodyBox ? 'proposed' : 'abstained',
        reason,
        box: bodyBox,
        positivePoints: positives,
        componentCount: components.length,
        mergedComponentPixels: merged.length,
        boundaryFragmentsSkipped: boundaryFragments,
        pixelDiagnostics: bodyPixels,
        physicalBoundaryStatus: 'unconfirmed',
      },
      chromaticCue,
      surfaceCues,
      negativeCues: negatives,
      ...(bodyBox && targetingV2Policy.maskKeepDarkHaloPx > 0
        ? {
            keepRing: {
              haloPx: targetingV2Policy.maskKeepDarkHaloPx,
              crop,
              runs: encodeRuns(
                dilateChebyshev(
                  Uint8Array.from(notDark, (v) => (v ? 0 : 1)),
                  crop[2],
                  crop[3],
                  targetingV2Policy.maskKeepDarkHaloPx,
                ),
                crop[2],
                crop[3],
              ),
            },
          }
        : {}),
    },
    note: 'Automatic proposals only. No reference, manual profile, Strategy A pixels, object identity merge, terminal or connectivity inference is consumed or established. Missing evidence and ambiguous bodies retain abstention.',
  };
}
