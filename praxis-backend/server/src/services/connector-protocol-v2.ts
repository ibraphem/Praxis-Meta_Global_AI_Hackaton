import { z } from 'zod';
import { canonicalHash } from '../lib/canonical-json.js';
import { connectorThresholds } from './connector-thresholds.js';
import { targetingV2Policy } from './scene-automatic-targeting-v2.js';
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
