import { randomUUID } from "node:crypto";
import { groupedSceneJob } from "./scene";
import { reconcileSceneGraph } from "../../lib/scene-reconciliation";
import { analysisJobSchema } from "../../lib/analysis-jobs";

/** Synthetic transport and evaluation evidence; not photographic accuracy annotations. */
export function sceneEvaluationJob(width = 100, height = 80) {
  const job = groupedSceneJob(width, height),
    scene = job.scene!;
  const graph = reconcileSceneGraph(scene.graph!);
  const object = graph.objects[0]!,
    other = graph.objects[1]!;
  const conductor = {
    ...structuredClone(object),
    id: randomUUID(),
    proposedType: "white insulated conductor",
    category: "conductor" as const,
  };
  graph.objects.push(conductor);
  const relation = graph.relations!.find((r) => r.type === "same_object")!;
  const observationId = graph.observations[0]!.id;
  graph.associations.push({
    ...graph.associations[0]!,
    id: randomUUID(),
    objectId: conductor.id,
    observationId,
    basis: "inventory",
  });
  graph.identityReviews = [
    {
      id: randomUUID(),
      relationId: relation.id,
      decision: "same_object",
      source: "human_review",
      inputSnapshotId: scene.snapshotRef!.snapshotId,
      inputSnapshotHash: scene.snapshotRef!.snapshotHash,
      reviewedAt: 1000,
    },
  ];
  const attempt = (
    sceneOperation: "inventory" | "guided" | "reconcile" | "terminals",
  ) => ({
    attemptId: randomUUID(),
    sceneOperation,
    status: "succeeded" as const,
    upstreamOutcome: "response_received" as const,
    retryPolicy: "not_retryable" as const,
    createdAt: 100,
    startedAt: 110,
    finishedAt: 910,
  });
  const inventory = {
    ...attempt("inventory"),
    diagnostics: {
      requestId: randomUUID(),
      elapsedMs: 800,
      timings: [
        {
          stage: "muse.inventory" as const,
          startedAtMs: 0,
          durationMs: 700,
          status: "completed" as const,
          kind: "request" as const,
        },
      ],
    },
  };
  const terminal = {
    ...attempt("terminals"),
    status: "timed_out" as const,
    upstreamOutcome: "unknown" as const,
    errorCode: "PROVIDER_TIMEOUT",
    diagnostics: {
      requestId: randomUUID(),
      elapsedMs: 800,
      timings: [
        {
          stage: "muse.terminals" as const,
          startedAtMs: 4,
          durationMs: 796,
          status: "timed_out" as const,
          kind: "request" as const,
        },
      ],
    },
  };
  scene.attempts = [
    inventory,
    { ...attempt("guided"), status: "failed" },
    { ...attempt("reconcile"), upstreamOutcome: "not_sent" },
    terminal,
  ];
  const terminalId = randomUUID(),
    requestId = randomUUID();
  graph.terminals = [
    {
      id: terminalId,
      objectId: object.id,
      label: "A",
      physicalKind: "unknown",
      location: null,
      locationStatus: "unresolved",
      locationEvidence: "occluded",
      reference: { position: [20, 30], evidence: "insulated_housing_junction" },
      pinLabel: null,
      electricalRole: null,
      roleStatus: "unresolved",
      roleMarking: null,
      observationIds: [observationId],
      attemptId: terminal.attemptId,
      requestId,
      model: "muse-test",
      promptVersion: "physical-terminals-v2",
    },
  ];
  object.terminalIds.push(terminalId);
  graph.attachments = [
    {
      id: randomUUID(),
      terminalId,
      conductorObjectId: conductor.id,
      evidence: "occluded_path",
      position: null,
      status: "unresolved",
      observationIds: [observationId],
      attemptId: terminal.attemptId,
      requestId,
      electricalConnectionStatus: "unestablished",
    },
  ];
  scene.terminalWork = [
    {
      requestId,
      attemptId: terminal.attemptId,
      objectId: other.id,
      inputSnapshotId: scene.snapshotRef!.snapshotId,
      inputSnapshotHash: scene.snapshotRef!.snapshotHash,
      crop: [0, 0, 40, 50],
      status: "timed_out",
      upstreamOutcome: "unknown",
      startedAt: 110,
      finishedAt: 910,
    },
  ];
  scene.graph = graph;
  return analysisJobSchema.parse(job);
}
