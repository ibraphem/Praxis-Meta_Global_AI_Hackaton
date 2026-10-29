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
  })
  .strict();
const stageSchema = z
  .object({
    status: z.union([attemptStatusSchema, z.literal("not_started")]),
    attempts: z.array(attemptSchema).max(20),
  })
  .strict();
export const analysisJobSchema = z
  .object({
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
    sam: stageSchema,
    muse: stageSchema,
    result: analysisSchema.optional(),
  })
  .strict();
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export function jobIsActive(job: AnalysisJob) {
  return [job.sam.status, job.muse.status].some(
    (s) => s === "queued" || s === "running",
  );
}
export function retryStage(job: AnalysisJob): "sam" | "muse" | null {
  if (jobIsActive(job)) return null;
  const stage = job.sam.status === "succeeded" ? "muse" : "sam";
  return job[stage].attempts.at(-1)?.retryPolicy === "manual_only"
    ? stage
    : null;
}
export function jobMessage(job: AnalysisJob) {
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
