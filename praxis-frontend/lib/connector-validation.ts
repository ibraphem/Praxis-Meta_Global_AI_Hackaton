import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const pixelRunsSchema = z
  .array(
    z.tuple([
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
      z.number().int().positive(),
    ]),
  )
  .max(120000);
export const annotationContentSchema = z
  .object({
    version: z.literal("connector-annotation-v1"),
    annotationMethod: z
      .enum([
        "manual_brush",
        "manual_external",
        "assistant_proposal",
        "synthetic_fixture",
      ])
      .default("manual_brush"),
    regions: z
      .object({
        connector: pixelRunsSchema,
        redWire: pixelRunsSchema,
        blackWire: pixelRunsSchema,
        uncertain: pixelRunsSchema,
      })
      .strict(),
    boundaryDefinition: z.string().trim().min(20).max(1500),
    reviewer: z.string().trim().min(1).max(100),
    source: z.enum(["human_review", "assistant_visual", "synthetic_fixture"]),
    predictionExposure: z.enum(["never_seen", "seen_before", "unknown"]),
    originalImageOnly: z.boolean(),
    independentAttestation: z.boolean(),
  })
  .strict();
export type AnnotationContent = z.infer<typeof annotationContentSchema>;
export const retrospectiveResultSchema = z
  .object({
    evaluationId: hash,
    workflowId: hash,
    experimentId: z.uuid(),
    objectId: z.uuid(),
    imageHash: hash,
    sourceSnapshotHash: hash,
    reportHash: hash,
    predictionHash: hash,
    referenceHash: hash,
    evaluatedAt: z.number().int().nonnegative(),
    mode: z.literal("retrospective_diagnostic"),
    strategy: z.enum([
      "A-auto-inventory-box",
      "B-auto-baseline-interior",
      "A-inventory-box-v2",
      "B-mask-interior-v2",
      "C-body-aware-v2",
    ]),
    protocolVersion: z.literal("connector-comparison-protocol-v2").optional(),
    protocolHash: hash.optional(),
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
    configurationHash: hash,
    originalContractPreserved: z.literal(true),
    independentGroundTruth: z.boolean(),
    blinded: z.boolean(),
    status: z.enum(["passed", "failed", "incomplete", "synthetic_pass"]),
    abComparison: z.enum(["complete", "incomplete"]),
    metrics: z
      .array(
        z
          .object({
            observationId: z.uuid(),
            iou: z.number().min(0).max(1),
            recall: z.number().min(0).max(1),
            precision: z.number().min(0).max(1).nullable(),
            leakage: z.number().min(0).max(1).nullable(),
            redWireLeakage: z.number().min(0).max(1).nullable(),
            blackWireLeakage: z.number().min(0).max(1).nullable(),
            identityCorrectness: z.enum([
              "correct",
              "incorrect",
              "uncertain",
              "unreviewed",
            ]),
            accepted: z.boolean(),
            foregroundPixels: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(32),
    provenanceValid: z.boolean(),
    previewAgreement: z.boolean(),
    note: z.string(),
  })
  .strict();
export const connectorValidationSummarySchema = z
  .object({
    evidenceLinks: z
      .array(z.object({ workflowId: hash, url: z.string() }).strict())
      .max(20)
      .optional(),
    references: z
      .array(
        z
          .object({
            referenceHash: hash,
            workflowId: hash,
            annotationVersion: z.number().int().positive(),
            objectId: z.uuid(),
            frozenAt: z.number().int().nonnegative(),
            independent: z.boolean(),
            reviewer: z.string(),
            source: z
              .enum(["human_review", "assistant_visual", "synthetic_fixture"])
              .optional(),
            predictionExposure: z
              .enum(["never_seen", "seen_before", "unknown"])
              .optional(),
            pixelCounts: z
              .object({
                connector: z.number(),
                redWire: z.number(),
                blackWire: z.number(),
                uncertain: z.number(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(100),
    evaluations: z.array(retrospectiveResultSchema).max(200),
    gates: z
      .array(
        z
          .object({
            objectId: z.uuid(),
            status: z.enum(["passed", "blocked"]),
            evaluationId: hash.nullable(),
            reason: z.string(),
          })
          .strict(),
      )
      .max(164),
  })
  .strict();
export type RetrospectiveResult = z.infer<typeof retrospectiveResultSchema>;
export const connectorAnnotationViewSchema = z
  .object({
    schemaVersion: z.literal("praxis-connector-annotation-view-v1"),
    analysisId: z.uuid(),
    workflowId: hash,
    imageHash: hash,
    imageUrl: z
      .string()
      .regex(
        /^\/api\/analyses\/[0-9a-f-]{36}\/connector-annotation-image\?workflowId=[a-f0-9]{64}$/,
      ),
    draft: z
      .object({
        draftId: z.uuid(),
        workflowId: hash,
        imageHash: hash,
        objectId: z.uuid(),
        image: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict(),
        revision: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
        content: annotationContentSchema,
      })
      .strict(),
    references: connectorValidationSummarySchema.shape.references,
    note: z.string(),
  })
  .strict();
