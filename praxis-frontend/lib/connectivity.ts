import { z } from "zod";
import { circuitInputSchema } from "../../praxis-backend/server/src/schemas/connectivity";
import type { ConnectivityView } from "../../praxis-backend/server/src/schemas/connectivity-view";
export type { ConnectivityView };
export type {
  CircuitInput,
  CircuitComponent,
  CircuitTerminal,
  CircuitAssociation,
} from "../../praxis-backend/server/src/schemas/connectivity";
export type { ElectricalGraph } from "../../praxis-backend/server/src/services/connectivity";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const graph = z.object({
  graph: z
    .object({
      schemaVersion: z.literal("praxis-electrical-graph-v1"),
      analysisId: z.uuid(),
      imageHash: hash,
      graphHash: hash,
      nodes: z.array(
        z.object({ id: z.string(), members: z.array(z.string()) }),
      ),
      points: z.array(z.unknown()),
      connections: z.array(z.unknown()),
      terminals: z.array(z.unknown()),
      components: z.array(z.unknown()),
      devices: z.array(z.unknown()),
      unresolved: z.array(z.unknown()),
      provenance: z.array(z.unknown()),
      warnings: z.array(z.string()),
      conductiveCompleteness: z.boolean(),
    })
    .passthrough(),
  inputHash: hash,
  sourceRevision: z.number().int().nonnegative(),
  builtAt: z.number(),
});
const schema = z.object({
  schemaVersion: z.literal("praxis-connectivity-view-v1"),
  analysisId: z.uuid(),
  imageHash: hash,
  source: z
    .object({
      input: circuitInputSchema,
      workspace: z.unknown(),
      sourceSceneHash: hash.nullable(),
    })
    .passthrough()
    .nullable(),
  history: z.array(z.unknown()),
  graph: graph.nullable(),
  graphStale: z.boolean(),
  references: z.array(z.unknown()),
  comparisons: z.array(z.unknown()),
  additionalInferenceRequests: z.literal(0),
  evidenceUrl: z.string(),
});
export function parseConnectivityView(
  raw: unknown,
  analysisId: string,
  imageHash?: string,
): ConnectivityView {
  const v = schema.parse(raw);
  if (
    v.analysisId !== analysisId ||
    v.evidenceUrl !== `/api/analyses/${analysisId}/connectivity-evidence` ||
    (imageHash && v.imageHash !== imageHash) ||
    (v.source &&
      (v.source.input.analysisId !== analysisId ||
        v.source.input.imageHash !== v.imageHash)) ||
    (v.graph &&
      (v.graph.graph.analysisId !== analysisId ||
        v.graph.graph.imageHash !== v.imageHash))
  )
    throw Error(
      "Connectivity evidence does not match this analysis photograph.",
    );
  return v as unknown as ConnectivityView;
}

export function parseConnectivityEvidence(raw: unknown, analysisId: string) {
  const v = parseConnectivityView(raw, analysisId),
    history = z
      .object({ graphHistory: z.array(graph).max(501) })
      .parse(raw).graphHistory;
  for (const record of history)
    if (
      record.graph.analysisId !== analysisId ||
      record.graph.imageHash !== v.imageHash
    )
      throw Error("Historical electrical graph belongs to another photograph.");
  return { ...v, graphHistory: history };
}
