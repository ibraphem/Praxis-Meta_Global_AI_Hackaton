import { z } from 'zod';
import { canonicalHash } from '../lib/canonical-json.js';
import { connectorThresholds } from './connector-thresholds.js';
import { targetingV2Policy } from './scene-automatic-targeting-v2.js';
import { referenceBoundaryBandPx } from './pixel-reference.js';
export const v2Strategies = [
  'A-inventory-box-v2',
  'B-mask-interior-v2',
  'C-body-aware-v2',
] as const;
export const referenceProvenanceSchema = z
  .object({
    annotationMethod: z.enum([
      'manual_brush',
      'manual_external',
      'assistant_proposal',
      'synthetic_fixture',
    ]),
    predictionExposure: z.enum(['never_seen', 'seen_before', 'unknown']),
    originalImageOnly: z.boolean(),
    independentAttestation: z.boolean(),
    reviewer: z.string().trim().min(1).max(100),
  })
  .strict();
const definition = {
  version: 'connector-comparison-protocol-v2' as const,
  algorithmVersion: 'automatic-targeting-v2',
  cuePolicyHash: canonicalHash(targetingV2Policy),
  strategies: [...v2Strategies],
  requiredComparisons: [...v2Strategies],
  requiredAcceptedStrategies: ['C-body-aware-v2'],
  thresholds: {
    ...connectorThresholds,
    version: 'connector-release-gate-v2' as const,
  },
  referencePolicy: 'blinded_original_only_attested_human_v2',
  // Frozen references carry a deterministic uncertainty band at every class edge.
  referenceBoundaryBandPx: referenceBoundaryBandPx,
  // An arm is compared when it was measured or when the frozen plan records a
  // reasoned abstention for it; a planned arm that never ran stays incomplete.
  comparedWhen: 'measured_or_recorded_abstention',
  maxRequests: 3,
  maxPixels: 6000000,
  automaticRetries: 0,
};
export const connectorProtocolV2 = Object.freeze({
  ...definition,
  protocolHash: canonicalHash(definition),
});
export function validateProtocolV2(protocol: unknown) {
  const { protocolHash, ...body } = (protocol ?? {}) as Record<string, unknown>;
  if (
    canonicalHash(body) !== protocolHash ||
    canonicalHash(protocol) !== canonicalHash(connectorProtocolV2)
  )
    throw Error('Unknown or modified connector v2 evaluation contract.');
  return connectorProtocolV2;
}
/** A frozen v2 plan records a reasoned abstention for an arm it never specified.
 * Such an arm is compared (its absence is explained and hashed into the plan);
 * a specified arm that produced no measurement is not. */
export function recordedAbstention(
  plan: {
    variants: Array<{ name: string }>;
    automaticTargeting?:
      | {
          version: string;
          pointStatus: string;
          diagnostics?: { bodyProposal?: { status: string } };
        }
      | undefined;
  },
  variant: string,
) {
  const automatic = plan.automaticTargeting;
  if (
    !automatic ||
    automatic.version !== 'automatic-targeting-v2' ||
    plan.variants.some((v) => v.name === variant)
  )
    return false;
  if (variant === 'B-mask-interior-v2')
    return automatic.pointStatus === 'abstained';
  if (variant === 'C-body-aware-v2')
    return automatic.diagnostics?.bodyProposal?.status === 'abstained';
  return false;
}
export function qualifiedHumanReferenceV2(reference: {
  source: string;
  independent: boolean;
  provenance?: z.infer<typeof referenceProvenanceSchema> | undefined;
}) {
  const p = reference.provenance;
  return (
    reference.source === 'human_review' &&
    reference.independent &&
    !!p &&
    ['manual_brush', 'manual_external'].includes(p.annotationMethod) &&
    p.predictionExposure === 'never_seen' &&
    p.originalImageOnly &&
    p.independentAttestation &&
    p.reviewer !== 'Unassigned'
  );
}
