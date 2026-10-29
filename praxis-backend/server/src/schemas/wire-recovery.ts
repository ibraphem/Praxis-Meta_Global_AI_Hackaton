import { z } from 'zod';
import { boxSchema, maskSchema } from './geometry.js';
const point = z.tuple([
  z.number().finite().nonnegative(),
  z.number().finite().nonnegative(),
]);
export const recoveryCandidateSchema = z
  .object({
    id: z.string().regex(/^(jumper_wire|cv_trace)_[1-9]\d*$/),
    source: z.enum(['sam_full', 'sam_crop', 'cv_trace']),
    evidenceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    bbox: boxSchema,
    points: z.array(point).max(128),
    mask: maskSchema.optional(),
    color: z.string().max(30).optional(),
    geometryAccepted: z.boolean(),
    rejectionReasons: z.array(z.string().regex(/^[a-z_]+$/)).max(16),
    metrics: z
      .object({
        area: z.number().nonnegative(),
        components: z.number().nonnegative(),
        ends: z.number().nonnegative(),
        branches: z.number().nonnegative(),
        occupancy: z.number().min(0).max(1),
        topologyScale: z.number().min(0).max(1),
      })
      .strict(),
    candidateCoverage: z.number().min(0).max(1),
    verifiedCoverage: z.number().min(0).max(1),
    touchesImageBoundary: z.boolean(),
    identityStatus: z.literal('unverified'),
    guidanceEligible: z.literal(false),
  })
  .strict();
export const wireIdentitySchema = z
  .object({
    reviewId: z.uuid(),
    reportId: z.string().regex(/^[a-f0-9]{64}$/),
    candidateIds: z.array(z.string().max(64)).min(1).max(8),
    state: z.enum(['verified', 'rejected', 'uncertain']),
    note: z.string().max(240),
    reviewSource: z.literal('human'),
    reviewedAt: z.number().int().nonnegative(),
    electricalConnectionStatus: z.literal('unestablished'),
  })
  .strict();
export const wireModelReviewSchema = z
  .object({
    candidateId: z.string().max(64),
    decision: z.enum([
      'one_visible_wire',
      'multiple_wires',
      'fragment_only',
      'not_wire',
      'uncertain',
    ]),
    endpoints: z
      .array(
        z
          .object({
            role: z.enum(['A', 'B']),
            position: point.nullable(),
            evidence: z.enum([
              'visible_insertion',
              'occluded_insertion',
              'off_image',
              'insufficient',
            ]),
          })
          .strict(),
      )
      .length(2),
    elapsedMs: z.number().nonnegative(),
  })
  .strict();
export const cropAttemptSchema = z
  .object({
    attemptId: z.uuid(),
    region: boxSchema,
    status: z.enum([
      'running',
      'succeeded',
      'failed',
      'timed_out',
      'interrupted',
      'legacy_unknown',
    ]),
    upstreamOutcome: z.enum(['not_sent', 'unknown', 'response_received']),
    sourceSnapshotId: z.uuid().optional(),
    sourceSnapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
  })
  .strict();
const reconciliationSchema = z
  .object({
    sourceReviewId: z.uuid(),
    sourceReportId: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCandidateIds: z.array(z.string().max(64)).min(1).max(8),
    candidateIds: z.array(z.string().max(64)).max(8),
    status: z.enum(['carried', 'needs_review']),
    reason: z.enum([
      'unchanged_evidence',
      'changed_evidence',
      'missing_evidence',
      'conflicting_evidence',
    ]),
  })
  .strict();
export const recoveryReportSchema = z
  .object({
    version: z.literal('wire-coverage-v1'),
    reportId: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSnapshotId: z.uuid(),
    sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/),
    image: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    auditScale: z.number().positive().max(1),
    candidates: z.array(recoveryCandidateSchema).max(100),
    summary: z
      .object({
        rawSamCandidates: z.number().int().nonnegative(),
        geometryAccepted: z.number().int().nonnegative(),
        cvTraces: z.number().int().nonnegative(),
        uncoveredTraces: z.number().int().nonnegative(),
        unverifiedTraces: z.number().int().nonnegative(),
        truncated: z.boolean(),
      })
      .strict(),
    cropRegions: z.array(boxSchema).max(9),
    reviewReconciliation: z.array(reconciliationSchema).max(100).optional(),
    stopReason: z.enum([
      'audit_only',
      'no_actionable_regions',
      'round_complete',
      'request_budget',
      'pixel_budget',
      'deadline',
      'provider_timeout',
      'provider_error',
      'candidate_budget',
      'blocked_regions',
    ]),
    modelReviews: z.array(wireModelReviewSchema).max(16),
    hypotheses: z
      .array(
        z
          .object({
            candidateIds: z.tuple([z.string().max(64), z.string().max(64)]),
            kind: z.literal('possible_fragment_continuation'),
            status: z.literal('unverified'),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((r, ctx) => {
    for (const c of r.candidates) {
      if (
        c.bbox[0] + c.bbox[2] > r.image.width ||
        c.bbox[1] + c.bbox[3] > r.image.height ||
        c.points.some(([x, y]) => x >= r.image.width || y >= r.image.height)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Candidate bounds exceed the source image.',
        });
    }
    if (
      new Set(r.candidates.map((c) => c.id)).size !== r.candidates.length ||
      r.candidates.reduce((n, c) => n + (c.mask?.path.length ?? 0), 0) > 120000
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid candidate identities or geometry budget.',
      });
  });
export type RecoveryReport = z.infer<typeof recoveryReportSchema>;
export type RecoveryCandidate = z.infer<typeof recoveryCandidateSchema>;
export type WireIdentity = z.infer<typeof wireIdentitySchema>;
export type WireModelReview = z.infer<typeof wireModelReviewSchema>;
export type CropAttempt = z.infer<typeof cropAttemptSchema>;
export type ReviewReconciliation = z.infer<typeof reconciliationSchema>;

export function latestIdentityReviews(
  reviews: WireIdentity[],
  reportId: string,
): WireIdentity[] {
  const seen = new Set<string>(),
    current: WireIdentity[] = [];
  for (const review of [...reviews].reverse()) {
    if (review.reportId !== reportId) continue;
    if (!review.candidateIds.some((id) => seen.has(id))) current.push(review);
    review.candidateIds.forEach((id) => seen.add(id));
  }
  return current;
}

/** Derived context keeps the original human decision and provenance; it is not a new human review. */
export function effectiveIdentityReviews(
  reviews: WireIdentity[],
  report: RecoveryReport,
): (WireIdentity & { inheritedFromReportId?: string })[] {
  const explicit = latestIdentityReviews(reviews, report.reportId);
  const occupied = new Set(explicit.flatMap((r) => r.candidateIds));
  const carried = (report.reviewReconciliation ?? [])
    .filter((r) => r.status === 'carried')
    .flatMap((link) => {
      const source = reviews.find(
        (r) =>
          r.reviewId === link.sourceReviewId &&
          r.reportId === link.sourceReportId,
      );
      if (
        !source ||
        !link.candidateIds.length ||
        link.candidateIds.some((id) => occupied.has(id))
      )
        return [];
      link.candidateIds.forEach((id) => occupied.add(id));
      return [
        {
          ...source,
          reportId: report.reportId,
          candidateIds: link.candidateIds,
          inheritedFromReportId: source.reportId,
        },
      ];
    });
  return [...explicit, ...carried];
}
