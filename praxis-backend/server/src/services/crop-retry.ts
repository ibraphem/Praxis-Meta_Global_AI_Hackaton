import { AppError } from '../lib/errors.js';
import { cropWorkKey } from './crop-attempts.js';
import type { CropAttempt, CropRetry } from '../schemas/wire-recovery.js';
import type { CropWork } from './wire-recovery-plan.js';
/** An explicit retry is one new attempt, never deletion of the original work identity or timeout. */
export function retryCropWork(
  attempts: CropAttempt[],
  retry: CropRetry,
): CropWork {
  const original = attempts.find((a) => a.attemptId === retry.attemptId);
  if (
    !original ||
    !['failed', 'timed_out', 'interrupted'].includes(original.status)
  )
    throw new AppError(
      409,
      'CROP_RETRY_UNAVAILABLE',
      'Retry a failed, timed-out or interrupted crop with its original request metadata.',
    );
  if (original.retryOf)
    throw new AppError(
      409,
      'CROP_RETRY_LIMIT',
      'Each crop work item permits only one explicit retry.',
    );
  const prompts =
    original.spatialPrompts ??
    (original.spatialPrompt ? [original.spatialPrompt] : []);
  const workKeys =
    original.workKeys ??
    (prompts.length
      ? prompts.map((p) => cropWorkKey(original.region, p))
      : [cropWorkKey(original.region)]);
  if (
    attempts.some(
      (a) =>
        a.retryOf === original.attemptId ||
        (a.attemptId !== original.attemptId &&
          a.workKeys?.some((key) => workKeys.includes(key))),
    )
  )
    throw new AppError(
      409,
      'CROP_RETRY_LIMIT',
      'This crop work has already been dispatched again. Its attempt history is preserved.',
    );
  if (
    original.upstreamOutcome === 'unknown' &&
    retry.authorization !== 'accept_unknown_upstream'
  )
    throw new AppError(
      409,
      'UPSTREAM_OUTCOME_UNKNOWN',
      'Acknowledge that another request may duplicate work still running upstream.',
    );
  if (
    attempts.some(
      (a) =>
        a.status === 'running' &&
        a.workKeys?.some((key) => workKeys.includes(key)),
    )
  )
    throw new AppError(
      409,
      'ATTEMPT_ACTIVE',
      'This crop work is already active.',
    );
  const mode = original.mode ?? 'tiles';
  return {
    crop: original.region,
    mode,
    workKeys,
    targets: prompts.map((p, i) => ({
      ...p,
      crop: original.region,
      mode: mode === 'tiles' ? 'short' : mode,
      ...(original.sourceCandidateIds?.[i]
        ? { candidateId: original.sourceCandidateIds[i] }
        : {}),
    })),
  };
}
