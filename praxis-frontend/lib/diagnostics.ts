import { z } from "zod";

const stageSchema = z.enum([
  "upload",
  "image.prepare",
  "sam.breadboard",
  "sam.led",
  "sam.resistor",
  "sam.jumper_wire",
  "sam.wire_refine",
  "sam.wire_crop",
  "muse.wire_verify",
  "wire.geometry",
  "wire.grounding",
  "muse.interpret",
  "muse.detect",
  "muse.endpoints",
  "muse.insertion_closeups",
  "muse.admission",
  "muse.prepare",
  "muse.validate",
  "wire.selection",
  "response.validate",
  "proxy.upload",
  "backend.wait",
  "proxy.response",
]);
const milliseconds = z.number().int().nonnegative();
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const timingSchema = z
  .object({
    stage: stageSchema,
    startedAtMs: milliseconds,
    durationMs: milliseconds,
    status: z.enum([
      "running",
      "completed",
      "failed",
      "timed_out",
      "cancelled",
    ]),
    kind: z.enum(["work", "request", "retry_delay"]),
    model: z.string().min(1).max(100).optional(),
    attempt: z.number().int().min(1).max(3).optional(),
    timeoutMs: milliseconds.optional(),
    code: code.optional(),
    upstreamStatus: z.number().int().min(100).max(599).optional(),
    candidateCount: z.number().int().nonnegative().max(100).optional(),
    outputSchemaBytes: z.number().int().nonnegative().optional(),
    payloadBytes: z.number().int().nonnegative().optional(),
    imageCount: z.number().int().nonnegative().max(16).optional(),
    encodedImageBytes: z.number().int().nonnegative().optional(),
    promptChars: z.number().int().nonnegative().optional(),
    outputTokenBudget: z.number().int().nonnegative().nullable().optional(),
    imageDimensions: z
      .array(
        z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    headersMs: milliseconds.optional(),
    providerRequestId: z
      .string()
      .regex(/^[a-zA-Z0-9_.:-]{1,128}$/)
      .optional(),
    timeoutType: z
      .enum(["local_deadline", "upstream_504", "stage_deadline"])
      .optional(),
  })
  .strict();
export const diagnosticsSchema = z
  .object({
    requestId: z.uuid(),
    elapsedMs: milliseconds,
    timings: z.array(timingSchema).max(64),
  })
  .strict();
export const errorDetailsSchema = z
  .object({
    source: z.enum([
      "backend",
      "backend_provider",
      "backend_analysis",
      "meta_api",
      "frontend_proxy",
      "client",
    ]),
    stage: stageSchema.optional(),
    model: z.string().min(1).max(100).optional(),
    phase: z.enum(["awaiting_response", "reading_response"]).optional(),
    attempt: z.number().int().min(1).max(3).optional(),
    timeoutMs: milliseconds.optional(),
    elapsedMs: milliseconds,
    totalElapsedMs: milliseconds.optional(),
    upstreamStatus: z.number().int().min(100).max(599).optional(),
    activeStages: z.array(stageSchema).max(8).optional(),
    timings: z.array(timingSchema).max(64).optional(),
  })
  .strict();
export const failureSchema = z
  .object({
    error: z
      .object({
        code,
        message: z.string().min(1).max(500),
        requestId: z.uuid().optional(),
        details: errorDetailsSchema.optional(),
      })
      .strict(),
  })
  .strict();

// Only known timeout codes and schema-validated metadata cross the upstream boundary.
// Provider messages, stacks, arbitrary properties, and unknown codes are discarded.
export const upstreamTimeoutSchema = z.object({
  error: z.object({
    code: z.enum([
      "PROVIDER_TIMEOUT",
      "META_API_TIMEOUT",
      "ANALYSIS_TIMEOUT",
      "REQUEST_CANCELLED",
    ]),
    details: errorDetailsSchema,
  }),
});

export type ErrorDetails = z.infer<typeof errorDetailsSchema>;
export type Failure = z.infer<typeof failureSchema>["error"];
