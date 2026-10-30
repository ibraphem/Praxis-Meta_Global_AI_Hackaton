import type { Detection } from '../schemas/vision.js';
/** Quarantined observations remain immutable raw evidence, never trusted recovery candidates. */
export function quarantineReason(
  c: Detection,
): 'prompt_mismatch' | 'candidate_capacity' | undefined {
  return c.recoveryPromptMatched === false
    ? 'prompt_mismatch'
    : c.recoveryQuarantineReason;
}
export const recoveryEligible = (c: Detection) =>
  quarantineReason(c) === undefined;
export const eligibleCandidateCount = (candidates: Detection[]) =>
  candidates.filter(recoveryEligible).length;
/** Reserve room for a complete provider response (at most 100 masks), never silently truncate it. */
export function rawEvidenceFull(candidates: Detection[]) {
  return (
    candidates.length >= 200 ||
    candidates.reduce((n, c) => n + (c.encodedMask?.payload.length ?? 0), 0) >=
      8 * 1024 * 1024
  );
}
