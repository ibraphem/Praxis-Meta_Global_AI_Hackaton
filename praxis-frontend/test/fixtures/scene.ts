import { randomUUID } from "node:crypto";
import { sceneGraphSchema } from "../../lib/scene";
import { completedJob } from "./analysis-job";

/** Synthetic contract fixture only; not an annotation of the displayed photograph. */
export function sceneJob(width = 100, height = 80) {
  const job = completedJob({
    image: { width, height },
    objects: [],
    provenance: {
      mode: "combined",
      reasoningModel: "muse-test",
      segmentationModel: "sam-test",
    },
  });
  const attemptId = randomUUID(),
    objectId = randomUUID(),
    observationId = randomUUID();
  const graph = sceneGraphSchema.parse({
    version: "scene-v1",
    imageHash: job.imageHash,
    image: job.image,
    promptVersion: "open-inventory-v1",
    electricalConnectionStatus: "unestablished",
    objects: [
      {
        id: objectId,
        proposedType: "9V battery snap connector",
        category: "connector",
        bbox: [10, 20, 20, 20],
        recognitionStatus: "proposed",
        segmentationStatus: "candidates_returned",
        terminalIds: [],
      },
    ],
    observations: [
      {
        id: randomUUID(),
        kind: "bbox",
        source: "muse",
        attemptId,
        model: "muse-test",
        bbox: [10, 20, 20, 20],
      },
      {
        id: observationId,
        kind: "mask",
        source: "sam",
        attemptId,
        model: "sam-test",
        bbox: [10, 20, 20, 20],
        mask: {
          format: "svg_path",
          width: 20,
          height: 20,
          path: "M1 1L18 1L18 18L1 18Z",
        },
        prompt: "9V battery snap connector",
      },
    ],
    associations: [
      {
        id: randomUUID(),
        objectId,
        observationId,
        relation: "unknown",
        basis: "prompt_target",
        status: "proposed",
        attemptId,
      },
    ],
  });
  graph.associations.push({
    id: randomUUID(),
    objectId,
    observationId: graph.observations[0]!.id,
    relation: "unknown",
    basis: "inventory",
    status: "proposed",
    attemptId,
  });
  job.scene = {
    status: "succeeded",
    attempts: [
      {
        attemptId,
        status: "succeeded",
        upstreamOutcome: "response_received",
        retryPolicy: "not_retryable",
        createdAt: job.createdAt,
        sceneOperation: "guided",
      },
    ],
    graph,
    budget: { requests: 1, pixels: 1600 },
    work: [],
  };
  return job;
}
