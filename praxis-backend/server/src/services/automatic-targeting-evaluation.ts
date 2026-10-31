import { createHash } from 'node:crypto';
import { z } from 'zod';
import { boxSchema } from '../schemas/geometry.js';
import { visualObservationSchema } from '../schemas/scene.js';
import type { runConnectorExperiment } from '../jobs/scene-connector-experiment.js';
import {
  boundaryProfileSchema,
  evaluateBoundaryMask,
  type BoundaryProfile,
} from './connector-boundary.js';

const nativeSchema = z
  .object({
    observationId: z.uuid(),
    crop: boxSchema,
    samObjectId: z.number().int().nonnegative().optional(),
    encodedMask: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        encoding: z.enum(['one_bit', 'lossless']),
        payload: z.string().min(1).max(2000000),
      })
      .strict(),
  })
  .strict();
const digest = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Evaluate after targeting/inference; frozen profile annotations never enter automatic cue generation. */
export function evaluateAutomaticTargetingReport(
  report: Awaited<ReturnType<typeof runConnectorExperiment>>,
  inputProfile: BoundaryProfile,
) {
  const profile = boundaryProfileSchema.parse(inputProfile);
  const { planHash, ...spec } = report.plan;
  if (
    report.plan.version !== 'connector-automatic-plan-v1' ||
    !report.plan.automaticTargeting ||
    report.plan.profile ||
    digest(spec) !== planHash ||
    profile.imageHash !== report.plan.imageHash ||
    profile.frozenAt > report.startedAt
  )
    throw new Error(
      'Automatic targeting evaluation requires a bound plan and a profile frozen before execution.',
    );
  if (
    report.measurements.length > report.plan.variants.length ||
    new Set(report.measurements.map((m) => m.variant)).size !==
      report.measurements.length
  )
    throw new Error('Invalid automatic targeting measurement identities.');
  return {
    version: 'automatic-targeting-evaluation-v1',
    experimentId: report.experimentId,
    imageHash: profile.imageHash,
    objectId: report.plan.objectId,
    planHash,
    profileHash: digest(profile),
    status: report.status,
    targeting: report.plan.automaticTargeting,
    measurements: report.measurements.map((m) => {
      const variant = report.plan.variants.find((v) => v.name === m.variant);
      if (
        !variant ||
        m.objectId !== report.plan.objectId ||
        m.scope !== 'connector_only'
      )
        throw new Error('Automatic targeting measurement target mismatch.');
      const observations = z
        .array(visualObservationSchema)
        .max(32)
        .parse(m.observations ?? []);
      const masks = z
        .array(nativeSchema)
        .max(32)
        .parse(m.native ?? []);
      if (
        new Set(observations.map((o) => o.id)).size !== observations.length ||
        observations.some(
          (o) =>
            o.source !== 'sam' ||
            o.attemptId !== report.experimentId ||
            o.bbox[0] < variant.crop[0] ||
            o.bbox[1] < variant.crop[1] ||
            o.bbox[0] + o.bbox[2] > variant.crop[0] + variant.crop[2] ||
            o.bbox[1] + o.bbox[3] > variant.crop[1] + variant.crop[3] ||
            (o.kind === 'mask' && !masks.some((n) => n.observationId === o.id)),
        ) ||
        new Set(masks.map((n) => n.observationId)).size !== masks.length ||
        masks.some(
          (n) =>
            !observations.some((o) => o.id === n.observationId) ||
            JSON.stringify(n.crop) !== JSON.stringify(variant.crop),
        )
      )
        throw new Error('Automatic targeting mask binding mismatch.');
      return {
        variant: m.variant,
        status: m.status,
        wallMs: m.finishedAt === null ? null : m.finishedAt - m.startedAt,
        masks: masks.map((n) => ({
          observationId: n.observationId,
          ...evaluateBoundaryMask(
            observations.find((o) => o.id === n.observationId)!,
            {
              observationId: n.observationId,
              crop: n.crop,
              encodedMask: n.encodedMask,
            },
            profile,
          ),
        })),
      };
    }),
    independentGroundTruth: false,
    automaticAcceptance: false,
    note: 'Comparison against frozen assistant annotations, not independent physical accuracy. Point abstention and box-only targeting remain explicit; missing masks are retained as outcomes.',
  };
}
