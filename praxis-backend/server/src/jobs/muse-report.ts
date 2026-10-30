import { runtimeSchema } from '../schemas/runtime.js';
import { z } from 'zod';

export const variantRunSchema = z
  .object({
    variant: z.string().min(1).max(64),
    status: z.enum([
      'unattempted',
      'running',
      'completed',
      'failed',
      'timed_out',
      'interrupted',
    ]),
    elapsedMs: z.number().nonnegative(),
    plannedCandidateIds: z.array(z.string().min(1).max(64)).max(4),
    attemptedCandidateIds: z.array(z.string().min(1).max(64)).max(4),
  })
  .strict();
export type VariantRun = z.infer<typeof variantRunSchema>;
export function comparisonProgress(
  status: 'running' | 'completed' | 'interrupted',
  runs: Pick<
    VariantRun,
    'variant' | 'status' | 'plannedCandidateIds' | 'attemptedCandidateIds'
  >[],
) {
  const plannedVariants = runs.map((r) => r.variant);
  const attemptedVariants = runs
    .filter((r) => r.status !== 'unattempted')
    .map((r) => r.variant);
  const unattemptedVariants = runs
    .filter((r) => r.status === 'unattempted')
    .map((r) => r.variant);
  return {
    plannedVariants,
    attemptedVariants,
    unattemptedVariants,
    comparisonComplete:
      status === 'completed' &&
      !!runs.length &&
      runs.every(
        (r) =>
          (r.status === 'completed' || r.status === 'failed') &&
          r.plannedCandidateIds.every((id) =>
            r.attemptedCandidateIds.includes(id),
          ),
      ),
    unattemptedCandidates: runs.flatMap((r) =>
      r.plannedCandidateIds
        .filter((id) => !r.attemptedCandidateIds.includes(id))
        .map((candidateId) => ({ variant: r.variant, candidateId })),
    ),
  };
}

/** Read old artifacts without rewriting them or inventing a total elapsed duration. */
export function summarizeMuseExperiment(raw: unknown) {
  const report = z
    .object({
      schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      status: z.enum(['running', 'completed', 'interrupted']),
      experimentId: z.uuid().optional(),
      analysisId: z.uuid().optional(),
      imageHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      snapshotRef: z
        .object({
          samSnapshotId: z.uuid(),
          samSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .optional(),
      model: z.string().min(1).max(100).optional(),
      runtime: runtimeSchema.optional(),
      variantBudgetMs: z.number().int().positive().optional(),
      phaseBudgetMs: z.number().int().positive().optional(),
      stageDeadlineMs: z.number().int().positive().optional(),
      experimentElapsedMs: z.number().nonnegative().optional(),
      variants: z
        .array(z.object({ name: z.string().min(1).max(64) }))
        .min(1)
        .max(4),
      measurements: z.array(
        z.object({
          variant: z.string().min(1).max(64),
          elapsedMs: z.number().nonnegative().optional(),
          status: z.enum(['succeeded', 'timed_out', 'failed', 'skipped']),
          candidateId: z.string().max(64).optional(),
          upstreamOutcome: z.enum(['not_sent', 'response_received', 'unknown']),
        }),
      ),
      focusedPlan: z
        .array(z.object({ candidateId: z.string().max(64) }))
        .optional(),
      phaseTimings: z
        .array(
          z.object({
            variant: z.string(),
            elapsedMs: z.number().nonnegative(),
          }),
        )
        .optional(),
      variantTimings: z
        .array(
          z.object({
            variant: z.string(),
            elapsedMs: z.number().nonnegative(),
          }),
        )
        .optional(),
      variantRuns: z.array(variantRunSchema).max(4).optional(),
    })
    .parse(raw);
  const names = report.variants.map((v) => v.name);
  if (
    new Set(names).size !== names.length ||
    report.measurements.some((m) => !names.includes(m.variant))
  )
    throw new Error(
      'Experiment variants must be distinct and measurements must belong to the plan.',
    );
  const budget =
    report.variantBudgetMs ??
    report.phaseBudgetMs ??
    (report.schemaVersion === 1 ? (report.stageDeadlineMs ?? null) : null);
  if (
    report.variantBudgetMs !== undefined &&
    report.phaseBudgetMs !== undefined &&
    report.variantBudgetMs !== report.phaseBudgetMs
  )
    throw new Error('Conflicting variant and legacy phase budgets.');
  if (
    report.schemaVersion === 3 &&
    (!report.variantRuns ||
      report.variantBudgetMs === undefined ||
      report.experimentElapsedMs === undefined)
  )
    throw new Error(
      'Version 3 reports require recorded variant runs, budget and total elapsed time.',
    );
  const timings = report.variantTimings ?? report.phaseTimings ?? [];
  const runs: (Omit<VariantRun, 'elapsedMs'> & { elapsedMs: number | null })[] =
    report.variantRuns ??
    names.map((variant) => {
      const rows = report.measurements.filter((m) => m.variant === variant);
      const timing = timings.find((t) => t.variant === variant);
      const plannedCandidateIds =
        variant === 'focused-candidates'
          ? (report.focusedPlan ?? []).map((c) => c.candidateId)
          : [];
      const interrupted = rows.some((m) => m.upstreamOutcome === 'unknown');
      return {
        variant,
        status:
          !rows.length && !timing
            ? 'unattempted'
            : interrupted
              ? rows.some((m) => m.status === 'timed_out')
                ? 'timed_out'
                : 'interrupted'
              : rows.some((m) => m.status === 'failed')
                ? 'failed'
                : !rows.length || rows.length < plannedCandidateIds.length
                  ? report.status === 'running'
                    ? 'running'
                    : 'interrupted'
                  : report.status === 'running' && !timing
                    ? 'running'
                    : 'completed',
        elapsedMs:
          timing?.elapsedMs ??
          (variant !== 'focused-candidates' && rows.length === 1
            ? (rows[0]!.elapsedMs ?? null)
            : null),
        plannedCandidateIds,
        attemptedCandidateIds: rows.flatMap((m) =>
          m.candidateId ? [m.candidateId] : [],
        ),
      };
    });
  if (
    runs.length !== names.length ||
    runs.some(
      (r, i) =>
        r.variant !== names[i] ||
        new Set(r.plannedCandidateIds).size !== r.plannedCandidateIds.length ||
        new Set(r.attemptedCandidateIds).size !==
          r.attemptedCandidateIds.length ||
        r.attemptedCandidateIds.some(
          (id) => !r.plannedCandidateIds.includes(id),
        ),
    )
  )
    throw new Error('Variant execution records do not match the frozen plan.');
  if (
    runs.some(
      (r) =>
        (r.status === 'unattempted' &&
          (r.attemptedCandidateIds.length ||
            report.measurements.some((m) => m.variant === r.variant))) ||
        ((r.status === 'completed' || r.status === 'failed') &&
          !report.measurements.some((m) => m.variant === r.variant)),
    )
  )
    throw new Error(
      'Terminal variant records require measurements; unattempted variants cannot contain results.',
    );
  return {
    sourceSchemaVersion: report.schemaVersion,
    provenance: {
      experimentId: report.experimentId ?? null,
      analysisId: report.analysisId ?? null,
      imageHash: report.imageHash ?? null,
      snapshotId: report.snapshotRef?.samSnapshotId ?? null,
      snapshotHash: report.snapshotRef?.samSnapshotHash ?? null,
      model: report.model ?? null,
      runtime: report.runtime ?? null,
    },
    assessmentBasis: report.variantRuns
      ? 'recorded_execution'
      : 'inferred_from_legacy_artifact',
    budgetScope: 'per_variant',
    variantBudgetMs: budget,
    experimentElapsedMs: report.experimentElapsedMs ?? null,
    status: report.status,
    ...comparisonProgress(report.status, runs),
    variantRuns: runs,
    observedFailures: report.measurements.filter(
      (m) => m.status === 'timed_out' || m.status === 'failed',
    ),
    note: 'Comparison completeness concerns execution of the plan, not success or physical accuracy. Unattempted work is not a model failure. Legacy total elapsed time is unknown, not the sum of variant durations. Separate experiments do not prove prior upstream work stopped.',
  };
}
