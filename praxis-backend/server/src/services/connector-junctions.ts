import { decodeMaskToRaster } from '@meta-sam/parser';
import { createHash } from 'node:crypto';
import { rasterizeRuns } from './pixel-reference.js';
import { canonicalHash } from '../lib/canonical-json.js';
import type { BoundingBox } from '../schemas/vision.js';
import type { EncodedMask } from '../schemas/geometry.js';
import type {
  JunctionPlan,
  JunctionOutcome,
  JunctionReview,
  JunctionReference,
  JunctionEvaluation,
  JunctionRecord,
} from '../schemas/connector-junctions.js';
export const junctionPolicy = Object.freeze({
  version: 'connector-junction-policy-v1' as const,
  boundaryBandPixels: 8 as const,
  maxBoundarySamples: 4096 as const,
  maxCandidatesPerConductor: 3 as const,
  benchmarkTolerancePixels: 5 as const,
});
export function junctionId(value: unknown) {
  const h = canonicalHash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export interface JunctionMask {
  observationId: string;
  encodedMask: EncodedMask;
  bbox: BoundingBox;
  acceptedRaster?: { runs: [number, number, number][]; rasterHash: string };
}
export const junctionRasterHash = (r: Uint8Array) =>
  createHash('sha256').update(r).digest('hex');
/** Preserve native SAM provenance while consuming the exact evaluated subset. */
export function junctionRaster(mask: JunctionMask) {
  const raw = decodeMaskToRaster(mask.encodedMask);
  if (!mask.acceptedRaster) return raw;
  const accepted = rasterizeRuns(
    mask.acceptedRaster.runs,
    mask.bbox[2],
    mask.bbox[3],
  );
  if (
    junctionRasterHash(accepted) !== mask.acceptedRaster.rasterHash ||
    accepted.some((v, i) => v && !raw[i])
  )
    throw Error('Accepted junction raster is not bound to its native source.');
  return accepted;
}
export interface JunctionConductor {
  objectId: string;
  bbox: BoundingBox;
  masks: JunctionMask[];
  proposedType?: string;
}
const inside = (b: BoundingBox, x: number, y: number) =>
  x >= b[0] && y >= b[1] && x < b[0] + b[2] && y < b[1] + b[3];
export function junctionCrop(
  b: BoundingBox,
  image: { width: number; height: number },
): BoundingBox {
  const pad = 24,
    left = Math.max(0, b[0] - pad),
    top = Math.max(0, b[1] - pad);
  return [
    left,
    top,
    Math.min(image.width, b[0] + b[2] + pad) - left,
    Math.min(image.height, b[1] + b[3] + pad) - top,
  ];
}
/** Geometry creates search proposals, never terminal/attachment confirmation. */
export function generateJunctionCandidates(
  body: JunctionMask,
  conductors: JunctionConductor[],
  crop: BoundingBox,
) {
  if (
    body.encodedMask.width !== body.bbox[2] ||
    body.encodedMask.height !== body.bbox[3] ||
    body.bbox[2] * body.bbox[3] > 2000000
  )
    throw Error(
      'Junction native mask does not match its source coordinates or quota.',
    );
  const raster = junctionRaster(body),
    w = body.bbox[2],
    h = body.bbox[3],
    boundary: Array<[number, number]> = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (
        raster[i] &&
        (!x ||
          !y ||
          x === w - 1 ||
          y === h - 1 ||
          !raster[i - 1] ||
          !raster[i + 1] ||
          !raster[i - w] ||
          !raster[i + w])
      )
        boundary.push([body.bbox[0] + x, body.bbox[1] + y]);
    }
  const stride = Math.max(
      1,
      Math.ceil(boundary.length / junctionPolicy.maxBoundarySamples),
    ),
    band = junctionPolicy.boundaryBandPixels;
  let decoded = body.bbox[2] * body.bbox[3];
  const candidates: JunctionPlan['candidates'] = [];
  for (const conductor of conductors) {
    const masks = conductor.masks.flatMap((m) => {
      if (
        m.encodedMask.width !== m.bbox[2] ||
        m.encodedMask.height !== m.bbox[3] ||
        decoded + m.bbox[2] * m.bbox[3] > 4000000
      )
        return [];
      decoded += m.bbox[2] * m.bbox[3];
      try {
        return [{ ...m, raster: decodeMaskToRaster(m.encodedMask) }];
      } catch {
        return [];
      }
    });
    const points: Array<{
      point: [number, number];
      distance: number;
      mask: (typeof masks)[number] | undefined;
    }> = [];
    for (let index = 0; index < boundary.length; index += stride) {
      const p = boundary[index]!;
      let closest: (typeof points)[number] | undefined;
      for (const m of masks) {
        if (
          p[0] < m.bbox[0] - band ||
          p[1] < m.bbox[1] - band ||
          p[0] >= m.bbox[0] + m.bbox[2] + band ||
          p[1] >= m.bbox[1] + m.bbox[3] + band
        )
          continue;
        for (let dy = -band; dy <= band; dy++)
          for (let dx = -band; dx <= band; dx++) {
            const x = p[0] + dx,
              y = p[1] + dy,
              d = dx * dx + dy * dy;
            if (
              d > band * band ||
              !inside(m.bbox, x, y) ||
              !m.raster[(y - m.bbox[1]) * m.bbox[2] + x - m.bbox[0]]
            )
              continue;
            if (!closest || d < closest.distance)
              closest = { point: p, distance: d, mask: m };
          }
      }
      if (closest) points.push(closest);
      else if (
        !masks.length &&
        inside(
          [
            conductor.bbox[0] - band,
            conductor.bbox[1] - band,
            conductor.bbox[2] + band * 2,
            conductor.bbox[3] + band * 2,
          ],
          ...p,
        )
      )
        points.push({ point: p, distance: Infinity, mask: undefined });
    }
    points.sort(
      (a, b) =>
        a.distance - b.distance ||
        a.point[1] - b.point[1] ||
        a.point[0] - b.point[0],
    );
    const selected: typeof points = [];
    for (const p of points) {
      if (
        selected.some(
          (s) =>
            Math.hypot(s.point[0] - p.point[0], s.point[1] - p.point[1]) <
            band * 2,
        )
      )
        continue;
      const left = Math.max(crop[0], p.point[0] - band),
        top = Math.max(crop[1], p.point[1] - band),
        region: BoundingBox = [
          left,
          top,
          Math.min(crop[0] + crop[2], p.point[0] + band + 1) - left,
          Math.min(crop[1] + crop[3], p.point[1] + band + 1) - top,
        ];
      candidates.push({
        id: junctionId([
          body.observationId,
          conductor.objectId,
          p.point,
          p.mask?.observationId ?? 'bbox',
        ]),
        conductorObjectId: conductor.objectId,
        region,
        position: p.mask ? p.point : null,
        source: p.mask ? 'reviewed_native_proximity' : 'bbox_search_only',
        observationIds: p.mask
          ? [body.observationId, p.mask.observationId]
          : [body.observationId],
        nativeHashes: [
          canonicalHash(body.encodedMask),
          ...(body.acceptedRaster ? [body.acceptedRaster.rasterHash] : []),
          ...(p.mask ? [canonicalHash(p.mask.encodedMask)] : []),
        ],
        physicalAttachmentEstablished: false,
      });
      selected.push(p);
      if (selected.length === junctionPolicy.maxCandidatesPerConductor) break;
    }
  }
  return {
    candidates,
    boundaryPixelCount: boundary.length,
    boundarySampleStride: stride,
  };
}
export function unresolvedJunctions(
  plan: JunctionPlan,
  reason: string,
): JunctionOutcome[] {
  return plan.conductorObjectIds.map((id) => ({
    id: junctionId([plan.planId, id]),
    expectedConductorObjectId: id,
    conductorObjectId: null,
    kind: 'unknown',
    position: null,
    visibility: 'uncertain',
    associationStatus: 'unresolved',
    contactPosition: null,
    contactVisibility: 'uncertain',
    modelConfidence: null,
    evidenceSource: 'geometry',
    candidateIds: plan.candidates
      .filter((c) => c.conductorObjectId === id)
      .map((c) => c.id),
    reason,
    electricalConnectionStatus: 'unestablished',
  }));
}
export function effectiveJunctions(
  outcomes: JunctionOutcome[],
  reviews: JunctionReview[],
) {
  return outcomes.map((o) => {
    const r = reviews.filter((r) => r.outcomeId === o.id).at(-1);
    if (!r) return o;
    return {
      ...o,
      reviewId: r.reviewId,
      position: r.position,
      kind: r.kind,
      visibility:
        r.decision === 'unknown'
          ? ('uncertain' as const)
          : ('visible' as const),
      conductorObjectId:
        r.decision === 'unknown' ? null : o.expectedConductorObjectId,
      associationStatus:
        r.decision === 'unknown'
          ? ('unresolved' as const)
          : ('confirmed' as const),
      contactPosition: r.kind === 'exposed_contact' ? r.position : null,
      contactVisibility:
        r.kind === 'exposed_contact'
          ? ('visible' as const)
          : ('uncertain' as const),
      evidenceSource: 'human_review' as const,
      reason: r.reason,
    };
  });
}
export function evaluateJunctions(
  plan: JunctionPlan,
  outcomes: JunctionRecord['effectiveOutcomes'],
  reference: JunctionReference,
  provenanceValid: boolean,
  predictionLayer: 'original' | 'reviewed' = 'original',
): JunctionEvaluation {
  if (reference.content.imageHash !== plan.imageHash)
    throw Error('Junction benchmark image mismatch.');
  let visibleExpected = 0,
    localizedWithinTolerance = 0,
    unresolvedVisible = 0,
    hiddenExpected = 0,
    appropriateAbstentions = 0,
    wrongConfirmedAssociations = 0;
  const perConductor = reference.content.junctions.map((r) => {
    const o = outcomes.find(
      (o) => o.expectedConductorObjectId === r.conductorObjectId,
    )!;
    let status: JunctionEvaluation['perConductor'][number]['status'],
      errorPixels: number | null = null,
      withinTolerance: boolean | null = null;
    if (r.visibility === 'visible') {
      visibleExpected++;
      if (!o.position) {
        unresolvedVisible++;
        status = 'unresolved';
      } else {
        errorPixels = Math.hypot(
          o.position[0] - r.position![0],
          o.position[1] - r.position![1],
        );
        withinTolerance = errorPixels <= 5;
        status =
          o.kind !== r.kind
            ? 'wrong_kind'
            : withinTolerance && o.conductorObjectId === r.conductorObjectId
              ? 'localized'
              : 'wrong_position_or_association';
        if (status === 'localized') localizedWithinTolerance++;
        else if (o.associationStatus === 'confirmed')
          wrongConfirmedAssociations++;
      }
    } else {
      hiddenExpected++;
      const claim =
        r.kind === 'exposed_contact' ? o.contactPosition : o.position;
      status = claim ? 'unsupported_visible_claim' : 'appropriate_abstention';
      if (!claim) appropriateAbstentions++;
      else if (o.associationStatus === 'confirmed')
        wrongConfirmedAssociations++;
    }
    return {
      conductorObjectId: r.conductorObjectId,
      errorPixels,
      withinTolerance,
      status,
    };
  });
  const qualified =
      reference.independent || reference.content.source === 'synthetic_fixture',
    passed =
      visibleExpected > 0 &&
      localizedWithinTolerance === visibleExpected &&
      appropriateAbstentions === hiddenExpected &&
      !wrongConfirmedAssociations &&
      provenanceValid;
  const payload = {
    version: 'connector-junction-evaluation-v1' as const,
    predictionLayer,
    confirmedCount: outcomes.filter((o) => o.associationStatus === 'confirmed')
      .length,
    referenceHash: reference.referenceHash,
    evaluatedAt: Date.now(),
    predictionHash: canonicalHash(outcomes),
    status: !qualified
      ? ('diagnostic' as const)
      : !visibleExpected
        ? ('incomplete' as const)
        : passed
          ? reference.content.source === 'synthetic_fixture'
            ? ('synthetic_pass' as const)
            : ('passed' as const)
          : ('failed' as const),
    independentGroundTruth: reference.independent,
    tolerancePixels: 5 as const,
    visibleExpected,
    localizedWithinTolerance,
    unresolvedVisible,
    hiddenExpected,
    appropriateAbstentions,
    wrongConfirmedAssociations,
    provenanceCoverage: provenanceValid ? 1 : 0,
    perConductor,
    note: 'Five-pixel Euclidean tolerance in original-image pixels, matched by conductor and junction kind. Provisional/assistant and non-blinded references remain diagnostic. No visible references means localization remains unestablished. No polarity or continuity is inferred.',
  };
  return { evaluationId: canonicalHash(payload), ...payload };
}
