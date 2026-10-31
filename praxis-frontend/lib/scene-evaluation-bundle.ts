import { analysisJobSchema, type AnalysisJob } from "./analysis-jobs";
import { reconcileSceneView, inventoryObjectIds } from "./scene-reconciliation";
import type { Analysis } from "./vision";
import type { EndpointRequestTiming } from "./wires/request-timing";

const duration = (start?: number, end?: number) =>
  start !== undefined && end !== undefined && end >= start ? end - start : null;

/** A click-time copy of public evidence; never dispatches inference or establishes connectivity. */
export function buildSceneEvaluationEvidence(input: {
  job?: AnalysisJob | null;
  imageHash: string;
  image: { width: number; height: number };
  analysis: Analysis | null;
  analysisRunId: string | null;
  endpointRequests: EndpointRequestTiming[];
  capturedAt: number;
}) {
  const job = input.job ? analysisJobSchema.parse(input.job) : null;
  if (
    job &&
    (job.imageHash !== input.imageHash ||
      job.image.width !== input.image.width ||
      job.image.height !== input.image.height)
  )
    throw new Error(
      "The saved scene evidence does not match this photograph. Reconnect the saved analysis before exporting.",
    );
  const scene = job?.scene;
  const graph = scene?.graph ?? null;
  const view = graph
    ? reconcileSceneView(graph, input.analysis?.objects ?? [])
    : null;
  const inventory = graph ? inventoryObjectIds(graph) : new Set<string>();
  const attempts = scene?.attempts ?? [];
  const stages = job
    ? ([
        ["sam", job.sam],
        ["muse", job.muse],
        ["recovery", job.recovery],
        ["scene", scene],
      ] as const)
    : [];
  return structuredClone({
    schemaVersion: "praxis-scene-evaluation-v1",
    capturedAt: input.capturedAt,
    availability: job ? (scene?.status ?? "not_run") : "not_recorded",
    source: job
      ? {
          analysisId: job.analysisId,
          imageHash: job.imageHash,
          revision: job.revision,
          status: job.status,
          sceneEnabledBy: scene?.enabledBy ?? null,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          displayedAnalysisRunId: input.analysisRunId,
          settings: job.settings,
          sceneSettings: scene?.settings ?? null,
          sceneSnapshot: scene?.snapshotRef ?? null,
          samSnapshot: job.sam.snapshotRef ?? null,
          snapshotIntegrity:
            "recorded_binding_not_recomputed_without_native_checkpoint",
        }
      : null,
    graph,
    inventory: {
      attempts: attempts.filter((a) => a.sceneOperation === "inventory"),
      unclassifiedAttempts: attempts.filter(
        (a) => a.sceneOperation === undefined,
      ),
    },
    segmentation: {
      baseline: job?.sam ?? null,
      publishedCandidates: input.analysis?.objects ?? null,
      observations:
        graph?.observations.filter((o) => o.source === "sam") ?? null,
      associations: graph?.associations ?? null,
      guidedAttempts: attempts.filter((a) => a.sceneOperation === "guided"),
      guidedRequests: scene?.work ?? null,
    },
    reconciliation: {
      attempts: attempts.filter((a) => a.sceneOperation === "reconcile"),
      recordedRelations: graph?.relations ?? (graph ? [] : null),
      decisions: graph?.identityReviews ?? (graph ? [] : null),
      maskIdentityDecisions: graph?.maskIdentityReviews ?? (graph ? [] : null),
      displayProjection: view
        ? {
            algorithmVersion: "object-reconciliation-v1",
            derivedAtExport: true,
            ...view,
          }
        : null,
    },
    terminalDiscovery: {
      scope: "selective",
      attempts: attempts.filter((a) => a.sceneOperation === "terminals"),
      requests: scene?.terminalWork ?? null,
      proposals: graph?.terminals ?? (graph ? [] : null),
      coverage:
        graph?.objects
          .filter((o) => inventory.has(o.id))
          .map((o) => {
            const work = scene?.terminalWork
              ?.filter((w) => w.objectId === o.id)
              .at(-1);
            const terminals = (graph.terminals ?? []).filter(
              (t) => t.objectId === o.id,
            );
            const contact = terminals.some(
              (t) => t.location && t.locationEvidence === "visible_terminal",
            );
            const queued = attempts.some(
              (a) =>
                ["queued", "running"].includes(a.status) &&
                a.terminalObjectIds?.includes(o.id),
            );
            return {
              objectId: o.id,
              status: contact
                ? "visible_contact_proposed"
                : work?.status === "succeeded" || terminals.length
                  ? "examined_but_unresolved"
                  : work
                    ? "request_incomplete"
                    : queued
                      ? "queued"
                      : "not_attempted",
              requestStatus: work?.status ?? null,
            };
          }) ?? null,
    },
    attachmentEvidence: graph?.attachments ?? (graph ? [] : null),
    verificationStatus: {
      physicalBoundaries: "unconfirmed",
      segmentationMasks:
        graph?.associations
          .filter((a) => a.basis === "prompt_target")
          .map((a) => ({
            objectId: a.objectId,
            observationId: a.observationId,
            review:
              graph.maskIdentityReviews
                ?.filter(
                  (r) =>
                    r.objectId === a.objectId &&
                    r.observationId === a.observationId,
                )
                .at(-1) ?? null,
          })) ?? null,
      objectRecognition:
        graph?.objects.map((o) => ({
          objectId: o.id,
          status: o.recognitionStatus,
        })) ?? null,
      objectIdentity:
        view?.objects.map((o) => ({
          displayObjectId: o.id,
          memberObjectIds: o.sceneObjectIds,
          status:
            o.grouping === "confirmed"
              ? "human_confirmed_same_object"
              : o.grouping === "proposed"
                ? "grouped_by_proposal"
                : "unverified",
        })) ?? null,
      terminals:
        graph?.terminals?.map((t) => ({
          terminalId: t.id,
          locationStatus: t.locationStatus,
          locationEvidence: t.locationEvidence,
          roleStatus: t.roleStatus,
          verification: "unverified",
        })) ?? (graph ? [] : null),
      attachments:
        graph?.attachments?.map((a) => ({
          attachmentId: a.id,
          status: a.status,
          evidence: a.evidence,
          electricalConnectionStatus: a.electricalConnectionStatus,
          verification: "unverified",
        })) ?? (graph ? [] : null),
      wireIdentityReviews: job?.wireIdentities ?? null,
      electricalConnectionStatus: "unestablished",
    },
    requestBudgets: scene?.budget ?? null,
    latency: {
      stages: stages.map(([stage, state]) => ({
        stage,
        status: state?.status ?? "not_recorded",
        attempts: (state?.attempts ?? []).map((a) => ({
          ...a,
          queueMs: duration(a.createdAt, a.startedAt),
          wallMs: duration(a.startedAt, a.finishedAt),
          diagnosticsElapsedMs: a.diagnostics?.elapsedMs ?? null,
          timings: a.diagnostics?.timings ?? null,
        })),
      })),
      guidedRequests:
        scene?.work.map((w) => ({
          ...w,
          wallMs: duration(w.startedAt, w.finishedAt),
        })) ?? null,
      terminalRequests:
        scene?.terminalWork?.map((w) => ({
          ...w,
          wallMs: duration(w.startedAt, w.finishedAt),
        })) ?? null,
      endpointRequests: input.endpointRequests,
      note: "Attempt timestamps are server Unix milliseconds; diagnostic startedAtMs is relative to its request trace. Browser endpoint clocks are separate. Spans may overlap: do not sum them into wall latency. Null means unrecorded or unfinished, never zero. Running spans are partial observations as last saved.",
    },
    note: "Full public scene evidence at export time, including incomplete and failed work. Graph and review claims are preserved independently from the derived display projection. Historical checkpoints, native masks and original photo bytes require the offline evidence archive. No prediction or identity confirmation establishes electrical connectivity.",
  });
}
