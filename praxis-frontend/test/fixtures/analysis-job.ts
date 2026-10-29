import { randomUUID } from "node:crypto";
import { analysisJobSchema } from "../../lib/analysis-jobs";

export function completedJob(result: unknown) {
  const now = Date.now();
  const attempt = () => ({
    attemptId: randomUUID(),
    status: "succeeded",
    upstreamOutcome: "response_received",
    retryPolicy: "not_retryable",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
  });
  return analysisJobSchema.parse({
    analysisId: randomUUID(),
    imageHash: "1".repeat(64),
    image: (result as { image: unknown }).image,
    status: "completed",
    revision: randomUUID(),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 86400000,
    settings: {
      maxDimension: 0,
      minimalPrompt: false,
      mode: "combined",
      samModel: "sam-test",
      museModel: "muse-test",
    },
    sam: { status: "succeeded", attempts: [attempt()] },
    muse: { status: "succeeded", attempts: [attempt()] },
    result,
  });
}
