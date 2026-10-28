import type { z } from "zod";
import type { diagnosticsSchema, timingSchema } from "../diagnostics";

export interface EndpointRequestTiming {
  id: string;
  wireCandidateId: string;
  analysisId: string;
  imageId: string;
  startedAtMs: number;
  elapsedMs: number | null;
  status: "running" | "completed" | "failed" | "cancelled" | "discarded";
  server?: {
    elapsedMs: number;
    timings: z.infer<typeof timingSchema>[];
    requestId?: string;
  };
}
export function serverRequestTiming(
  diagnostics: z.infer<typeof diagnosticsSchema>,
): EndpointRequestTiming["server"] {
  return {
    elapsedMs: diagnostics.elapsedMs,
    timings: diagnostics.timings,
    requestId: diagnostics.requestId,
  };
}
export function timingBreakdown(timing: EndpointRequestTiming) {
  const sum = (stage: string) => {
    const spans = timing.server?.timings.filter((item) => item.stage === stage);
    return spans?.length
      ? spans.reduce((total, item) => total + item.durationMs, 0)
      : null;
  };
  const attempts =
    timing.server?.timings.filter(
      (item) => item.stage === "muse.endpoints" && item.kind === "request",
    ).length ?? 0;
  return {
    preparationMs: sum("image.prepare"),
    groundingMs: sum("wire.grounding"),
    museMs: sum("muse.endpoints"),
    attempts,
  };
}
