import { decodeMaskToRaster } from '@meta-sam/parser';
import type { SceneGraph } from '../schemas/scene.js';
import type { BoundingBox } from '../schemas/vision.js';
import type { TargetingMask } from './scene-automatic-targeting.js';
import { canonicalHash } from '../lib/canonical-json.js';
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
  // Body box padding around the eroded core: at least 2 px, scaled with size so
  // specular hardware at the core's edge (not dark) still lies inside the box.
  bodyBoxPadRatio: 0.06,
  // Positive cues are spread across the core by farthest-point sampling.
  positivePointCount: 3,
  positiveInterior: 4,
  // Saturated-red lead pixels (hue within tolerance of 0°, HSV) supply one
  // negative cue from the original crop. Dark leads are not separable by colour.
  redHueTolerance: 12,
  redMinimumSaturation: 0.75,
  redMinimumValue: 0.45,
  maximumNegativePoints: 2,
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
/** Four-connected components of interior pixels (distance >= minimumInterior). */
function coreComponents(
  distance: Uint32Array,
  w: number,
  h: number,
  minimumPixels: number,
) {
  const visited = new Uint8Array(distance.length),
    components: Array<{ pixels: number[]; best: number }> = [];
  for (let start = 0; start < distance.length; start++) {
    if (visited[start] || distance[start]! < targetingV2Policy.minimumInterior)
      continue;
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
        if (
          !visited[next] &&
          distance[next]! >= targetingV2Policy.minimumInterior
        ) {
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
    saturatedRed = new Uint8Array(crop[2] * crop[3]);
  const bodyPixels = {
    darkPixels: 0,
    excludedByNativeMasks: 0,
    excludedByUncertainBoxes: 0,
    remainingDarkPixels: 0,
    interiorCorePixels: 0,
  };
  let saturatedRedPixels = 0;
  for (let y = 0; y < crop[3]; y++)
    for (let x = 0; x < crop[2]; x++) {
      const i = y * crop[2] + x,
        r = original.rgb[i * 3]!,
        g = original.rgb[i * 3 + 1]!,
        b = original.rgb[i * 3 + 2]!;
      if (!containsPixel(object.bbox, x + crop[0], y + crop[1])) continue;
      if (
        (r * 299 + g * 587 + b * 114) / 1000 <= targetingV2Policy.maxDarkLuma &&
        Math.max(r, g, b) - Math.min(r, g, b) <= targetingV2Policy.maxDarkChroma
      ) {
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
      pad = Math.max(
        2,
        Math.round(
          targetingV2Policy.bodyBoxPadRatio * Math.max(extent[2], extent[3]),
        ),
      );
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
      const chosen = [body.best];
      const deep = bodyCore.filter(
        (i) => distance[i]! >= targetingV2Policy.positiveInterior,
      );
      while (chosen.length < targetingV2Policy.positivePointCount) {
        let next = -1,
          farthest = 0;
        for (const i of deep) {
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
        if (next < 0 || farthest < targetingV2Policy.positiveInterior) break;
        chosen.push(next);
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
      negativeCues: negatives,
    },
    note: 'Automatic proposals only. No reference, manual profile, Strategy A pixels, object identity merge, terminal or connectivity inference is consumed or established. Missing evidence and ambiguous bodies retain abstention.',
  };
}
