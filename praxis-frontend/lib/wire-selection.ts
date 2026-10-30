import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const selectionEvidenceSchema = z
  .object({
    evidenceHash: hash,
    sourceSnapshotId: z.uuid(),
    sourceAttemptId: z.uuid(),
    latestObjectId: z
      .string()
      .regex(/^jumper_wire_[1-9]\d*$/)
      .optional(),
    state: z.enum(["current", "retained"]),
    requiresReview: z.boolean(),
    reasons: z
      .array(
        z.enum([
          "not_selected_by_latest_interpretation",
          "changed_interpretation",
          "overlapping_hypothesis",
          "not_present_in_current_geometry",
        ]),
      )
      .max(4),
  })
  .strict();
export const wireSelectionSchema = z
  .object({
    version: z.literal("preserve-wire-evidence-v1"),
    previousSnapshotId: z.uuid(),
    previousAttemptId: z.uuid(),
    restoredHistorical: z.number().int().min(0).max(100),
    priorSelectable: z.number().int().min(0).max(100),
    rawSelectable: z.number().int().min(0).max(100),
    matched: z.number().int().min(0).max(100),
    retained: z.number().int().min(0).max(100),
    added: z.number().int().min(0).max(100),
    reviewRequired: z.number().int().min(0).max(100),
    deferredObjectIds: z
      .array(z.string().regex(/^jumper_wire_[1-9]\d*$/))
      .max(100),
  })
  .strict();

export const candidateLayerSchema = z
  .object({
    version: z.literal("sam-candidate-layer-v1"),
    publication: z.enum(["local_geometry", "muse_reconciled"]),
    snapshotId: z.uuid(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceAttemptId: z.uuid(),
  })
  .strict();
