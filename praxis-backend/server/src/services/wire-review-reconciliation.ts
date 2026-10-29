import type {
  RecoveryCandidate,
  RecoveryReport,
  WireIdentity,
  ReviewReconciliation,
} from '../schemas/wire-recovery.js';
import {
  effectiveIdentityReviews,
  latestIdentityReviews,
} from '../schemas/wire-recovery.js';
const overlaps = (a: RecoveryCandidate, b: RecoveryCandidate) =>
  a.bbox[0] < b.bbox[0] + b.bbox[2] &&
  b.bbox[0] < a.bbox[0] + a.bbox[2] &&
  a.bbox[1] < b.bbox[1] + b.bbox[3] &&
  b.bbox[1] < a.bbox[1] + a.bbox[3];
/** Only exact, unique evidence matches can inherit context. New overlapping evidence requires human re-review. */
export function reconcileWireReviews(
  previous: RecoveryReport,
  next: RecoveryReport,
  reviews: WireIdentity[],
): ReviewReconciliation[] {
  if (previous.reportId === next.reportId)
    return previous.reviewReconciliation ?? [];
  const priorHashes = new Set(
    previous.candidates.flatMap((c) =>
      c.evidenceHash ? [c.evidenceHash] : [],
    ),
  );
  const changes = next.candidates.filter(
    (c) => !c.evidenceHash || !priorHashes.has(c.evidenceHash),
  );
  const links = effectiveIdentityReviews(reviews, previous).map((review) => {
    const source = reviews.find((r) => r.reviewId === review.reviewId)!;
    const before = review.candidateIds.map((id) =>
      previous.candidates.find((c) => c.id === id),
    );
    const matches = before.map((c) =>
      c?.evidenceHash
        ? next.candidates.filter((n) => n.evidenceHash === c.evidenceHash)
        : [],
    );
    const matched = matches.flatMap((m) => (m.length === 1 ? m : [])),
      candidateIds = [
        ...new Set(
          matches.flatMap((m, i) =>
            m.length === 1
              ? [m[0]!.id]
              : next.candidates.some((n) => n.id === before[i]?.id)
                ? [before[i]!.id]
                : [],
          ),
        ),
      ];
    let reason: ReviewReconciliation['reason'] = 'unchanged_evidence';
    if (
      previous.imageHash !== next.imageHash ||
      previous.version !== next.version ||
      before.some((c) => !c?.evidenceHash)
    )
      reason = 'changed_evidence';
    else if (
      matches.some((m) => m.length > 1) ||
      before.some(
        (c) =>
          previous.candidates.filter((p) => p.evidenceHash === c!.evidenceHash)
            .length !== 1,
      )
    )
      reason = 'conflicting_evidence';
    else if (matches.some((m) => !m.length))
      reason = before.some(
        (c, i) =>
          !matches[i]!.length && next.candidates.some((n) => n.id === c!.id),
      )
        ? 'changed_evidence'
        : 'missing_evidence';
    else if (changes.some((c) => matched.some((m) => overlaps(c, m))))
      reason = 'conflicting_evidence';
    return {
      sourceReviewId: source.reviewId,
      sourceReportId: source.reportId,
      sourceCandidateIds: source.candidateIds,
      candidateIds,
      status:
        reason === 'unchanged_evidence'
          ? ('carried' as const)
          : ('needs_review' as const),
      reason,
    };
  });
  // An unresolved reconciliation never silently disappears or becomes verified at a later crop.
  const explicit = latestIdentityReviews(reviews, previous.reportId);
  for (const pending of previous.reviewReconciliation ?? [])
    if (
      pending.status === 'needs_review' &&
      !links.some((l) => l.sourceReviewId === pending.sourceReviewId) &&
      !explicit.some((r) =>
        r.candidateIds.some((id) => pending.candidateIds.includes(id)),
      )
    )
      links.push({
        ...pending,
        candidateIds: pending.candidateIds.filter((id) =>
          next.candidates.some((c) => c.id === id),
        ),
      });
  return links.slice(0, 100);
}
