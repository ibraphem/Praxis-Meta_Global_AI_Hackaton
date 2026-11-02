import { z } from "zod";
import { geometryBoxSchema as boxSchema } from "./geometry";
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  id = z.uuid(),
  count = z.number().int().nonnegative();
export const junctionPointSchema = z.tuple([count, count]);
export const junctionCandidateSchema = z
  .object({
    id,
    conductorObjectId: id,
    region: boxSchema,
    position: junctionPointSchema.nullable(),
    source: z.enum(["reviewed_native_proximity", "bbox_search_only"]),
    observationIds: z.array(id).max(16),
    nativeHashes: z.array(hash).max(16),
    physicalAttachmentEstablished: z.literal(false),
  })
  .strict();
export const junctionOutcomeSchema = z
  .object({
    id,
    expectedConductorObjectId: id,
    conductorObjectId: id.nullable(),
    kind: z.enum(["housing_entry", "exposed_contact", "unknown"]),
    position: junctionPointSchema.nullable(),
    visibility: z.enum(["visible", "occluded", "uncertain"]),
    associationStatus: z.enum(["proposed", "unresolved"]),
    contactPosition: junctionPointSchema.nullable(),
    contactVisibility: z.enum(["visible", "occluded", "uncertain"]),
    modelConfidence: z.number().min(0).max(1).nullable(),
    evidenceSource: z.enum(["geometry", "muse"]),
    candidateIds: z.array(id).max(6),
    reason: z.string().min(8).max(800),
    electricalConnectionStatus: z.literal("unestablished"),
  })
  .strict()
  .superRefine((o, c) => {
    if (
      (o.visibility === "visible") !== (o.position !== null) ||
      (o.associationStatus === "proposed") !== (o.visibility === "visible") ||
      (o.evidenceSource === "geometry" && o.position !== null) ||
      (o.visibility !== "visible" && o.contactVisibility === "visible") ||
      (o.visibility === "visible" &&
        (o.kind === "unknown" ||
          o.conductorObjectId !== o.expectedConductorObjectId)) ||
      (o.visibility !== "visible" &&
        (o.conductorObjectId !== null || o.contactPosition !== null)) ||
      (o.kind === "housing_entry" &&
        (o.contactPosition !== null || o.contactVisibility === "visible")) ||
      (o.kind === "exposed_contact" &&
        o.visibility === "visible" &&
        (o.contactVisibility !== "visible" ||
          JSON.stringify(o.contactPosition) !== JSON.stringify(o.position)))
    )
      c.addIssue({
        code: "custom",
        message:
          "Visible housing junctions do not establish hidden electrical contacts.",
      });
  });
export const junctionReviewSchema = z
  .object({
    reviewId: id,
    outcomeId: id,
    decision: z.enum(["confirm", "correct", "unknown"]),
    position: junctionPointSchema.nullable(),
    kind: z.enum(["housing_entry", "exposed_contact", "unknown"]),
    reason: z.string().trim().min(8).max(800),
    reviewer: z.string().trim().min(1).max(100),
    originalImageOnly: z.literal(true),
    visibleEvidence: z.boolean(),
    source: z.literal("human_review"),
    reviewedAt: count,
  })
  .strict()
  .superRefine((r, c) => {
    if (
      r.decision === "unknown"
        ? r.position !== null || r.kind !== "unknown"
        : !r.position || r.kind === "unknown" || !r.visibleEvidence
    )
      c.addIssue({
        code: "custom",
        message:
          "Confirmation requires an explicitly visible junction and position.",
      });
  });
export const junctionEffectiveOutcomeSchema = z
  .object({
    ...junctionOutcomeSchema.shape,
    associationStatus: z.enum(["proposed", "unresolved", "confirmed"]),
    evidenceSource: z.enum(["geometry", "muse", "human_review"]),
    reviewId: id.optional(),
  })
  .strict()
  .superRefine((o, c) => {
    if (
      (o.visibility === "visible") !== (o.position !== null) ||
      (o.kind === "housing_entry" &&
        (o.contactPosition !== null || o.contactVisibility === "visible")) ||
      (o.associationStatus === "confirmed" &&
        (o.evidenceSource !== "human_review" ||
          !o.reviewId ||
          o.visibility !== "visible"))
    )
      c.addIssue({
        code: "custom",
        message:
          "Confirmed physical junctions require visible human review; housing entries never locate hidden contacts.",
      });
  });
export const junctionPlanSchema = z
  .object({
    version: z.literal("connector-junction-plan-v1"),
    planId: hash,
    analysisId: id,
    connectorObjectId: id,
    conductorObjectIds: z.tuple([id, id]),
    imageHash: hash,
    image: z.object({ width: count, height: count }).strict(),
    inputSnapshotId: id,
    inputSnapshotHash: hash,
    samSnapshotId: id,
    samSnapshotHash: hash,
    segmentation: z
      .object({
        workflowId: hash,
        experimentId: id,
        evaluationId: hash,
        observationId: id,
        nativeHash: hash,
        acceptedRasterHash: hash,
        scoredMask: z.enum(["native", "keep_dark_halo"]),
        refinementHash: hash.nullable(),
        acceptedBounds: boxSchema,
        bbox: boxSchema,
      })
      .strict(),
    crop: boxSchema,
    candidates: z.array(junctionCandidateSchema).max(6),
    policy: z
      .object({
        version: z.literal("connector-junction-policy-v1"),
        boundaryBandPixels: z.literal(8),
        maxBoundarySamples: z.literal(4096),
        maxCandidatesPerConductor: z.literal(3),
        benchmarkTolerancePixels: z.literal(5),
      })
      .strict(),
    inputImages: z
      .array(
        z
          .object({
            kind: z.enum(["original_crop", "proposal_overlay"]),
            sha256: hash,
            width: count,
            height: count,
            bytes: count,
            mimeType: z.enum(["image/jpeg", "image/png"]),
          })
          .strict(),
      )
      .length(2),
    useMuse: z.boolean(),
    providerBaseUrl: z.string(),
    model: z.string(),
    requestPayloadHash: hash,
    acceptanceEvidenceHash: hash,
    budget: z
      .object({
        samRequests: z.literal(0),
        museRequests: z.union([z.literal(0), z.literal(1)]),
        inputPixels: count,
        maxRetries: z.literal(0),
        timeoutMs: count,
      })
      .strict(),
    scopeHash: hash,
  })
  .strict();
export const junctionReferenceContentSchema = z
  .object({
    imageHash: hash,
    connectorObjectId: id,
    reviewer: z.string().trim().min(1).max(100),
    source: z.enum(["human_review", "assistant_visual", "synthetic_fixture"]),
    annotationMethod: z.enum([
      "manual_point",
      "assistant_proposal",
      "synthetic_fixture",
    ]),
    predictionExposure: z.enum(["never_seen", "seen_before", "unknown"]),
    originalImageOnly: z.boolean(),
    independentAttestation: z.boolean(),
    junctions: z
      .array(
        z
          .object({
            conductorObjectId: id,
            kind: z.enum(["housing_entry", "exposed_contact", "unknown"]),
            visibility: z.enum(["visible", "occluded", "uncertain"]),
            position: junctionPointSchema.nullable(),
          })
          .strict(),
      )
      .length(2),
  })
  .strict()
  .superRefine((r, c) => {
    if (
      new Set(r.junctions.map((j) => j.conductorObjectId)).size !== 2 ||
      r.junctions.some(
        (j) =>
          (j.visibility === "visible") !== (j.position !== null) ||
          (j.visibility === "visible" && j.kind === "unknown"),
      )
    )
      c.addIssue({
        code: "custom",
        message:
          "Reference points must describe distinct conductors and visible junction kinds.",
      });
  });
export const junctionReferenceSchema = z
  .object({
    referenceHash: hash,
    planId: hash,
    version: count,
    frozenAt: count,
    independent: z.boolean(),
    content: junctionReferenceContentSchema,
  })
  .strict();
export const junctionEvaluationSchema = z
  .object({
    version: z.literal("connector-junction-evaluation-v1"),
    evaluationId: hash,
    referenceHash: hash,
    evaluatedAt: count,
    predictionHash: hash,
    predictionLayer: z.enum(["original", "reviewed"]),
    confirmedCount: count,
    status: z.enum([
      "passed",
      "failed",
      "incomplete",
      "diagnostic",
      "synthetic_pass",
    ]),
    independentGroundTruth: z.boolean(),
    tolerancePixels: z.literal(5),
    visibleExpected: count,
    localizedWithinTolerance: count,
    unresolvedVisible: count,
    hiddenExpected: count,
    appropriateAbstentions: count,
    wrongConfirmedAssociations: count,
    provenanceCoverage: z.number().min(0).max(1),
    perConductor: z
      .array(
        z
          .object({
            conductorObjectId: id,
            errorPixels: z.number().nonnegative().nullable(),
            withinTolerance: z.boolean().nullable(),
            status: z.enum([
              "localized",
              "unresolved",
              "wrong_position_or_association",
              "wrong_kind",
              "appropriate_abstention",
              "unsupported_visible_claim",
            ]),
          })
          .strict(),
      )
      .length(2),
    note: z.string(),
  })
  .strict();
export const junctionRecordSchema = z
  .object({
    plan: junctionPlanSchema,
    revision: count,
    preparedAt: count,
    phase: z.enum([
      "prepared",
      "queued",
      "admitted",
      "dispatching",
      "response_recorded",
      "finished",
      "failed",
      "interrupted",
    ]),
    attemptId: id.nullable(),
    requestId: id.nullable(),
    admittedAt: count.nullable(),
    startedAt: count.nullable(),
    finishedAt: count.nullable(),
    errorCode: z.string().nullable(),
    outcomes: z.array(junctionOutcomeSchema).length(2),
    reviews: z.array(junctionReviewSchema).max(100),
    effectiveOutcomes: z.array(junctionEffectiveOutcomeSchema).length(2),
    references: z.array(junctionReferenceSchema).max(20),
    evaluations: z.array(junctionEvaluationSchema).max(100),
    accounting: z
      .object({
        reservedRequests: count,
        dispatchAttempts: count,
        responsesRecorded: count,
        unknownUsageRequests: count,
        reservedPixels: count,
        dispatchedPixels: count,
        billedCost: z.null(),
      })
      .strict(),
    latency: z
      .object({
        preparationMs: count,
        queueMs: count.nullable(),
        providerMs: count.nullable(),
        totalMs: count.nullable(),
      })
      .strict(),
    evidenceUrl: z.string(),
  })
  .strict();
export type JunctionPlan = z.infer<typeof junctionPlanSchema>;
export type JunctionOutcome = z.infer<typeof junctionOutcomeSchema>;
export type JunctionReview = z.infer<typeof junctionReviewSchema>;
export type JunctionReference = z.infer<typeof junctionReferenceSchema>;
export type JunctionEvaluation = z.infer<typeof junctionEvaluationSchema>;
export type JunctionRecord = z.infer<typeof junctionRecordSchema>;
