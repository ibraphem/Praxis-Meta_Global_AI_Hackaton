import { runtimeSchema } from "./runtime-schema";
import {
  recoveryReportSchema,
  wireIdentitySchema,
  cropAttemptSchema,
  recoveryTargetSchema,
} from "./wire-recovery";
import { geometryBoxSchema } from "./geometry";
import { z } from "zod";
import { analysisSchema } from "./vision";
import { diagnosticsSchema } from "./diagnostics";

export const attemptStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "timed_out",
  "interrupted",
  "failed",
]);
export const attemptSchema = z
  .object({
    attemptId: z.uuid(),
    status: attemptStatusSchema,
    upstreamOutcome: z.enum(["not_sent", "unknown", "response_received"]),
    retryPolicy: z.enum([
      "dispatch_existing",
      "blocked",
      "manual_only",
      "not_retryable",
    ]),
    createdAt: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative().optional(),
    finishedAt: z.number().int().nonnegative().optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
    diagnostics: diagnosticsSchema.optional(),
    outputSnapshotId: z.uuid().optional(),
    outputSnapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    samSnapshotId: z.uuid().optional(),
    samSnapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    snapshotBinding: z.enum(["recorded", "legacy_inferred"]).optional(),
  })
  .strict();
const stageSchema = z
  .object({
    status: z.union([attemptStatusSchema, z.literal("not_started")]),
    attempts: z.array(attemptSchema).max(20),
  })
  .strict();
const snapshotRefSchema = z
  .object({
    samSnapshotId: z.uuid(),
    samSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/),
    model: z.string().min(1).max(100),
    processingVersion: z.string().min(1).max(100),
    sourceAttemptId: z.uuid(),
    createdAt: z.number().int().nonnegative(),
    parentSnapshotId: z.uuid().optional(),
    origin: z.enum(["recorded", "legacy_import"]),
  })
  .strict();
export const analysisJobSchema = z
  .object({
    runtime: runtimeSchema.optional(),
    analysisId: z.uuid(),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/),
    image: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    status: z.enum([
      "queued",
      "segmenting",
      "interpreting",
      "partial",
      "completed",
      "failed",
    ]),
    revision: z.union([z.literal("sam"), z.uuid()]),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    settings: z
      .object({
        maxDimension: z.number().int().min(0).max(4096),
        minimalPrompt: z.boolean(),
        mode: z.enum(["combined", "reasoning-only"]),
        samModel: z.string().min(1).max(100),
        museModel: z.string().min(1).max(100),
      })
      .strict(),
    sam: stageSchema.extend({ snapshotRef: snapshotRefSchema.optional() }),
    muse: stageSchema.extend({ resultAttemptId: z.uuid().optional() }),
    experiment: z
      .object({
        experimentId: z.uuid(),
        analysisId: z.uuid(),
        status: z.enum(["running", "interrupted"]),
        leaseUntil: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    recovery: stageSchema
      .extend({
        operation: z.enum(["audit", "recover", "verify", "recover_short"]),
        target: recoveryTargetSchema.optional(),
        candidateId: z.string().max(64).optional(),
        snapshotRef: snapshotRefSchema.optional(),
        report: recoveryReportSchema.optional(),
        budget: z
          .object({
            requests: z.number().int().nonnegative(),
            pixels: z.number().int().nonnegative(),
            verificationRequests: z.number().int().nonnegative(),
            rounds: z.number().int().nonnegative(),
          })
          .strict(),
        visited: z.array(geometryBoxSchema).max(12),
        cropAttempts: z.array(cropAttemptSchema).max(24).optional(),
      })
      .optional(),
    wireIdentities: z.array(wireIdentitySchema).max(100).optional(),
    candidatePublicationError: z.literal("WIRE_SELECTION_BUDGET").optional(),
    result: analysisSchema.optional(),
  })
  .strict();
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export function jobIsActive(job: AnalysisJob) {
  return (
    job.experiment?.status === "running" ||
    [job.sam.status, job.muse.status, job.recovery?.status].some(
      (s) => s === "queued" || s === "running",
    )
  );
}
export function retryStage(job: AnalysisJob): "sam" | "muse" | null {
  if (job.experiment || jobIsActive(job)) return null;
  const stage = job.sam.status === "succeeded" ? "muse" : "sam";
  return job[stage].attempts.at(-1)?.retryPolicy === "manual_only"
    ? stage
    : null;
}
export function jobMessage(job: AnalysisJob) {
  if (job.recovery?.status === "running" || job.recovery?.status === "queued")
    return job.recovery.operation === "audit"
      ? "Auditing wire coverage. Existing results are saved."
      : job.recovery.operation === "recover" ||
          job.recovery.operation === "recover_short"
        ? "Recovering wire candidates within the saved budget. Existing results are saved."
        : "Muse is verifying a selected candidate. Its response remains a proposal.";
  if (job.experiment)
    return job.experiment.status === "running"
      ? "A controlled Muse experiment is running. Live analysis is paused; saved results remain available."
      : "A controlled Muse experiment was interrupted. Release its reservation explicitly before starting more model work; its upstream outcome is unknown.";
  if (job.candidatePublicationError)
    return "New geometry is saved, but the selection budget is full. Earlier masks remain available; inspect recovery evidence for deferred candidates.";
  if (
    job.result &&
    ["failed", "timed_out", "interrupted"].includes(job.muse.status)
  ) {
    const state =
      job.muse.status === "timed_out"
        ? "timed out"
        : job.muse.status === "interrupted"
          ? "was interrupted"
          : "failed";
    return `Muse interpretation ${state}. Saved candidates remain available for calibration and review; wire identity stays unverified.${job.muse.attempts.at(-1)?.upstreamOutcome === "unknown" ? " The provider may still have processed the previous request." : ""}`;
  }
  if (job.status === "completed")
    return "Analysis complete. Interpretation is saved.";
  if (job.sam.status === "queued")
    return "Photograph saved. Waiting for segmentation.";
  if (job.sam.status === "running") return "Segmenting the photograph.";
  if (job.muse.status === "queued")
    return "Segmentation saved. Waiting for Muse interpretation.";
  if (job.muse.status === "running")
    return "Segmentation saved. Muse interpretation is running.";
  const stage = job.sam.status === "succeeded" ? "muse" : "sam";
  const attempt = job[stage].attempts.at(-1);
  const name = stage === "muse" ? "Muse interpretation" : "SAM segmentation";
  const state = attempt?.status;
  return `${name} ${state === "timed_out" ? "timed out" : state === "interrupted" ? "was interrupted" : "failed"}.${job.result ? " Segmentation is saved; SAM candidates remain unverified." : " Your photograph is saved."}${attempt?.upstreamOutcome === "unknown" ? " The provider may still have processed the previous request." : ""}`;
}
