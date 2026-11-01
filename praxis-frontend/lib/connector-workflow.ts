import { z } from "zod";
import { geometryBoxSchema as boxSchema, maskSchema } from "./geometry";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const connectorPhaseSchema = z.enum([
  "prepared",
  "admitted",
  "dispatching",
  "response_recorded",
  "evaluated",
  "outcome_unknown",
  "not_sent",
]);
export const connectorAccountingSchema = z
  .object({
    reservedRequests: z.number().int().nonnegative(),
    reservedPixels: z.number().int().nonnegative(),
    dispatchAttempts: z.number().int().nonnegative(),
    dispatchedPixels: z.number().int().nonnegative(),
    responsesRecorded: z.number().int().nonnegative(),
    unknownUsageRequests: z.number().int().nonnegative(),
    unknownUsagePixels: z.number().int().nonnegative(),
    providerConfirmedUsage: z.null(),
    billedCost: z.null(),
    note: z.string(),
  })
  .strict();
export const connectorEvaluationSchema = z
  .object({
    invariants: z
      .object({
        requestsBeyondBudget: z.number().int().nonnegative(),
        missingRequiredProvenance: z.number().int().nonnegative(),
        confirmedIdentityMerges: z.literal(0),
        sourceEvidencePreserved: z.boolean(),
      })
      .strict()
      .optional(),
    status: z.enum([
      "unavailable",
      "incomplete",
      "passed",
      "failed",
      "synthetic_pass",
    ]),
    referenceHash: hash.nullable(),
    independentGroundTruth: z.boolean(),
    plannedStrategyCount: z.literal(2),
    validMaskArms: z.number().int().min(0).max(2),
    abComparison: z.enum(["complete", "incomplete"]),
    successRate: z.number().min(0).max(1).nullable(),
    armResults: z
      .array(
        z
          .object({
            variant: z.string(),
            outcome: z.string(),
            acceptedMaskCount: z.number().int().nonnegative(),
            emptyPrediction: z
              .object({
                iou: z.literal(0),
                recall: z.literal(0),
                precision: z.null(),
                leakage: z.null(),
              })
              .strict()
              .optional(),
            maskMetrics: z
              .array(
                z
                  .object({
                    observationId: z.uuid(),
                    iou: z.number().min(0).max(1).nullable(),
                    recall: z.number().min(0).max(1).nullable(),
                    precision: z.number().min(0).max(1).nullable(),
                    leakage: z.number().min(0).max(1).nullable(),
                    identityCorrectness: z.enum([
                      "correct",
                      "incorrect",
                      "unreviewed",
                      "uncertain",
                    ]),
                  })
                  .strict(),
              )
              .max(32),
          })
          .strict(),
      )
      .max(2),
    note: z.string(),
  })
  .strict();
export const automaticTargetingRecordSchema = z
  .object({
    workflowId: hash,
    analysisId: z.uuid(),
    imageHash: hash,
    objectId: z.uuid(),
    sourceSnapshotId: z.uuid(),
    sourceSnapshotHash: hash,
    preparedAt: z.number().int().nonnegative(),
    providerBaseUrl: z.string(),
    model: z.string(),
    experimentId: z.uuid().nullable(),
    replacementOf: hash.nullable(),
    status: z.enum([
      "prepared",
      "starting",
      "running",
      "completed",
      "failed",
      "interrupted",
      "released",
    ]),
    phase: connectorPhaseSchema,
    budget: z
      .object({
        scope: z.literal("isolated_experiment"),
        maxRequests: z.literal(3),
        maxPixels: z.literal(6000000),
        plannedRequests: z.number().int().min(1).max(3),
        plannedPixels: z.number().int().positive(),
      })
      .strict(),
    accounting: connectorAccountingSchema,
    arms: z
      .array(
        z
          .object({
            name: z.string(),
            prompt: z.string().nullable(),
            crop: boxSchema.nullable(),
            imageSha256: hash.nullable(),
            status: z.string(),
            reason: z.string(),
          })
          .strict(),
      )
      .length(2),
    pointStatus: z.enum(["proposed", "abstained"]),
    pointCues: z
      .array(
        z
          .object({
            observationId: z.uuid(),
            point: z.tuple([
              z.number().int().nonnegative(),
              z.number().int().nonnegative(),
            ]),
            interiorDistance: z.number().int().positive(),
          })
          .strict(),
      )
      .max(1),
    measurements: z
      .array(
        z
          .object({
            variant: z.string(),
            requestId: z.uuid(),
            status: z.string(),
            phase: connectorPhaseSchema,
            providerOutcome: z.string(),
            startedAt: z.number().int().nonnegative(),
            finishedAt: z.number().int().nonnegative().nullable(),
            wallMs: z.number().nonnegative().nullable(),
            maskCount: z.number().int().nonnegative(),
            observationIds: z.array(z.uuid()).max(32),
            previews: z
              .array(
                z
                  .object({
                    id: z.uuid(),
                    bbox: boxSchema,
                    mask: maskSchema.optional(),
                  })
                  .strict(),
              )
              .max(32),
            events: z
              .array(
                z
                  .object({
                    phase: connectorPhaseSchema,
                    at: z.number().int().nonnegative(),
                  })
                  .strict(),
              )
              .max(12),
          })
          .strict(),
      )
      .max(3),
    evaluationStatus: z
      .enum(["not_evaluated", "succeeded", "failed"])
      .optional(),
    evaluationError: z.string().nullable().optional(),
    evaluation: connectorEvaluationSchema.nullable(),
    evidenceUrl: z.string(),
    protocol: z
      .object({
        thresholds: z
          .object({
            version: z.string(),
            minimumIoU: z.number(),
            minimumRecall: z.number(),
            maximumConductorLeakage: z.number(),
            requiredAcceptedIdentityCorrectness: z.literal(1),
            maximumIncorrectConfirmedMerges: z.literal(0),
            maximumBudgetOverage: z.literal(0),
            maximumMissingProvenance: z.literal(0),
          })
          .strict(),
        referenceHash: hash.nullable(),
      })
      .strict()
      .optional(),
    referenceStatus: z
      .enum([
        "registered_independent",
        "registered_synthetic",
        "registered_unqualified",
        "not_registered",
      ])
      .optional(),
    executionError: z.string().nullable().optional(),
    protocolHash: hash,
    note: z.string(),
  })
  .strict();
export type AutomaticTargetingRecord = z.infer<
  typeof automaticTargetingRecordSchema
>;
export type ConnectorEvaluation = z.infer<typeof connectorEvaluationSchema>;
