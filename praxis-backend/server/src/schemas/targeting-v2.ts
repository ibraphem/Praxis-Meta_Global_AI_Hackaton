import { z } from 'zod';
import { boxSchema } from './geometry.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  count = z.number().int().nonnegative(),
  point = z.tuple([count, count]);
export const targetingV2DiagnosticsSchema = z
  .object({
    version: z.literal('automatic-targeting-diagnostics-v2'),
    decodedPixels: count,
    baseline: z
      .array(
        z
          .object({
            observationId: z.uuid(),
            reasons: z.array(z.string()).max(12),
            pixelRejections: z
              .object({
                insufficientInterior: count,
                outsideTarget: count,
                conductorOrNeighborPixels: count,
                uncertainNeighborBox: count,
              })
              .strict(),
            eligibleInteriorPixels: count,
          })
          .strict(),
      )
      .max(450),
    eligibleBaselineMasks: count,
    nativeSources: z
      .array(
        z
          .object({
            observationId: z.uuid(),
            samSnapshotId: z.uuid(),
            samSnapshotHash: hash,
            nativeHash: hash,
          })
          .strict(),
      )
      .max(450),
    exclusions: z
      .array(
        z
          .object({
            objectId: z.uuid(),
            mode: z.enum(['native_mask_with_margin', 'uncertain_bbox']),
            reason: z.string(),
            observationIds: z.array(z.uuid()).max(450),
          })
          .strict(),
      )
      .max(164),
    bodyProposal: z
      .object({
        source: z.literal('local_dark_core_v1'),
        status: z.enum(['proposed', 'abstained']),
        reason: z.string(),
        box: boxSchema.nullable(),
        positivePoints: z.array(point).max(2),
        componentCount: count,
        pixelDiagnostics: z
          .object({
            darkPixels: count,
            excludedByNativeMasks: count,
            excludedByUncertainBoxes: count,
            remainingDarkPixels: count,
            interiorCorePixels: count,
          })
          .strict()
          .optional(),
        physicalBoundaryStatus: z.literal('unconfirmed'),
      })
      .strict(),
    negativeCues: z
      .array(
        z
          .object({
            objectId: z.uuid(),
            observationId: z.uuid(),
            point,
            reviewId: z.uuid(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
export const targetingV2ProtocolSchema = z
  .object({
    version: z.literal('connector-comparison-protocol-v2'),
    algorithmVersion: z.literal('automatic-targeting-v2'),
    cuePolicyHash: hash,
    strategies: z.tuple([
      z.literal('A-inventory-box-v2'),
      z.literal('B-mask-interior-v2'),
      z.literal('C-body-aware-v2'),
    ]),
    requiredComparisons: z.tuple([
      z.literal('A-inventory-box-v2'),
      z.literal('B-mask-interior-v2'),
      z.literal('C-body-aware-v2'),
    ]),
    requiredAcceptedStrategies: z.tuple([z.literal('C-body-aware-v2')]),
    thresholds: z
      .object({
        version: z.literal('connector-release-gate-v2'),
        minimumIoU: z.number(),
        minimumRecall: z.number(),
        maximumConductorLeakage: z.number(),
        requiredAcceptedIdentityCorrectness: z.literal(1),
        maximumIncorrectConfirmedMerges: z.literal(0),
        maximumBudgetOverage: z.literal(0),
        maximumMissingProvenance: z.literal(0),
      })
      .strict(),
    referencePolicy: z.literal('blinded_original_only_attested_human_v2'),
    maxRequests: z.literal(3),
    maxPixels: z.literal(6000000),
    automaticRetries: z.literal(0),
    protocolHash: hash,
  })
  .strict();
