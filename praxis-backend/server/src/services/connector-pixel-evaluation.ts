import { z } from 'zod';
import { decodeMaskToRaster } from '@meta-sam/parser';
import { boxSchema } from '../schemas/geometry.js';
import { visualObservationSchema } from '../schemas/scene.js';
import { canonicalHash } from '../lib/canonical-json.js';
import type { ConnectorEvaluation } from '../schemas/connector-workflow.js';
import type { runConnectorExperiment } from '../jobs/scene-connector-experiment.js';
const encoded = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    encoding: z.enum(['one_bit', 'lossless']),
    payload: z.string().min(1).max(2000000),
  })
  .strict();
const region = z.object({ bbox: boxSchema, mask: encoded }).strict();
export const connectorReferenceSchema = z
  .object({
    version: z.literal('connector-pixel-reference-v1'),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/),
    objectId: z.uuid(),
    image: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    source: z.enum(['human_review', 'assistant_visual', 'synthetic_fixture']),
    independent: z.boolean(),
    reviewId: z.uuid(),
    reviewedAt: z.number().int().nonnegative(),
    frozenAt: z.number().int().nonnegative(),
    connector: region,
    conductors: region,
    validRegion: region.optional(),
    uncertainPixels: z.enum(['none', 'excluded_by_valid_region']),
  })
  .strict()
  .superRefine((r, c) => {
    if (
      r.reviewedAt > r.frozenAt ||
      (r.independent && r.source !== 'human_review') ||
      (r.uncertainPixels === 'excluded_by_valid_region' && !r.validRegion)
    )
      c.addIssue({
        code: 'custom',
        message: 'Reference provenance or uncertain-pixel policy is invalid.',
      });
  });
export const connectorIdentityReviewSchema = z
  .object({
    observationId: z.uuid(),
    decision: z.enum(['correct', 'incorrect', 'uncertain']),
    source: z.enum(['human_review', 'synthetic_fixture']),
    reviewedAt: z.number().int().nonnegative(),
  })
  .strict();
export type ConnectorReference = z.infer<typeof connectorReferenceSchema>;
export type ConnectorIdentityReview = z.infer<
  typeof connectorIdentityReviewSchema
>;
export const connectorThresholds = Object.freeze({
  version: 'connector-release-gate-v1',
  minimumIoU: 0.8,
  minimumRecall: 0.9,
  maximumConductorLeakage: 0.05,
  requiredAcceptedIdentityCorrectness: 1,
  maximumIncorrectConfirmedMerges: 0,
  maximumBudgetOverage: 0,
  maximumMissingProvenance: 0,
});
function canvas(r: z.infer<typeof region>, width: number, height: number) {
  const [x, y, w, h] = r.bbox;
  if (
    w !== r.mask.width ||
    h !== r.mask.height ||
    x + w > width ||
    y + h > height ||
    w * h > 2000000
  )
    throw new Error(
      'Reference/native mask dimensions or coordinates are invalid.',
    );
  const raster = decodeMaskToRaster(r.mask),
    out = new Uint8Array(width * height);
  if (raster.length !== w * h) throw new Error('Invalid native raster length.');
  for (let row = 0; row < h; row++)
    for (let col = 0; col < w; col++)
      out[(y + row) * width + x + col] = raster[row * w + col] ? 1 : 0;
  return out;
}
export function validateConnectorReference(input: ConnectorReference) {
  const r = connectorReferenceSchema.parse(input),
    { width, height } = r.image;
  if (width * height > 4000000)
    throw new Error('Reference exceeds the evaluation pixel quota.');
  const g = canvas(r.connector, width, height),
    w = canvas(r.conductors, width, height),
    valid = r.validRegion ? canvas(r.validRegion, width, height) : null;
  let area = 0;
  for (let i = 0; i < g.length; i++)
    if (!valid || valid[i]) {
      if (g[i] && w[i])
        throw new Error(
          'Connector and conductor references overlap inside the evaluation region.',
        );
      area += g[i]!;
    }
  if (!area)
    throw new Error(
      'Reference has no connector foreground in the valid evaluation region.',
    );
  return r;
}
export function evaluateConnectorPixels(input: {
  report: Awaited<ReturnType<typeof runConnectorExperiment>>;
  reference?: ConnectorReference;
  registeredReferenceHash: string | null;
  reviews?: ConnectorIdentityReview[];
}): ConnectorEvaluation {
  const { report } = input;
  const reviews = z
    .array(connectorIdentityReviewSchema)
    .max(96)
    .parse(input.reviews ?? []);
  if (new Set(reviews.map((r) => r.observationId)).size !== reviews.length)
    throw new Error('Duplicate mask identity reviews.');
  const reference = input.reference
    ? connectorReferenceSchema.parse(input.reference)
    : undefined;
  const usable =
    reference &&
    input.registeredReferenceHash === canonicalHash(reference) &&
    reference.frozenAt <= report.startedAt &&
    reference.imageHash === report.plan.imageHash &&
    reference.objectId === report.plan.objectId &&
    ((reference.source === 'human_review' && reference.independent) ||
      reference.source === 'synthetic_fixture');
  if (
    reference &&
    (reference.imageHash !== report.plan.imageHash ||
      reference.objectId !== report.plan.objectId)
  )
    throw new Error('Reference target/image mismatch.');
  const width = reference?.image.width ?? 1,
    height = reference?.image.height ?? 1;
  if (width * height > 4000000)
    throw new Error('Evaluation image exceeds the four-million-pixel quota.');
  const g = usable ? canvas(reference.connector, width, height) : null;
  const w = usable ? canvas(reference.conductors, width, height) : null;
  const valid =
    usable && reference.validRegion
      ? canvas(reference.validRegion, width, height)
      : null;
  let groundArea = 0;
  if (g && w)
    for (let i = 0; i < g.length; i++)
      if (!valid || valid[i]) {
        if (g[i] && w[i])
          throw new Error(
            'Connector and conductor references overlap inside the evaluation region.',
          );
        groundArea += g[i]!;
      }
  if (usable && !groundArea)
    throw new Error('Connector reference must contain evaluated foreground.');
  const observationsSeen = new Set<string>();
  const nonemptyMasks = new Set<string>();
  const arms = ['A-auto-inventory-box', 'B-auto-baseline-interior'];
  const results = arms.map((variant) => {
    const specification = report.plan.variants.find((v) => v.name === variant);
    const matches = report.measurements.filter((m) => m.variant === variant);
    if (matches.length > 1) throw new Error('Duplicate request measurement.');
    const m = matches[0];
    if (!specification || !m)
      return {
        variant,
        outcome: specification ? 'not_run' : 'abstained',
        acceptedMaskCount: 0,
        maskMetrics: [],
      };
    if (m.objectId !== report.plan.objectId)
      throw new Error('Mask measurement target mismatch.');
    const observations = z
      .array(visualObservationSchema)
      .max(32)
      .parse(m.observations ?? []);
    const masks = z
      .array(
        z
          .object({
            observationId: z.uuid(),
            crop: boxSchema,
            encodedMask: encoded,
            samObjectId: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .max(32)
      .parse(m.native ?? []);
    if (
      new Set(masks.map((n) => n.observationId)).size !== masks.length ||
      observations.some(
        (o) =>
          o.kind === 'mask' && !masks.some((n) => n.observationId === o.id),
      )
    )
      throw new Error('Missing or duplicated native mask evidence.');
    const metrics = masks.map((n) => {
      const o = observations.find((o) => o.id === n.observationId);
      if (
        !o ||
        n.encodedMask.width !== o.bbox[2] ||
        n.encodedMask.height !== o.bbox[3] ||
        n.encodedMask.width * n.encodedMask.height > 2000000 ||
        observationsSeen.has(o.id) ||
        o.source !== 'sam' ||
        o.attemptId !== report.experimentId ||
        canonicalHash(n.crop) !== canonicalHash(specification.crop) ||
        o.bbox[0] < n.crop[0] ||
        o.bbox[1] < n.crop[1] ||
        o.bbox[0] + o.bbox[2] > n.crop[0] + n.crop[2] ||
        o.bbox[1] + o.bbox[3] > n.crop[1] + n.crop[3]
      )
        throw new Error('Native mask/request provenance mismatch.');
      const nativeRaster = decodeMaskToRaster(n.encodedMask);
      if (nativeRaster.length !== n.encodedMask.width * n.encodedMask.height)
        throw new Error('Invalid native mask raster.');
      observationsSeen.add(o.id);
      if (nativeRaster.some(Boolean)) nonemptyMasks.add(o.id);
      const review = reviews.find((r) => r.observationId === o.id);
      if (
        review &&
        (review.reviewedAt < (m.finishedAt ?? report.startedAt) ||
          (review.source === 'synthetic_fixture' &&
            reference?.source !== 'synthetic_fixture'))
      )
        throw new Error('Invalid identity review provenance.');
      let intersection = 0,
        predicted = 0,
        leaked = 0;
      if (usable && g && w) {
        const p = canvas({ bbox: o.bbox, mask: n.encodedMask }, width, height);
        for (let i = 0; i < p.length; i++)
          if (!valid || valid[i]) {
            predicted += p[i]!;
            intersection += p[i] && g[i] ? 1 : 0;
            leaked += p[i] && w[i] ? 1 : 0;
          }
      }
      return {
        observationId: o.id,
        iou: usable
          ? intersection / (groundArea + predicted - intersection)
          : null,
        recall: usable ? intersection / groundArea : null,
        precision: usable && predicted ? intersection / predicted : null,
        leakage: usable && predicted ? leaked / predicted : null,
        identityCorrectness: review?.decision ?? ('unreviewed' as const),
      };
    });
    // Empty predictions retain zero recall/IoU when a reference exists; undefined ratios stay null.
    if (usable && masks.length === 0 && m.status === 'empty_output')
      return {
        variant,
        outcome: 'empty_output',
        acceptedMaskCount: 0,
        maskMetrics: [],
        emptyPrediction: {
          iou: 0 as const,
          recall: 0 as const,
          precision: null,
          leakage: null,
        },
      };
    return {
      variant,
      outcome: m.status,
      maskMetrics: metrics,
      acceptedMaskCount: metrics.filter(
        (p) =>
          p.identityCorrectness === 'correct' &&
          p.iou !== null &&
          p.iou >= connectorThresholds.minimumIoU &&
          p.recall !== null &&
          p.recall >= connectorThresholds.minimumRecall &&
          p.leakage !== null &&
          p.leakage <= connectorThresholds.maximumConductorLeakage,
      ).length,
    };
  });
  if (reviews.some((r) => !observationsSeen.has(r.observationId)))
    throw new Error('Identity review references foreign mask evidence.');
  const validMaskArms = results.filter((r) =>
    r.maskMetrics.some((m) => nonemptyMasks.has(m.observationId)),
  ).length;
  const complete = results.every((r) =>
    ['candidates_returned', 'empty_output'].includes(r.outcome),
  );
  const passed = results.filter((r) => r.acceptedMaskCount === 1).length;
  const budgetValid =
    report.chargedRequests <= 3 && report.chargedPixels <= 6000000;
  const identityPending = results.some((r) =>
    r.maskMetrics.some(
      (m) =>
        m.identityCorrectness === 'unreviewed' ||
        m.identityCorrectness === 'uncertain',
    ),
  );
  const status = !usable
    ? 'unavailable'
    : !complete || identityPending
      ? 'incomplete'
      : passed === 2 && budgetValid
        ? reference.source === 'synthetic_fixture'
          ? 'synthetic_pass'
          : 'passed'
        : 'failed';
  return {
    status,
    referenceHash: input.registeredReferenceHash,
    independentGroundTruth:
      !!usable && reference.source === 'human_review' && reference.independent,
    plannedStrategyCount: 2,
    validMaskArms,
    abComparison: complete ? 'complete' : 'incomplete',
    successRate: usable ? passed / 2 : null,
    armResults: results.map(
      ({ variant, outcome, acceptedMaskCount, maskMetrics, ...rest }) => ({
        variant,
        outcome,
        acceptedMaskCount,
        maskMetrics,
        ...rest,
      }),
    ),
    note: 'IoU=intersection/union; recall=intersection/reference; precision=intersection/prediction; leakage=conductor intersection/prediction. Zero predictions have recall/IoU 0 and undefined precision/leakage. Abstentions, empty responses and failures remain in the two-strategy success denominator. Assistant points/boxes never supply pixel truth; synthetic passes are not photographic readiness.',
  };
}
