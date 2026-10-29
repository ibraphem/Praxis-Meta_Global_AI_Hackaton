import { z } from 'zod';
import type { RecoveryReport } from '../schemas/wire-recovery.js';

const point = z.tuple([
  z.number().finite().nonnegative(),
  z.number().finite().nonnegative(),
]);
const truthEndpoint = z
  .object({
    visibility: z.enum(['visible', 'occluded', 'off_image']),
    holeId: z.string().min(1).max(100).nullable(),
    position: point.nullable(),
  })
  .strict()
  .refine(
    (e) =>
      e.visibility !== 'visible' || (e.holeId !== null && e.position !== null),
    'Visible ground truth requires an independently marked hole and center.',
  );
export const wireTruthSchema = z
  .object({
    version: z.literal('wire-truth-v1'),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/),
    recordedBeforeInference: z.literal(true),
    completeInventory: z.literal(true),
    wires: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            endpoints: z.tuple([truthEndpoint, truthEndpoint]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (t) => new Set(t.wires.map((w) => w.id)).size === t.wires.length,
    'Truth identities must be unique.',
  );
const predictionEndpoint = z
  .object({
    holeId: z.string().min(1).max(100).nullable(),
    position: point.nullable(),
    accepted: z.boolean(),
  })
  .strict()
  .refine(
    (e) => !e.accepted || e.holeId !== null,
    'An accepted endpoint requires a resolved hole.',
  );
export const wireEvaluationSchema = z
  .object({
    version: z.literal('wire-evaluation-v1'),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/),
    reportId: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    groups: z
      .array(
        z
          .object({
            candidateIds: z.array(z.string().max(64)).min(1).max(8),
            truthWireId: z.string().min(1).max(100).nullable(),
            matchKind: z.enum(['whole_wire', 'fragment', 'clutter']),
            identityAccepted: z.boolean(),
            // Ordered to match the independently recorded truth, not model A/B orientation.
            endpoints: z.tuple([predictionEndpoint, predictionEndpoint]),
          })
          .strict()
          .refine(
            (g) => (g.matchKind === 'clutter') === (g.truthWireId === null),
            'Clutter has no physical truth identity; wire/fragment matches require one.',
          ),
      )
      .max(100),
  })
  .strict();
const ratio = (n: number, d: number) => (d ? n / d : null);
/** Offline scoring never infers truth from boxes, colors, SAM scores, or model confidence. */
export function evaluateWires(
  report: RecoveryReport,
  imageHash: string,
  rawTruth: unknown,
  rawEvaluation: unknown,
) {
  const truth = wireTruthSchema.parse(rawTruth),
    evaluation = wireEvaluationSchema.parse(rawEvaluation);
  if (
    report.imageHash !== imageHash ||
    truth.imageHash !== imageHash ||
    evaluation.imageHash !== imageHash ||
    evaluation.reportId !== report.reportId ||
    evaluation.sourceSnapshotHash !== report.sourceSnapshotHash
  )
    throw new Error('Evaluation provenance does not match the frozen report.');
  const ids = evaluation.groups.flatMap((g) => g.candidateIds),
    expected = report.candidates.map((c) => c.id),
    truthIds = new Set(truth.wires.map((w) => w.id));
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== expected.length ||
    expected.some((id) => !ids.includes(id)) ||
    evaluation.groups.some(
      (g) => g.truthWireId !== null && !truthIds.has(g.truthWireId),
    )
  )
    throw new Error(
      'Assign every candidate exactly once, using existing truth identities or null for clutter.',
    );
  let detected = 0,
    identityCorrect = 0,
    correct = 0,
    wrong = 0,
    unresolved = 0,
    complete = 0,
    wrongAccepted = 0,
    unsupportedAccepted = 0,
    acceptedCorrect = 0,
    accepted = 0,
    duplicates = 0;
  const errors: number[] = [];
  for (const wire of truth.wires) {
    const groups = evaluation.groups.filter((g) => g.truthWireId === wire.id);
    if (groups.some((g) => g.matchKind === 'whole_wire')) detected++;
    const verified = groups.filter(
      (g) => g.identityAccepted && g.matchKind === 'whole_wire',
    );
    if (verified.length) identityCorrect++;
    duplicates += Math.max(0, groups.length - 1);
    // Multiple competing identities cannot be cherry-picked for endpoint correctness.
    const group =
      groups.length === 1 && groups[0]!.matchKind === 'whole_wire'
        ? groups[0]
        : undefined;
    let both = true;
    for (let i = 0; i < 2; i++) {
      const target = wire.endpoints[i]!,
        predicted = group?.endpoints[i];
      if (target.visibility !== 'visible') {
        both = false;
        continue;
      }
      if (!predicted?.holeId) {
        unresolved++;
        both = false;
      } else if (predicted.holeId === target.holeId) correct++;
      else {
        wrong++;
        both = false;
      }
      if (predicted?.position && target.position)
        errors.push(
          Math.hypot(
            predicted.position[0] - target.position[0],
            predicted.position[1] - target.position[1],
          ),
        );
    }
    if (both) complete++;
  }
  for (const group of evaluation.groups)
    for (let i = 0; i < 2; i++) {
      const predicted = group.endpoints[i]!;
      if (!predicted.accepted) continue;
      accepted++;
      const target = truth.wires.find((w) => w.id === group.truthWireId)
        ?.endpoints[i];
      const competing =
        evaluation.groups.filter((g) => g.truthWireId === group.truthWireId)
          .length > 1;
      if (
        !group.identityAccepted ||
        group.matchKind !== 'whole_wire' ||
        !target ||
        target.visibility !== 'visible' ||
        competing
      )
        unsupportedAccepted++;
      else if (predicted.holeId !== target.holeId) wrongAccepted++;
      else acceptedCorrect++;
    }
  const visible = truth.wires.reduce(
      (n, w) =>
        n + w.endpoints.filter((e) => e.visibility === 'visible').length,
      0,
    ),
    acceptedIdentities = evaluation.groups.filter(
      (g) => g.identityAccepted,
    ).length;
  const recall = ratio(detected, truth.wires.length),
    precision = ratio(identityCorrect, acceptedIdentities),
    accuracy = ratio(correct, visible);
  return {
    version: 'wire-score-v1',
    imageHash,
    reportId: report.reportId,
    sourceSnapshotHash: report.sourceSnapshotHash,
    metrics: {
      physicalWires: truth.wires.length,
      detectedWires: detected,
      wireDetectionRecall: recall,
      acceptedIdentities,
      correctAcceptedIdentities: identityCorrect,
      wireIdentityPrecision: precision,
      duplicateGroups: duplicates,
      visibleEndpoints: visible,
      correctEndpoints: correct,
      wrongHoleProposals: wrong,
      unresolvedEndpoints: unresolved,
      exactHoleAccuracy: accuracy,
      completeWires: complete,
      completeWireAccuracy: ratio(complete, truth.wires.length),
      acceptedEndpoints: accepted,
      acceptedEndpointPrecision: ratio(acceptedCorrect, accepted),
      wrongAcceptedHoles: wrongAccepted,
      unsupportedAcceptedHoles: unsupportedAccepted,
      coordinateSamples: errors.length,
      meanCoordinateErrorPx: errors.length
        ? errors.reduce((a, b) => a + b, 0) / errors.length
        : null,
      maxCoordinateErrorPx: errors.length ? Math.max(...errors) : null,
    },
    targetsMet:
      recall !== null &&
      recall >= 0.95 &&
      precision !== null &&
      precision > 0.98 &&
      accuracy !== null &&
      accuracy >= 0.95 &&
      wrongAccepted === 0 &&
      unsupportedAccepted === 0,
    note: 'Single-image benchmark only. Hidden/off-image endpoints are excluded from exact-hole accuracy, remain recorded, and cannot be accepted. Pixel errors cover available coordinates only; missing coordinates are reported as unresolved. Hole IDs must include board identity. Use the unchanged resolver to populate predictions; this scorer does not snap points.',
  };
}
