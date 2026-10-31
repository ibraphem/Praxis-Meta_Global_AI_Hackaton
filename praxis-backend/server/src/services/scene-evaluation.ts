import { z } from 'zod';
import { sceneGraphSchema, type SceneGraph } from '../schemas/scene.js';
import {
  reconcileSceneView,
  type BaselineObject,
} from './scene-reconciliation.js';

const key = z.string().min(1).max(100),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const point = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);
const provenance = z.enum([
  'human_visual',
  'physical_inspection',
  'assistant_visual',
]);
export const sceneTruthSchema = z
  .object({
    version: z.literal('scene-truth-v1'),
    imageHash: hash,
    inventoryComplete: z.boolean(),
    attachmentsComplete: z.boolean(),
    source: provenance,
    terminalTolerancePx: z.number().positive().max(100),
    objects: z
      .array(z.object({ id: key, label: z.string().min(1).max(160) }).strict())
      .min(1)
      .max(200),
    terminals: z
      .array(
        z
          .object({
            id: key,
            objectId: key,
            visible: z.boolean(),
            position: point.nullable(),
            electricalRole: z.string().min(1).max(40).nullable(),
          })
          .strict(),
      )
      .max(200),
    attachments: z
      .array(
        z
          .object({
            terminalId: key,
            conductorObjectId: key,
            visible: z.boolean(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((truth, ctx) => {
    const objects = new Set(truth.objects.map((o) => o.id)),
      terminals = new Set(truth.terminals.map((t) => t.id));
    if (
      objects.size !== truth.objects.length ||
      terminals.size !== truth.terminals.length ||
      truth.terminals.some(
        (t) => !objects.has(t.objectId) || t.visible !== (t.position !== null),
      ) ||
      truth.attachments.some(
        (a) =>
          !terminals.has(a.terminalId) || !objects.has(a.conductorObjectId),
      ) ||
      new Set(
        truth.attachments.map((a) =>
          JSON.stringify([a.terminalId, a.conductorObjectId]),
        ),
      ).size !== truth.attachments.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Ground truth has invalid identities or visibility.',
      });
  });
export const sceneReviewSchema = z
  .object({
    version: z.literal('scene-review-v1'),
    imageHash: hash,
    sceneSnapshotHash: hash,
    source: provenance,
    baselineAnalysisHash: hash.optional(),
    objectAssignments: z
      .array(
        z.object({ predictionId: key, truthObjectId: key.nullable() }).strict(),
      )
      .max(500),
    terminalAssignments: z
      .array(
        z
          .object({ predictionId: z.uuid(), truthTerminalId: key.nullable() })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type SceneTruth = z.infer<typeof sceneTruthSchema>;
export type SceneReview = z.infer<typeof sceneReviewSchema>;
export function scoreScene(input: {
  graph: SceneGraph;
  snapshotHash: string;
  truth: SceneTruth;
  review: SceneReview;
  baseline?: readonly BaselineObject[];
  baselineHash?: string;
  attempts?: {
    sceneOperation?: string;
    startedAt?: number;
    finishedAt?: number;
    status: string;
    diagnostics?: {
      timings: { kind: string; stage: string; durationMs: number }[];
    };
  }[];
}) {
  const truth = sceneTruthSchema.parse(input.truth),
    review = sceneReviewSchema.parse(input.review),
    graph = sceneGraphSchema.parse(input.graph);
  if (
    truth.imageHash !== graph.imageHash ||
    review.imageHash !== graph.imageHash ||
    review.sceneSnapshotHash !== input.snapshotHash
  )
    throw new Error('Scene evaluation evidence binding mismatch.');
  if (
    input.baseline &&
    (!input.baselineHash || review.baselineAnalysisHash !== input.baselineHash)
  )
    throw new Error('Scene baseline analysis binding mismatch.');
  const view = reconcileSceneView(graph, input.baseline ?? []);
  const truthIds = new Set(truth.objects.map((o) => o.id)),
    predIds = new Set([
      ...graph.objects.map((o) => o.id),
      ...(input.baseline ?? []).map((o) => o.id),
    ]);
  const assignments = new Map<string, string | null>();
  for (const a of review.objectAssignments) {
    if (
      assignments.has(a.predictionId) ||
      !predIds.has(a.predictionId) ||
      (a.truthObjectId !== null && !truthIds.has(a.truthObjectId))
    )
      throw new Error('Invalid or duplicate object annotation.');
    assignments.set(a.predictionId, a.truthObjectId);
  }
  const coverage = new Map<string, string[]>(),
    merges: string[] = [],
    unreviewedGroups: string[] = [];
  let falseObjectGroups = 0;
  for (const object of view.objects) {
    const members = [...object.sceneObjectIds, ...object.baselineIds];
    const mapped = new Set(
      members
        .map((id) => assignments.get(id))
        .filter((id): id is string => typeof id === 'string'),
    );
    if (members.some((id) => !assignments.has(id)))
      unreviewedGroups.push(object.id);
    if (
      mapped.size > 1 ||
      (mapped.size && members.some((id) => assignments.get(id) === null))
    ) {
      merges.push(object.id);
      continue;
    }
    if (!mapped.size) {
      if (members.length && members.every((id) => assignments.has(id)))
        falseObjectGroups++;
      continue;
    }
    const id = [...mapped][0]!;
    coverage.set(id, [...(coverage.get(id) ?? []), object.id]);
  }
  const terminalMap = new Map<string, string | null>(),
    truthTerminals = new Map(truth.terminals.map((t) => [t.id, t]));
  const predictedTerminals = new Map(
    (graph.terminals ?? []).map((t) => [t.id, t]),
  );
  for (const a of review.terminalAssignments) {
    if (
      terminalMap.has(a.predictionId) ||
      !predictedTerminals.has(a.predictionId) ||
      (a.truthTerminalId !== null && !truthTerminals.has(a.truthTerminalId))
    )
      throw new Error('Invalid or duplicate terminal annotation.');
    terminalMap.set(a.predictionId, a.truthTerminalId);
  }
  const distances: number[] = [];
  let correctTerminals = 0,
    duplicateTerminals = 0,
    wrongRoles = 0,
    correctRoles = 0;
  for (const terminal of truth.terminals) {
    const predictions = [...predictedTerminals.values()].filter(
      (t) => terminalMap.get(t.id) === terminal.id,
    );
    if (predictions.length > 1) duplicateTerminals += predictions.length - 1;
    if (predictions.length !== 1) continue; // duplicates cannot be cherry-picked for accuracy
    const p = predictions[0]!;
    if (assignments.get(p.objectId) !== terminal.objectId) continue;
    if (terminal.position && p.location) {
      const d = Math.hypot(
        p.location[0] - terminal.position[0],
        p.location[1] - terminal.position[1],
      );
      distances.push(d);
      if (d <= truth.terminalTolerancePx) correctTerminals++;
    }
    if (terminal.electricalRole && p.electricalRole) {
      if (terminal.electricalRole === p.electricalRole) correctRoles++;
      else wrongRoles++;
    }
  }
  let correctAttachments = 0,
    falseAttachments = 0,
    unreviewedAttachments = 0;
  const matchedAttachments = new Set<string>();
  for (const a of graph.attachments ?? []) {
    if (a.status !== 'proposed') continue;
    const terminal = terminalMap.get(a.terminalId),
      conductor = assignments.get(a.conductorObjectId);
    const prediction = predictedTerminals.get(a.terminalId);
    const parent = prediction
      ? assignments.get(prediction.objectId)
      : undefined;
    if (
      terminal === undefined ||
      conductor === undefined ||
      parent === undefined
    ) {
      unreviewedAttachments++;
      continue;
    }
    const match = truth.attachments.find(
      (t) =>
        t.visible &&
        t.terminalId === terminal &&
        t.conductorObjectId === conductor &&
        truthTerminals.get(t.terminalId)?.objectId === parent,
    );
    const key = JSON.stringify([terminal, conductor]);
    if (match && !matchedAttachments.has(key)) {
      correctAttachments++;
      matchedAttachments.add(key);
    } else falseAttachments++;
  }
  const visibleTerminals = truth.terminals.filter((t) => t.visible).length;
  const independent = [truth.source, review.source].every(
    (s) => s === 'human_visual' || s === 'physical_inspection',
  );
  const times = (input.attempts ?? []).map((a) => ({
    operation: a.sceneOperation ?? 'unknown',
    status: a.status,
    wallMs:
      a.startedAt !== undefined && a.finishedAt !== undefined
        ? a.finishedAt - a.startedAt
        : null,
    requests: a.diagnostics
      ? a.diagnostics.timings.filter((t) => t.kind === 'request')
      : null,
  }));
  return {
    version: 'scene-score-v1',
    imageHash: graph.imageHash,
    sceneSnapshotHash: input.snapshotHash,
    baselineAnalysisHash: input.baselineHash ?? null,
    annotationSource: {
      truth: truth.source,
      review: review.source,
      independentlyReviewed: independent,
    },
    objectRecall: coverage.size / truth.objects.length,
    coveredObjects: coverage.size,
    totalTruthObjects: truth.objects.length,
    missingTruthObjects: truth.objects
      .filter((o) => !coverage.has(o.id))
      .map((o) => o.id),
    duplicateObjectIdentities: [...coverage.values()].reduce(
      (n, groups) => n + Math.max(0, groups.length - 1),
      0,
    ),
    incorrectMergedGroups: merges,
    falseObjectGroups,
    unreviewedGroups,
    rawObjectHypotheses: graph.objects.length,
    displayedGroups: view.objects.length,
    evidenceOnlyHypotheses: view.evidenceOnlyObjectIds.length,
    terminals: {
      correctWithinTolerance: correctTerminals,
      visibleTruthTerminals: visibleTerminals,
      accuracy: visibleTerminals ? correctTerminals / visibleTerminals : null,
      unresolvedOrIncorrect: visibleTerminals - correctTerminals,
      duplicatePredictions: duplicateTerminals,
      meanAvailablePixelError: distances.length
        ? distances.reduce((a, b) => a + b, 0) / distances.length
        : null,
      unreviewedPredictions: [...predictedTerminals.keys()].filter(
        (id) => !terminalMap.has(id),
      ).length,
      correctRoleProposals: correctRoles,
      incorrectRoleProposals: wrongRoles,
      knownTruthRoles: truth.terminals.filter((t) => t.electricalRole !== null)
        .length,
      unresolvedRoles:
        truth.terminals.filter((t) => t.electricalRole !== null).length -
        correctRoles -
        wrongRoles,
    },
    attachments: {
      correctVisibleProposals: correctAttachments,
      visibleTruthAttachments: truth.attachments.filter((a) => a.visible)
        .length,
      falseProposals: truth.attachmentsComplete ? falseAttachments : null,
      unreviewedProposals: unreviewedAttachments,
      unresolvedProposals: (graph.attachments ?? []).filter(
        (a) => a.status === 'unresolved',
      ).length,
    },
    measurements: times,
    accuracyClaimsEligible:
      independent &&
      truth.inventoryComplete &&
      truth.attachmentsComplete &&
      !unreviewedGroups.length &&
      !unreviewedAttachments &&
      [...predictedTerminals.keys()].every((id) => terminalMap.has(id)),
    electricalConnectionStatus: 'unestablished',
    note: 'Annotation-relative evaluation; missing and duplicate predictions remain in denominators. Available-coordinate error alone is not terminal accuracy. Inference cost requires billing evidence. No electrical connectivity is verified.',
  };
}
