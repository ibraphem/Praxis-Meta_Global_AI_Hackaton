import type { Analysis } from "@/lib/vision";
import type { AnalysisJob } from "@/lib/analysis-jobs";
import type { SceneGraph } from "@/lib/scene";
import {
  reconcileSceneView,
  preferredTerminalTargets,
  type DisplayObject,
} from "@/lib/scene-reconciliation";

export type SceneMode = "objects" | "evidence";
export type SceneAction = "reconcile-scene" | "discover-terminals";
export function SceneModeControl({
  mode,
  onChange,
}: {
  mode: SceneMode;
  onChange: (mode: SceneMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Scene display"
      style={{ display: "flex", gap: 8, margin: "12px 0" }}
    >
      <button
        type="button"
        className="button button-secondary"
        aria-pressed={mode === "objects"}
        onClick={() => onChange("objects")}
      >
        Objects
      </button>
      <button
        type="button"
        className="button button-secondary"
        aria-pressed={mode === "evidence"}
        onClick={() => onChange("evidence")}
      >
        Evidence
      </button>
    </div>
  );
}

export function SceneObjectPanel({
  graph,
  result,
  job,
  selectedId,
  onSelect,
  busy,
  onAction,
  mode,
  onModeChange,
}: {
  graph: SceneGraph;
  result: Analysis | null;
  job?: AnalysisJob | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  busy: boolean;
  onAction?: (action: SceneAction, payload: unknown) => void;
  mode: SceneMode;
  onModeChange: (mode: SceneMode) => void;
}) {
  const view = reconcileSceneView(graph, result?.objects ?? []);
  const selected = view.objects.find(
    (o) =>
      o.id === selectedId ||
      o.sceneObjectIds.includes(selectedId ?? "") ||
      o.baselineIds.includes(selectedId ?? ""),
  );
  const selectedIdInGraph =
    selected?.sceneObjectIds.find((id) =>
      graph.objects.some((o) => o.id === id && o.category !== "unknown"),
    ) ?? selected?.sceneObjectIds[0];
  const attempted = new Set([
    ...(job?.scene?.terminalWork?.map((w) => w.objectId) ?? []),
    ...(graph.terminals ?? []).map((t) => t.objectId),
  ]);
  const targets =
    selectedIdInGraph &&
    selected?.sceneObjectIds.includes(selectedId ?? "") &&
    !attempted.has(selectedIdInGraph) &&
    graph.objects.find((o) => o.id === selectedIdInGraph)?.category !== "board"
      ? [selectedIdInGraph]
      : preferredTerminalTargets(graph).filter((id) => !attempted.has(id));
  const binding = job?.scene?.snapshotRef;
  const terminalBudget = job?.scene?.settings?.maxTerminalRequests ?? 2;
  const remaining = terminalBudget - (job?.scene?.budget.terminalRequests ?? 0);
  const targetIds = targets.slice(0, Math.max(0, remaining));
  const selectedTerminals = (graph.terminals ?? []).filter((t) =>
    selected?.sceneObjectIds.includes(t.objectId),
  );
  return (
    <section
      className="scene-inventory-panel"
      aria-label="Reconciled scene objects"
    >
      <h2>Object hypotheses</h2>
      <SceneModeControl mode={mode} onChange={onModeChange} />
      <p>{view.objects.length} display groups · identities remain proposals.</p>
      <p>
        Dashed boxes show approximate Muse locations. Masks are candidate
        segmentation, shown on selection or in Evidence. No boundary is
        confirmed.
      </p>
      <ul className="scene-inventory-list">
        {view.objects.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              onClick={() => onSelect(o.id)}
              aria-pressed={selected?.id === o.id}
              className={
                selected?.id === o.id ? "scene-inventory-selected" : ""
              }
            >
              <strong>{o.name}</strong>
              <span>
                {o.locationKind === "approximate_inventory"
                  ? "Approximate inventory location"
                  : "SAM candidate location"}
              </span>
              <span>
                {o.observationIds.length} source observations ·{" "}
                {o.baselineIds.length
                  ? "baseline evidence linked provisionally"
                  : "identity proposed"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <section aria-label="Selected object evidence">
          <h3>{selected.name}</h3>
          <p>
            Physical identity proposed · electrical connection unestablished.
          </p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => onModeChange("evidence")}
          >
            Inspect source observations
          </button>
          {view.relations
            .filter(
              (r) =>
                selected.sceneObjectIds.includes(r.fromObjectId) ||
                selected.sceneObjectIds.includes(r.toObjectId),
            )
            .map((r) => (
              <p key={r.id}>
                {r.type.replaceAll("_", " ")} · {r.status} ·{" "}
                {r.source === "local"
                  ? "local reconciliation"
                  : "visual model proposal"}
                <br />
                {
                  graph.objects.find((o) => o.id === r.fromObjectId)
                    ?.proposedType
                }{" "}
                →{" "}
                {graph.objects.find((o) => o.id === r.toObjectId)?.proposedType}
              </p>
            ))}
          <h4>Terminals</h4>
          {!selectedTerminals.length && (
            <p>No terminal positions established for this object.</p>
          )}
          {selectedTerminals.map((t) => (
            <div
              key={t.id}
              style={{ margin: "8px 0", padding: 8, background: "#f7f8f7" }}
            >
              <strong>
                Terminal {t.label} · {t.physicalKind}
              </strong>
              <p>
                Location:{" "}
                {t.location
                  ? `${t.location.join(", ")} · model-observed`
                  : "unresolved"}{" "}
                ({t.locationEvidence.replaceAll("_", " ")}).
              </p>
              <p>
                Role: {t.electricalRole ?? "unresolved"} · {t.roleStatus}.{" "}
                {t.roleMarking
                  ? `Reported marking: ${t.roleMarking}`
                  : "No polarity inferred from wire color."}
              </p>
              {(graph.attachments ?? [])
                .filter((a) => a.terminalId === t.id)
                .map((a) => (
                  <p key={a.id}>
                    {
                      graph.objects.find((o) => o.id === a.conductorObjectId)
                        ?.proposedType
                    }
                    : {a.evidence.replaceAll("_", " ")} · {a.status}. Electrical
                    connection unestablished.
                  </p>
                ))}
            </div>
          ))}
        </section>
      )}
      <details>
        <summary>
          Unassigned evidence and alternative hypotheses (
          {view.evidenceOnlyObjectIds.length})
        </summary>
        <p>
          These observations are preserved without counting each fragment as
          another physical component.
        </p>
        {view.evidenceOnlyObjectIds.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              onSelect(id);
              onModeChange("evidence");
            }}
          >
            {graph.objects.find((o) => o.id === id)?.proposedType}
          </button>
        ))}
      </details>
      {binding && onAction && (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() =>
              onAction("reconcile-scene", {
                snapshotId: binding.snapshotId,
                snapshotHash: binding.snapshotHash,
              })
            }
          >
            Record reconciliation
          </button>
          <p>Records proposed object links locally. No model request.</p>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || !targetIds.length}
            onClick={() =>
              onAction("discover-terminals", {
                snapshotId: binding.snapshotId,
                snapshotHash: binding.snapshotHash,
                objectIds: targetIds,
              })
            }
          >
            Discover terminals ({targetIds.length})
          </button>
          <p>
            {targetIds
              .map((id) => graph.objects.find((o) => o.id === id)?.proposedType)
              .join("; ") ||
              "No unattempted target within the terminal budget."}
          </p>
          <p>
            One Muse request per selected object, with scene context and a
            focused crop; zero SAM requests. Locations, roles and attachments
            remain separate proposals.
          </p>
        </div>
      )}
      {!!job?.scene?.terminalWork?.length && (
        <details>
          <summary>Terminal request history</summary>
          {job.scene.terminalWork.map((w) => (
            <p key={w.requestId}>
              {graph.objects.find((o) => o.id === w.objectId)?.proposedType}:{" "}
              {w.status} · provider {w.upstreamOutcome}
              {w.errorCode ? ` · ${w.errorCode}` : ""}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}

function labels(objects: DisplayObject[], graph: SceneGraph) {
  const result = new Map<string, { side: "left" | "right"; top: number }>();
  for (const side of ["left", "right"] as const) {
    const lane = objects
      .filter(
        (o) =>
          ((o.bbox[0] + o.bbox[2] / 2) / graph.image.width < 0.5
            ? "left"
            : "right") === side,
      )
      .sort(
        (a, b) =>
          a.bbox[1] + a.bbox[3] / 2 - (b.bbox[1] + b.bbox[3] / 2) ||
          a.id.localeCompare(b.id),
      );
    const gap = Math.min(0.07, 0.94 / Math.max(1, lane.length));
    const positions = lane.map((o) =>
      Math.max(
        0.02,
        Math.min(0.94, (o.bbox[1] + o.bbox[3] / 2) / graph.image.height),
      ),
    );
    for (let i = 1; i < positions.length; i++)
      positions[i] = Math.max(positions[i]!, positions[i - 1]! + gap);
    if (positions.length)
      positions[positions.length - 1] = Math.min(0.94, positions.at(-1)!);
    for (let i = positions.length - 2; i >= 0; i--)
      positions[i] = Math.min(positions[i]!, positions[i + 1]! - gap);
    lane.forEach((o, i) =>
      result.set(o.id, { side, top: positions[i]! * 100 }),
    );
  }
  return result;
}
export function SceneObjectOverlays({
  graph,
  result,
  selectedId,
  onSelect,
}: {
  graph: SceneGraph;
  result: Analysis | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const view = reconcileSceneView(graph, result?.objects ?? []),
    layout = labels(view.objects, graph);
  const selected = view.objects.find(
    (o) =>
      o.id === selectedId ||
      o.sceneObjectIds.includes(selectedId ?? "") ||
      o.baselineIds.includes(selectedId ?? ""),
  );
  const obs = graph.observations.filter(
    (o) => selected?.observationIds.includes(o.id) && o.mask,
  );
  const masks = [
    ...obs,
    ...(result?.objects ?? []).filter(
      (o) =>
        o.mask && (o.id === selectedId || selected?.baselineIds.includes(o.id)),
    ),
  ];
  return (
    <div
      className="scene-object-overlay"
      aria-label="Physical object hypotheses"
    >
      <svg
        viewBox={`0 0 ${graph.image.width} ${graph.image.height}`}
        preserveAspectRatio="none"
        aria-label="Object locations and selected evidence"
      >
        {view.objects.map((o) => {
          const l = layout.get(o.id)!;
          return (
            <g key={o.id}>
              <rect
                x={o.bbox[0]}
                y={o.bbox[1]}
                width={o.bbox[2]}
                height={o.bbox[3]}
                className={selected?.id === o.id ? "is-selected" : ""}
              >
                <title>
                  {o.locationKind === "approximate_inventory"
                    ? "Approximate Muse location; boundary unconfirmed"
                    : "SAM candidate; boundary unconfirmed"}
                </title>
              </rect>
              <line
                x1={o.bbox[0] + o.bbox[2] / 2}
                y1={o.bbox[1] + o.bbox[3] / 2}
                x2={
                  l.side === "left"
                    ? graph.image.width * 0.18
                    : graph.image.width * 0.82
                }
                y2={(graph.image.height * l.top) / 100}
                className="scene-label-leader"
              />
            </g>
          );
        })}
        {masks.map((o) => (
          <g
            key={o.id}
            transform={`translate(${o.bbox[0]} ${o.bbox[1]}) scale(${o.bbox[2] / o.mask!.width} ${o.bbox[3] / o.mask!.height})`}
          >
            <path d={o.mask!.path} fill="#8b5cf644" fillRule="evenodd">
              <title>
                SAM candidate segmentation; physical boundary unconfirmed
              </title>
            </path>
          </g>
        ))}
        {(graph.terminals ?? [])
          .filter(
            (t) => t.location && selected?.sceneObjectIds.includes(t.objectId),
          )
          .map((t) => (
            <circle
              key={t.id}
              cx={t.location![0]}
              cy={t.location![1]}
              r={Math.max(3, graph.image.width / 150)}
              fill="#e28c1a"
              stroke="white"
            >
              <title>{`Terminal ${t.label}: ${t.locationEvidence}; role ${t.electricalRole ?? "unresolved"}`}</title>
            </circle>
          ))}
      </svg>
      {view.objects.map((o) => {
        const l = layout.get(o.id)!;
        return (
          <button
            key={o.id}
            type="button"
            className={`scene-object-label ${selected?.id === o.id ? "is-selected" : ""}`}
            title={o.name}
            style={{
              top: `${l.top}%`,
              ...(l.side === "left" ? { left: "1%" } : { right: "1%" }),
            }}
            aria-label={`Inspect ${o.name} object hypothesis`}
            aria-pressed={selected?.id === o.id}
            onClick={() => onSelect(o.id)}
          >
            {o.name}
          </button>
        );
      })}
    </div>
  );
}
