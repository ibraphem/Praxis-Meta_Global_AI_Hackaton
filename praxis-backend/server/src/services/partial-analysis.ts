import { prioritizeWireEvidence } from './wire-mask-evidence.js';
import { RUNTIME } from '../lib/runtime.js';
import { cropFragment } from './wire-fragments.js';
import type { Config } from '../config.js';
import {
  analysisSchema,
  type Analysis,
  type Component,
} from '../schemas/vision.js';
import { WireGeometry } from './wire-geometry.js';
import type { SamSnapshot } from './vision.js';

/** No provider calls, grouping, or component confirmations in this fallback. */
export function partialAnalysis(
  snapshot: SamSnapshot,
  config: Config,
): Analysis {
  const geometry = new WireGeometry(snapshot.image);
  const objects: Component[] = [];
  const proposals: NonNullable<Analysis['proposals']> = [];
  for (const c of prioritizeWireEvidence(snapshot.candidates)) {
    const base = {
      id: c.id,
      type: c.type,
      bbox: c.bbox,
      interpretation: 'uncertain' as const,
      reviewStatus: 'sam_unverified' as const,
      localizationSource: 'sam' as const,
      guidanceEligible: false as const,
      ...(c.confidence === undefined ? {} : { confidence: c.confidence }),
    };
    if (c.type !== 'jumper_wire') {
      objects.push({ ...base, geometryStatus: 'box_only' });
      continue;
    }
    const resolved = geometry.resolve(c);
    if (resolved.ok)
      objects.push({
        ...base,
        mask: resolved.mask.geometry,
        ...(cropFragment(c).cropOrigin
          ? {
              cropOrigin: cropFragment(c).cropOrigin!,
              touchesCropBoundary: cropFragment(c).touchesCropBoundary,
            }
          : {}),
        geometryStatus: 'segmented',
        identityStatus: 'unverified',
      });
    else
      proposals.push({
        id: `wire_region_${proposals.length + 1}`,
        type: 'jumper_wire',
        bbox: c.bbox,
        refinementStatus: 'ambiguous',
        reason: resolved.reason,
        guidanceEligible: false,
      });
  }
  return analysisSchema.parse({
    image: { width: snapshot.image.width, height: snapshot.image.height },
    objects,
    proposals,
    provenance: {
      runtime: RUNTIME,
      mode: 'sam-only',
      segmentationModel: config.META_SAM_MODEL,
      reasoningModel: config.META_REASONING_MODEL,
    },
  });
}
