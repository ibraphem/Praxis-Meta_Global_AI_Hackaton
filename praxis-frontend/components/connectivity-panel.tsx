"use client";
import { useEffect, useState } from "react";
import type { AnalysisJob } from "@/lib/analysis-jobs";
import {
  parseConnectivityView,
  parseConnectivityEvidence,
  type ConnectivityView,
  type ElectricalGraph,
} from "@/lib/connectivity";
import type { CalibratedBoard, WireAssignment } from "@/lib/wires/assignments";
import type { WireEndpointReview } from "@/lib/wires/proposals";
import type { HoleSelection } from "@/lib/breadboard/calibration";
export interface CircuitWorkspace {
  boards: CalibratedBoard[];
  assignments: WireAssignment[];
  reviews: WireEndpointReview[];
  analysisRunId: string | null;
  photoId: string;
}
export interface CircuitHighlight {
  pointIds: string[];
  componentIds: string[];
  connectionIds: string[];
  unresolved?: boolean;
}
export function ConnectivityPanel({
  job,
  workspace,
  selectedHole,
  onRestore,
  onView,
  onHighlight,
  busy,
}: {
  job: AnalysisJob;
  workspace: CircuitWorkspace;
  selectedHole: HoleSelection | null;
  onRestore: (w: CircuitWorkspace) => void;
  onView: (v: ConnectivityView) => void;
  onHighlight: (h: CircuitHighlight) => void;
  busy: boolean;
}) {
  const [view, setView] = useState<ConnectivityView | null>(null),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [reviewer, setReviewer] = useState(""),
    [reason, setReason] = useState(""),
    [terminalId, setTerminalId] = useState(""),
    [componentId, setComponentId] = useState(""),
    [role, setRole] = useState(""),
    [roleSource, setRoleSource] = useState(""),
    [componentType, setComponentType] = useState("unknown"),
    [intact, setIntact] = useState(false),
    [electrical, setElectrical] = useState(false),
    [refText, setRefText] = useState(""),
    [contactTarget, setContactTarget] = useState(""),
    [newLabel, setNewLabel] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/analyses/${job.analysisId}/connectivity`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok)
          throw Error(
            "Connectivity could not be loaded. Restart the updated backend if necessary.",
          );
        return parseConnectivityView(
          await r.json(),
          job.analysisId,
          job.imageHash,
        );
      })
      .then((v) => {
        if (controller.signal.aborted) return;
        setView(v);
        onView(v);
        if (v.source?.workspace)
          onRestore(v.source.workspace as CircuitWorkspace);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [
    job.analysisId,
    job.imageHash,
    job.updatedAt,
    job.revision,
    job.sam.snapshotRef?.samSnapshotHash,
    job.scene?.snapshotRef?.snapshotHash,
    onRestore,
    onView,
  ]);
  const input = view?.source?.input,
    revision = input?.revision ?? 0,
    graph = view?.graph?.graph,
    disabled = busy || saving;
  const terminal = input?.terminals.find((t) => t.id === terminalId),
    component = input?.components.find((c) => c.id === componentId);
  const permitted = reviewer.trim().length > 0 && reason.trim().length >= 8;
  const savedWorkspace = view?.source?.workspace as
    CircuitWorkspace | undefined;
  const workspaceDirty =
    !!input &&
    (!savedWorkspace ||
      JSON.stringify([
        workspace.boards,
        workspace.assignments,
        workspace.reviews,
      ]) !==
        JSON.stringify([
          savedWorkspace.boards,
          savedWorkspace.assignments,
          savedWorkspace.reviews,
        ]));
  const canReview = permitted && !workspaceDirty;
  async function action(name: string, payload: unknown) {
    setError("");
    setSaving(true);
    try {
      const r = await fetch(`/api/analyses/${job.analysisId}/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok)
        throw Error(
          r.status === 409
            ? "Connectivity evidence changed or is stale. Reload the saved analysis and save the current workspace before retrying."
            : "The connectivity action failed. Check the selected evidence and review fields.",
        );
      const v = parseConnectivityView(
        await r.json(),
        job.analysisId,
        job.imageHash,
      );
      setView(v);
      onView(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connectivity action failed.");
    } finally {
      setSaving(false);
    }
  }
  const meta = { expectedRevision: revision, reviewer, reason };
  const review = (kind: string, targetId: string, value: unknown) =>
    void action("review-connectivity", {
      ...meta,
      action: kind,
      targetId,
      value,
    });
  const chooseNode = (id: string) => {
    const node = graph?.nodes.find((n) => n.id === id);
    onHighlight({
      pointIds: node?.members ?? [],
      componentIds:
        graph?.components
          .filter((c) =>
            c.terminalIds.some((t) => node?.members.includes(`terminal:${t}`)),
          )
          .map((c) => c.id) ?? [],
      connectionIds:
        graph?.connections
          .filter(
            (e) =>
              node?.members.includes(e.from) && node.members.includes(e.to),
          )
          .map((e) => e.id) ?? [],
    });
  };
  return (
    <section className="connectivity-panel" aria-label="Connectivity">
      <h3>Connectivity · Phase 5A</h3>
      <p>
        Build from reviewed topology and electrical associations. Green
        highlights are confirmed; dashed amber markers are unresolved. No SAM or
        Muse calls. Housing entries and hole proximity remain separate from
        contact.
      </p>
      <p role="status">
        {input
          ? `Evidence revision ${revision}; ${workspaceDirty ? "save workspace changes before review/build" : view!.graphStale ? "graph requires rebuild" : "graph current"}`
          : "Save the calibrated workspace to begin."}
      </p>
      {error && <p role="alert">{error}</p>}
      <label>
        Reviewer
        <input
          aria-label="Connectivity reviewer"
          value={reviewer}
          onChange={(e) => setReviewer(e.target.value)}
        />
      </label>
      <label>
        Evidence note
        <textarea
          aria-label="Connectivity evidence note"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Describe the observation or source (at least 8 characters)"
        />
      </label>
      <button
        type="button"
        className="button button-secondary"
        disabled={disabled || !permitted || !view}
        onClick={() =>
          void action("save-connectivity-workspace", {
            ...meta,
            imageHash: job.imageHash,
            workspace,
          })
        }
      >
        Save calibration and endpoint evidence
      </button>
      <button
        type="button"
        className="button button-secondary"
        disabled={disabled || !input || workspaceDirty}
        onClick={() =>
          void action("build-connectivity", { expectedRevision: revision })
        }
      >
        Build connectivity graph
      </button>
      {input && (
        <>
          <details>
            <summary>Breadboard topology</summary>
            <p>
              Conductive review coverage: {input.coverage.state}. A confirmed
              missing-path fault requires an explicit review that no relevant
              conductive paths are omitted.
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={disabled || !canReview}
              onClick={() =>
                review("coverage", "conductive-review-coverage", {
                  confirmed: true,
                })
              }
            >
              Confirm all relevant conductive paths have been reviewed
            </button>
            {input.boards.map((b) => (
              <div key={b.id}>
                <p>
                  {b.id} · revision {b.revision} · {b.topologyState}. Standard
                  a–e/f–j strips; rails:{" "}
                  {b.rails
                    .map(
                      (r) =>
                        `${r.id} ${r.connectivity}${r.splitAfter ? ` after ${r.splitAfter}` : ""}`,
                    )
                    .join(", ") || "none registered"}
                  .
                </p>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={disabled || !canReview}
                  onClick={() => review("topology", b.id, { confirmed: true })}
                >
                  Confirm topology {b.id}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={disabled || !canReview}
                  onClick={() => review("topology", b.id, { confirmed: false })}
                >
                  Mark topology unknown
                </button>
              </div>
            ))}
          </details>
          <details>
            <summary>Components and conductor identity</summary>
            <label>
              Unrecognized component label
              <input
                aria-label="New connectivity component label"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="button button-secondary"
              disabled={disabled || !canReview || !newLabel.trim()}
              onClick={() =>
                review("add_component", `manual:${crypto.randomUUID()}`, {
                  label: newLabel,
                  type: "unknown",
                })
              }
            >
              Add unrecognized component for review
            </button>
            <label>
              Component
              <select
                aria-label="Connectivity component"
                value={componentId}
                onChange={(e) => {
                  setComponentId(e.target.value);
                  const c = input.components.find(
                    (c) => c.id === e.target.value,
                  );
                  setComponentType(c?.type ?? "unknown");
                  setIntact(false);
                }}
              >
                <option value="">Select a component</option>
                {input.components.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} · {c.state}
                  </option>
                ))}
              </select>
            </label>
            {component && (
              <>
                <label>
                  Component type
                  <select
                    aria-label="Connectivity component type"
                    value={componentType}
                    onChange={(e) => setComponentType(e.target.value)}
                  >
                    {[
                      "unknown",
                      "breadboard",
                      "jumper_wire",
                      "conductor",
                      "led",
                      "resistor",
                      "ldr",
                      "npn_transistor",
                      "battery",
                      "power_source",
                      "dc_power_source",
                    ].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={intact}
                    onChange={(e) => setIntact(e.target.checked)}
                  />
                  For a conductor: both selected ends belong to the same intact
                  conductive wire
                </label>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={disabled || !canReview}
                  onClick={() =>
                    review("component", component.id, {
                      type: componentType,
                      confirmed: true,
                      intactConductor: intact,
                    })
                  }
                >
                  Confirm component identity
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={disabled || !canReview}
                  onClick={() =>
                    review("component", component.id, {
                      type: componentType,
                      confirmed: false,
                      intactConductor: false,
                      excluded: true,
                    })
                  }
                >
                  Exclude this hypothesis from electrical reasoning
                </button>
              </>
            )}
          </details>
          <details open>
            <summary>Terminal associations and corrections</summary>
            <label>
              Terminal
              <select
                aria-label="Connectivity terminal"
                value={terminalId}
                onChange={(e) => {
                  setTerminalId(e.target.value);
                  setElectrical(false);
                  const t = input.terminals.find(
                    (t) => t.id === e.target.value,
                  );
                  setRole(t?.role ?? "");
                  setRoleSource("");
                  if (t) {
                    const a = input.associations.find(
                      (a) => a.terminalId === t.id && a.state !== "rejected",
                    );
                    onHighlight({
                      pointIds: [
                        `terminal:${t.id}`,
                        ...(a?.target?.kind === "hole"
                          ? [`hole:${a.target.boardId}:${a.target.holeId}`]
                          : []),
                      ],
                      componentIds: [t.componentId],
                      connectionIds: [],
                      unresolved:
                        a?.state !== "confirmed_manual" &&
                        a?.state !== "confirmed_auto",
                    });
                  }
                }}
              >
                <option value="">Select a terminal</option>
                {input.terminals.map((t) => (
                  <option key={t.id} value={t.id}>
                    {
                      input.components.find((c) => c.id === t.componentId)
                        ?.label
                    }
                    : {t.role ?? t.label}
                  </option>
                ))}
              </select>
            </label>
            {terminal && (
              <>
                <p>
                  {terminal.id}: {terminal.role ?? "unknown role"} (
                  {terminal.roleState})
                </p>
                <label>
                  Known terminal role
                  <input
                    aria-label="Connectivity terminal role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="Leave empty if unknown"
                  />
                </label>
                <label>
                  Role evidence
                  <input
                    aria-label="Connectivity role source"
                    value={roleSource}
                    onChange={(e) => setRoleSource(e.target.value)}
                    placeholder="Verified marking or part/package pinout; not color/position"
                  />
                </label>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={
                    disabled || !canReview || roleSource.trim().length < 8
                  }
                  onClick={() =>
                    review("terminal", terminal.id, {
                      role: role.trim() || null,
                      roleSource,
                      position: terminal.position,
                    })
                  }
                >
                  Save terminal role
                </button>
                <p>
                  Use the existing calibrated image or hole-coordinate picker.
                  Selected hole:{" "}
                  {selectedHole
                    ? `${selectedHole.breadboardId} / ${selectedHole.hole}`
                    : "none"}
                  .
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={electrical}
                    onChange={(e) => setElectrical(e.target.checked)}
                  />
                  I confirm this exact lead makes conductive contact at the
                  selected hole or terminal
                </label>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={
                    disabled || !canReview || !electrical || !selectedHole
                  }
                  onClick={() => {
                    const b = input.boards.find(
                      (b) => b.id === selectedHole!.breadboardId,
                    );
                    if (!b)
                      return setError("Save this board calibration first.");
                    const a = input.associations.find(
                      (a) =>
                        a.terminalId === terminal.id && a.state !== "rejected",
                    );
                    review("association", a?.id ?? `manual:${terminal.id}`, {
                      terminalId: terminal.id,
                      target: {
                        kind: "hole",
                        boardId: b.id,
                        holeId: selectedHole!.hole,
                        calibrationRevision: b.revision,
                      },
                      type: "insertion",
                      decision: "confirmed_manual",
                    });
                  }}
                >
                  Confirm terminal at selected hole
                </button>
                <label>
                  External contact terminal
                  <select
                    aria-label="Connectivity contact target"
                    value={contactTarget}
                    onChange={(e) => setContactTarget(e.target.value)}
                  >
                    <option value="">Select another known terminal</option>
                    {input.terminals
                      .filter((t) => t.id !== terminal.id)
                      .map((t) => (
                        <option value={t.id} key={t.id}>
                          {t.id}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={
                    disabled || !canReview || !electrical || !contactTarget
                  }
                  onClick={() => {
                    const a = input.associations.find(
                      (a) =>
                        a.terminalId === terminal.id && a.state !== "rejected",
                    );
                    review("association", a?.id ?? `manual:${terminal.id}`, {
                      terminalId: terminal.id,
                      target: { kind: "terminal", terminalId: contactTarget },
                      type: "conductive_contact",
                      decision: "confirmed_manual",
                    });
                  }}
                >
                  Confirm conductive contact to selected terminal
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={disabled || !canReview}
                  onClick={() => {
                    const a = input.associations.find(
                      (a) =>
                        a.terminalId === terminal.id && a.state !== "rejected",
                    );
                    review("association", a?.id ?? `manual:${terminal.id}`, {
                      terminalId: terminal.id,
                      target: null,
                      type: "insertion",
                      decision: "unresolved",
                    });
                  }}
                >
                  Mark terminal association unresolved
                </button>
                {input.associations
                  .filter((a) => a.terminalId === terminal.id)
                  .map((a) => (
                    <p key={a.id}>
                      {a.state}:{" "}
                      {a.target?.kind === "hole"
                        ? `${a.target.boardId}/${a.target.holeId}`
                        : a.target?.kind === "terminal"
                          ? a.target.terminalId
                          : "unresolved"}{" "}
                      · {a.type}. Evidence{" "}
                      {a.evidence.map((p) => p.id.slice(0, 8)).join(", ")}.
                    </p>
                  ))}
              </>
            )}
          </details>
        </>
      )}
      {graph && (
        <details open>
          <summary>Electrical graph · {graph.nodes.length} nodes</summary>
          {(view!.graphStale || workspaceDirty) && (
            <p>Historical graph: rebuild before using a diagnosis.</p>
          )}
          <p>
            {graph.connections.length} confirmed conductive relationships;{" "}
            {graph.devices.length} typed devices; {graph.unresolved.length}{" "}
            unresolved associations. Device terminals are not shorted together.
          </p>
          <label>
            Electrical node
            <select
              aria-label="Connectivity node"
              onChange={(e) => chooseNode(e.target.value)}
              defaultValue=""
            >
              <option value="">
                Select a node to highlight its holes and wires
              </option>
              {graph.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.id.slice(0, 16)}:{" "}
                  {n.members
                    .filter((m) => m.startsWith("terminal:"))
                    .join(", ") || n.members.slice(0, 2).join(", ")}
                </option>
              ))}
            </select>
          </label>
          <details>
            <summary>Connections and provenance</summary>
            {graph.connections
              .filter((e) => e.type !== "topology")
              .map((e) => (
                <div key={e.id}>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() =>
                      onHighlight({
                        pointIds: [e.from, e.to],
                        componentIds: e.componentId ? [e.componentId] : [],
                        connectionIds: [e.id],
                      })
                    }
                  >
                    {e.type}: {e.from} → {e.to}
                  </button>
                  <p>
                    {e.state};{" "}
                    {e.evidenceIds
                      .map(
                        (id) =>
                          graph.provenance.find((p) => p.id === id)?.note ?? id,
                      )
                      .join("; ")}
                  </p>
                </div>
              ))}
          </details>
          <details>
            <summary>Unresolved evidence and validation warnings</summary>
            {graph.unresolved.map((u) => (
              <p key={u.id}>
                {u.terminalId ?? u.id}: {u.reason}
              </p>
            ))}
            {graph.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </details>
        </details>
      )}
      <details>
        <summary>Reference circuit and fault diagnosis</summary>
        <p>
          Upload JSON containing a configurable reference and explicit component
          mapping. Transistor package pinout and the intended real schematic
          must be verified separately. Synthetic references remain labeled
          synthetic.
        </p>
        <input
          type="file"
          aria-label="Connectivity reference circuit"
          accept="application/json,.json"
          disabled={disabled}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 262144)
              return setError("Reference must be under 256 KB.");
            setRefText(await f.text());
          }}
        />
        <button
          type="button"
          className="button button-secondary"
          disabled={disabled || !permitted || !input || !refText}
          onClick={() => {
            try {
              const r = JSON.parse(refText);
              void action("register-connectivity-reference", {
                ...meta,
                reference: r.reference ?? r,
                mapping: r.mapping ?? {},
              });
            } catch {
              setError("Reference JSON is invalid.");
            }
          }}
        >
          Register reference and mapping
        </button>
        {view?.references.map((r) => (
          <div key={r.id}>
            <p>
              {r.reference.name} · {r.reference.qualification}
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={disabled || view.graphStale || workspaceDirty || !graph}
              onClick={() =>
                void action("compare-connectivity", {
                  expectedRevision: revision,
                  referenceId: r.id,
                })
              }
            >
              Compare connectivity with reference
            </button>
          </div>
        ))}
        {view?.comparisons
          .filter(
            (c) =>
              c.comparison.graphHash === graph?.graphHash &&
              c.sourceRevision === revision &&
              !view.graphStale &&
              !workspaceDirty,
          )
          .flatMap((c) =>
            c.comparison.findings.map((f) => (
              <div key={`${c.id}:${f.id}`}>
                <strong>
                  {f.status} · {f.scope}
                </strong>
                <p>{f.reason}</p>
                <p>
                  Expected {f.expected.from} ↔ {f.expected.to}. Observed jumper:{" "}
                  {f.observed.jumperId ?? "unknown"}.
                </p>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    const points =
                      graph?.nodes.find(
                        (n) => n.id === f.highlight.destinationNodeId,
                      )?.members ?? [];
                    onHighlight({
                      pointIds: [
                        ...points,
                        ...f.observed.endpointIds.map((id) => `terminal:${id}`),
                      ],
                      componentIds: f.highlight.componentIds,
                      connectionIds: f.highlight.connectionIds,
                    });
                  }}
                >
                  Highlight finding and supported destination
                </button>
              </div>
            )),
          )}
      </details>
      {view && (
        <>
          <p>
            {view.history.length} immutable review/import events. Additional
            inference requests: 0.
          </p>
          <button
            type="button"
            className="button button-secondary"
            disabled={saving}
            onClick={async () => {
              setError("");
              setSaving(true);
              try {
                const response = await fetch(
                  `/api/analyses/${job.analysisId}/connectivity-evidence`,
                  { cache: "no-store" },
                );
                if (!response.ok)
                  throw Error(
                    "The complete connectivity evidence archive could not be downloaded.",
                  );
                const evidence = parseConnectivityEvidence(
                  await response.json(),
                  job.analysisId,
                );
                const url = URL.createObjectURL(
                  new Blob(
                    [
                      JSON.stringify(
                        {
                          ...evidence,
                          graphStale: evidence.graphStale || workspaceDirty,
                          localWorkspaceUnsaved: workspaceDirty,
                        },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  ),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "praxis-connectivity-evidence.json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Evidence export failed.",
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            Export connectivity evidence
          </button>
        </>
      )}
    </section>
  );
}
export function ConnectivityOverlay({
  graph,
  highlight,
  image,
}: {
  graph: ElectricalGraph;
  highlight: CircuitHighlight;
  image: { width: number; height: number };
}) {
  const points = graph.points.filter((p) => highlight.pointIds.includes(p.id));
  const color = highlight.unresolved ? "#d97706" : "#16a34a";
  const links = graph.connections.filter((e) =>
    highlight.connectionIds.includes(e.id),
  );
  const unverified = (id: string) =>
    graph.points.find((p) => p.id === id)?.positionBasis ===
    "unverified_terminal_observation";
  const position = (id: string) =>
    graph.points.find((p) => p.id === id)?.position;
  return (
    <svg
      aria-label="Connectivity highlights"
      viewBox={`0 0 ${image.width} ${image.height}`}
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 210,
      }}
    >
      {points.map(
        (p) =>
          p.position && (
            <circle
              key={p.id}
              cx={p.position.x}
              cy={p.position.y}
              r={5}
              fill={highlight.unresolved || unverified(p.id) ? "none" : color}
              stroke={
                highlight.unresolved || unverified(p.id) ? "#d97706" : "white"
              }
              strokeDasharray={
                highlight.unresolved || unverified(p.id) ? "3 2" : undefined
              }
            >
              <title>
                {p.id}: {p.positionBasis}
              </title>
            </circle>
          ),
      )}
      {links.map((e) => {
        const a = position(e.from),
          b = position(e.to);
        return a && b ? (
          <line
            key={e.id}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={
              unverified(e.from) || unverified(e.to) ? "#d97706" : "#16a34a"
            }
            strokeDasharray={
              unverified(e.from) || unverified(e.to) ? "4 3" : undefined
            }
            strokeWidth={3}
          >
            <title>{e.id}</title>
          </line>
        ) : null;
      })}
      {graph.components
        .filter((c) => highlight.componentIds.includes(c.id) && c.bbox)
        .map((c) => (
          <rect
            key={c.id}
            x={c.bbox![0]}
            y={c.bbox![1]}
            width={c.bbox![2]}
            height={c.bbox![3]}
            fill="none"
            stroke="#d97706"
            strokeWidth={3}
          >
            <title>{c.label}</title>
          </rect>
        ))}
    </svg>
  );
}
