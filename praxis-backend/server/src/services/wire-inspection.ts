import { decodeMaskToRaster, decodeMaskToSVGPath } from '@meta-sam/parser';
import { maskComponents, wireTopology, simplifyPath } from './wire-geometry.js';
import { maskSchema, type MaskGeometry } from '../schemas/geometry.js';
import type { Candidate } from '../schemas/vision.js';
export interface MaskInspection {
  candidateId: string;
  acceptedGeometry: boolean;
  reasons: string[];
  area: number;
  components: number;
  largestFraction: number;
  occupancy: number;
  aspect: number;
  perimeter: number;
  ends: number;
  branches: number;
  thinningConverged: boolean;
  topologyScale: number;
  preview?: MaskGeometry;
}
/** Diagnosis never relaxes the existing acceptance policy. Previews are unverified visual evidence. */
export function inspectWire(candidate: Candidate): MaskInspection {
  const result: MaskInspection = {
    candidateId: candidate.id,
    acceptedGeometry: false,
    reasons: [],
    area: 0,
    components: 0,
    largestFraction: 0,
    occupancy: 0,
    aspect: 0,
    perimeter: 0,
    ends: 0,
    branches: 0,
    thinningConverged: false,
    topologyScale: 0,
  };
  const raw = candidate.encodedMask;
  if (!raw) {
    result.reasons.push('no_mask');
    return result;
  }
  if (
    raw.width * raw.height > 4000000 ||
    raw.width > 8192 ||
    raw.height > 8192
  ) {
    result.reasons.push('decode_budget');
    return result;
  }
  try {
    const raster = decodeMaskToRaster(raw),
      shape = maskComponents(raster, raw.width, raw.height),
      topology = wireTopology(raster, raw.width, raw.height);
    Object.assign(result, {
      area: shape.area,
      components: shape.components,
      largestFraction: shape.area ? shape.largest / shape.area : 0,
      occupancy: shape.area / (raw.width * raw.height),
      aspect: Math.max(
        candidate.bbox[2] / candidate.bbox[3],
        candidate.bbox[3] / candidate.bbox[2],
      ),
      perimeter: shape.perimeter,
      ends: topology.ends,
      branches: topology.branches,
      thinningConverged: topology.converged,
      topologyScale: topology.scale,
    });
    if (shape.area < 6) result.reasons.push('too_few_pixels');
    if (shape.area && result.largestFraction < 0.95)
      result.reasons.push('disconnected_mask');
    if (result.occupancy > 0.5 && result.aspect < 4)
      result.reasons.push('broad_mask');
    if (shape.perimeter > 6000) result.reasons.push('perimeter_budget');
    if (!topology.converged) result.reasons.push('thinning_limit');
    if (topology.converged && topology.ends !== 2)
      result.reasons.push('endpoint_count');
    if (topology.branches) result.reasons.push('branched_mask');
    result.acceptedGeometry = result.reasons.length === 0;
    const preview = maskSchema.safeParse({
      format: 'svg_path',
      width: raw.width,
      height: raw.height,
      path: simplifyPath(decodeMaskToSVGPath(raw)),
    });
    if (preview.success) result.preview = preview.data;
    else result.reasons.push('preview_budget');
  } catch {
    result.reasons.push('invalid_mask');
  }
  return result;
}
