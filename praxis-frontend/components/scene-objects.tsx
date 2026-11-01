import { AutomaticTargetingPanel } from "./automatic-targeting-panel";
import { useState } from "react";
import { planSceneTargets } from "@/lib/scene-guidance";
import type { Analysis } from "@/lib/vision";
import type { AnalysisJob } from "@/lib/analysis-jobs";
import type { SceneGraph } from "@/lib/scene";
import {
  reconcileSceneView,
  preferredTerminalTargets,
  inventoryObjectIds,
  type DisplayObject,
} from "@/lib/scene-reconciliation";

export type SceneMode = "objects" | "members" | "evidence";
export type SceneAction =
  | "evaluate-connector-reference"
  | "prepare-automatic-targeting"
  | "run-automatic-targeting"
  | "evaluate-automatic-targeting"
  | "release-automatic-targeting"
  | "reconcile-scene"
  | "discover-terminals"
  | "guide-scene"
  | "refresh-scene";
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
        aria-pressed={mode === "members"}
        onClick={() => onChange("members")}
      >
        Show separately
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
  const view = reconcileSceneView(
    graph,
    result?.objects ?? [],
    mode === "members",
  );
  const [maskNotes, setMaskNotes] = useState<Record<string, string>>({});
  const [terminalMember, setTerminalMember] = useState<string | null>(null);
  const inventory = inventoryObjectIds(graph);
  const selected = view.objects.find(
    (o) =>
      o.id === selectedId ||
      o.sceneObjectIds.includes(selectedId ?? "") ||
      o.baselineIds.includes(selectedId ?? ""),
  );
  const selectedIdInGraph =
    selected && selected.sceneObjectIds.length > 1
      ? terminalMember &&
        selected.sceneObjectIds.includes(terminalMember) &&
        inventory.has(terminalMember)
        ? terminalMember
        : undefined
      : selectedId && inventory.has(selectedId)
        ? selectedId
        : undefined;
  const attempted = new Set([
    ...(job?.scene?.terminalWork?.map((w) => w.objectId) ?? []),
    ...(graph.terminals ?? []).map((t) => t.objectId),
  ]);
  const targets = selected
    ? selectedIdInGraph &&
      !attempted.has(selectedIdInGraph) &&
      graph.objects.find((o) => o.id === selectedIdInGraph)?.category !==
        "board"
      ? [selectedIdInGraph]
      : []
    : preferredTerminalTargets(graph).filter((id) => !attempted.has(id));
  const binding = job?.scene?.snapshotRef;
  const terminalBudget = job?.scene?.settings?.maxTerminalRequests ?? 2;
  const remaining = terminalBudget - (job?.scene?.budget.terminalRequests ?? 0);
  const connectorGateBlocked =
    job?.connectorValidation?.gates.some((g) => g.status === "blocked") ??
    false;
  const targetIds = targets.slice(0, Math.max(0, remaining));
  const guidedTargets = planSceneTargets(
    graph,
    graph.image,
    job?.scene?.settings?.maxCropPixels ?? 2000000,
  )
    .filter((t) => !job?.scene?.work.some((w) => w.objectId === t.objectId))
    .slice(0, Math.max(0, 3 - (job?.scene?.budget.requests ?? 0)));
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
      <p>
        {view.objects.length} displayed hypotheses · identity reviews apply only
        to same-object claims.
      </p>
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
              {o.grouping && (
                <span>
                  {o.grouping === "confirmed"
                    ? "Confirmed same object"
                    : "Grouped by proposal"}{" "}
                  · {o.sceneObjectIds.length} members
                </span>
              )}
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
      {!!graph.ambiguityClusters?.length && (
        <section aria-label="Identity ambiguity clusters">
          <h3>Identity ambiguities ({graph.ambiguityClusters.length})</h3>
          <p>
            These candidates may describe the same object. Cluster membership
            does not merge objects, terminals or electrical relationships.
          </p>
          {graph.ambiguityClusters.map((cluster) => {
            const review = graph.ambiguityReviews
              ?.filter((r) => r.clusterId === cluster.id)
              .at(-1);
            const currentReview =
              review &&
              review.memberObjectIds.length ===
                cluster.memberObjectIds.length &&
              cluster.memberObjectIds.every((id) =>
                review.memberObjectIds.includes(id),
              );
            return (
              <details key={cluster.id}>
                <summary>
                  {cluster.memberObjectIds.length} competing identities ·{" "}
                  {currentReview
                    ? review.decision.replaceAll("_", " ")
                    : review
                      ? "new members need review"
                      : "needs review"}
                </summary>
                <small style={{ overflowWrap: "anywhere" }}>
                  Cluster {cluster.id}
                </small>
                {cluster.memberObjectIds.map((id) => (
                  <div key={id}>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => {
                        onSelect(id);
                        onModeChange("members");
                      }}
                    >
                      Inspect{" "}
                      {graph.objects.find((o) => o.id === id)?.proposedType}
                    </button>
                    <small
                      style={{ display: "block", overflowWrap: "anywhere" }}
                    >
                      {id}
                    </small>
                  </div>
                ))}
                <p>
                  {cluster.evidence.length} retained comparisons. Reviews record
                  the current membership and do not automatically merge it.
                </p>
                <details>
                  <summary>Matching evidence</summary>
                  {cluster.evidence.map((e) => (
                    <p
                      key={`${e.observationId}:${e.candidateObjectId}`}
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {e.proposalObjectId} → {e.candidateObjectId}: overlap{" "}
                      {e.iou.toFixed(2)}, description{" "}
                      {e.semanticOverlap.toFixed(2)};{" "}
                      {e.eligible
                        ? "competing match"
                        : "insufficient identity evidence"}
                      {e.wireSafeguard ? "; conductor safeguard retained" : ""}.
                      Observation {e.observationId}.
                    </p>
                  ))}
                </details>
                {!!cluster.relatedClusterIds.length && (
                  <p>
                    Related clusters: {cluster.relatedClusterIds.join(", ")}
                  </p>
                )}
                {binding &&
                  onAction &&
                  (
                    [
                      ["same_object", "Review cluster as same object"],
                      [
                        "different_objects",
                        "Review cluster as different objects",
                      ],
                      ["uncertain", "Keep cluster uncertain"],
                    ] as const
                  ).map(([decision, label]) => (
                    <button
                      key={decision}
                      type="button"
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() =>
                        onAction("reconcile-scene", {
                          snapshotId: binding.snapshotId,
                          snapshotHash: binding.snapshotHash,
                          ambiguityReview: {
                            clusterId: cluster.id,
                            memberObjectIds: cluster.memberObjectIds,
                            decision,
                          },
                        })
                      }
                    >
                      {label}
                    </button>
                  ))}
              </details>
            );
          })}
        </section>
      )}
      {selected && (
        <section aria-label="Selected object evidence">
          <h3>{selected.name}</h3>
          <p>
            {selected.grouping === "confirmed"
              ? "Same-object identity confirmed by review"
              : "Physical identity proposed"}{" "}
            · electrical connection unestablished.
          </p>
          <h4>Original members ({selected.sceneObjectIds.length})</h4>
          <p>
            Choose the exact inventory member for selective terminal discovery.
            Identity review does not confirm contacts, roles, attachments or
            electrical connectivity.
          </p>
          {selected.sceneObjectIds.map((id) => {
            const member = graph.objects.find((o) => o.id === id)!;
            return (
              <div key={id} style={{ margin: "10px 0" }}>
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ width: "100%", textAlign: "left" }}
                  onClick={() => {
                    onSelect(id);
                    setTerminalMember(id);
                  }}
                  aria-pressed={selectedIdInGraph === id}
                >
                  {member.proposedType} ·{" "}
                  {inventory.has(id)
                    ? "Muse inventory member"
                    : "SAM evidence hypothesis"}
                </button>
                <small style={{ display: "block", overflowWrap: "anywhere" }}>
                  {id} · box [{member.bbox.join(", ")}]
                </small>
              </div>
            );
          })}
          {!!selected.baselineIds.length && (
            <details>
              <summary>Provisionally linked baseline observations</summary>
              {selected.baselineIds.map((id) => (
                <p key={id}>
                  {id} · candidate evidence, not a confirmed identity
                </p>
              ))}
            </details>
          )}
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
              <div key={r.id}>
                <p>
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
                  {
                    graph.objects.find((o) => o.id === r.toObjectId)
                      ?.proposedType
                  }
                </p>
                {r.type === "same_object" && (
                  <>
                    <p>
                      Identity review:{" "}
                      {graph.identityReviews
                        ?.filter((v) => v.relationId === r.id)
                        .at(-1)
                        ?.decision.replaceAll("_", " ") ?? "not reviewed"}
                    </p>
                    {binding &&
                      onAction &&
                      (
                        [
                          ["same_object", "Confirm same object"],
                          ["different_objects", "Keep as different objects"],
                          ["uncertain", "Identity uncertain"],
                        ] as const
                      ).map(([decision, label]) => (
                        <button
                          key={decision}
                          type="button"
                          className="button button-secondary"
                          style={{ width: "100%", margin: "4px 0" }}
                          disabled={busy}
                          onClick={() =>
                            onAction("reconcile-scene", {
                              snapshotId: binding.snapshotId,
                              snapshotHash: binding.snapshotHash,
                              identityReview: { relationId: r.id, decision },
                            })
                          }
                        >
                          {label}
                        </button>
                      ))}
                  </>
                )}
              </div>
            ))}
          <h4>Guided mask identity</h4>
          <p>
            Prompt targeting and box overlap do not verify a mask’s physical
            identity. Inspect the actual pixels, neighboring objects and
            conductor paths.
          </p>
          {graph.associations
            .filter(
              (a) =>
                a.basis === "prompt_target" &&
                selected.sceneObjectIds.includes(a.objectId) &&
                graph.observations.some(
                  (o) => o.id === a.observationId && o.kind === "mask",
                ),
            )
            .map((a) => {
              const review = graph.maskIdentityReviews
                ?.filter(
                  (r) =>
                    r.objectId === a.objectId &&
                    r.observationId === a.observationId,
                )
                .at(-1);
              return (
                <div key={a.id} style={{ margin: "10px 0" }}>
                  <small style={{ overflowWrap: "anywhere" }}>
                    {a.observationId}
                  </small>
                  <p>
                    Mask identity:{" "}
                    {review
                      ? `${review.decision} · ${review.source.replaceAll("_", " ")}`
                      : "unreviewed"}
                    . {review?.reason}
                  </p>
                  <label>
                    Visible mask evidence
                    <textarea
                      maxLength={600}
                      value={maskNotes[a.id] ?? ""}
                      onChange={(e) =>
                        setMaskNotes({ ...maskNotes, [a.id]: e.target.value })
                      }
                    />
                  </label>
                  {binding &&
                    onAction &&
                    (
                      [
                        ["accepted", "Accept object mask"],
                        ["rejected", "Reject object mask"],
                        ["uncertain", "Mask identity uncertain"],
                      ] as const
                    ).map(([decision, label]) => (
                      <button
                        key={decision}
                        type="button"
                        className="button button-secondary"
                        disabled={
                          busy || (maskNotes[a.id]?.trim().length ?? 0) < 8
                        }
                        style={{ margin: "4px 0" }}
                        onClick={() => {
                          const reason = maskNotes[a.id];
                          if (reason && reason.trim().length >= 8)
                            onAction("reconcile-scene", {
                              snapshotId: binding.snapshotId,
                              snapshotHash: binding.snapshotHash,
                              maskReview: {
                                objectId: a.objectId,
                                observationId: a.observationId,
                                decision,
                                source: "human_review",
                                reason: reason.trim(),
                              },
                            });
                        }}
                      >
                        {label}
                      </button>
                    ))}
                </div>
              );
            })}
          <h4>Contact and reference proposals</h4>
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
                Contact location:{" "}
                {t.location
                  ? `${t.location.join(", ")} · ${t.locationEvidence === "visible_lead" ? "legacy exposed lead; contact unestablished" : "model-proposed visible contact"}`
                  : "unresolved"}{" "}
                ({t.locationEvidence.replaceAll("_", " ")}).
              </p>
              {t.reference && (
                <p>
                  Reference point: {t.reference.position.join(", ")} ·{" "}
                  {t.reference.evidence.replaceAll("_", " ")}. This does not
                  locate a hidden contact.
                </p>
              )}
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
      <AutomaticTargetingPanel
        job={job}
        graph={graph}
        busy={busy}
        onAction={onAction}
      />
      <h3>Selective terminal discovery</h3>
      {connectorGateBlocked && (
        <p role="status">
          Terminal discovery is blocked until independent connector pixel
          validation passes for this scene.
        </p>
      )}
      <p>
        Suggested coverage prioritizes battery snap connectors and LED
        assemblies, at most two objects within the request budget. Other
        components are not examined automatically.
      </p>
      <details>
        <summary>Terminal discovery coverage</summary>
        {graph.objects
          .filter((o) => inventory.has(o.id))
          .map((o) => {
            const work = job?.scene?.terminalWork
              ?.filter((w) => w.objectId === o.id)
              .at(-1);
            const terminals = (graph.terminals ?? []).filter(
              (t) => t.objectId === o.id,
            );
            const contact = terminals.some(
              (t) => t.locationEvidence === "visible_terminal" && t.location,
            );
            const queued = job?.scene?.attempts.some(
              (a) =>
                ["queued", "running"].includes(a.status) &&
                a.terminalObjectIds?.includes(o.id),
            );
            const coverage = contact
              ? "visible contact proposed"
              : work?.status === "succeeded" || terminals.length
                ? "examined but unresolved"
                : work
                  ? `request ${work.status}; coverage unresolved`
                  : queued
                    ? "request queued; coverage unresolved"
                    : "not attempted";
            return (
              <p key={o.id}>
                {o.proposedType}: {coverage}
              </p>
            );
          })}
      </details>
      {binding && onAction && (
        <div style={{ marginTop: 16 }}>
          <h3>Guided scene segmentation</h3>
          <p>
            Used {job?.scene?.budget.requests ?? 0}/3 requests ·{" "}
            {job?.scene?.budget.pixels ?? 0}/6,000,000 crop pixels.
          </p>
          <p>
            At most three cumulative SAM requests and six million crop pixels.
            Priority: battery snap connector, LED housing, then an unsegmented
            conductor. Each response remains candidate evidence until its
            physical-object association is reviewed.
          </p>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || !guidedTargets.length}
            onClick={() =>
              onAction("guide-scene", {
                snapshotId: binding.snapshotId,
                snapshotHash: binding.snapshotHash,
                objectIds: guidedTargets.map((t) => t.objectId),
                guidedBudget: { maxRequests: 3, maxPixels: 6000000 },
              })
            }
          >
            Segment scene targets ({guidedTargets.length})
          </button>
          <p>
            {guidedTargets.map((t) => t.prompt).join("; ") ||
              "No unattempted targets within this request budget."}
          </p>
          {!!job?.scene?.work.length && (
            <details>
              <summary>
                Guided segmentation outcomes ({job.scene.work.length})
              </summary>
              {job.scene.work.map((work) => (
                <p key={work.requestId}>
                  {
                    graph.objects.find((o) => o.id === work.objectId)
                      ?.proposedType
                  }
                  :{" "}
                  {work.status === "no_match"
                    ? "No mask candidates returned"
                    : work.status}{" "}
                  · provider {work.upstreamOutcome}
                  {work.finishedAt !== undefined
                    ? ` · ${work.finishedAt - work.startedAt} ms`
                    : ""}
                </p>
              ))}
            </details>
          )}
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() =>
              onAction("refresh-scene", {
                snapshotId: binding.snapshotId,
                snapshotHash: binding.snapshotHash,
              })
            }
          >
            Refresh inventory (1 Muse request)
          </button>
          <p>
            Preserves previous object identities and evidence. Ambiguous
            rediscoveries remain separate hypotheses. No guided requests are
            started by refresh.
          </p>
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
            disabled={busy || !targetIds.length || connectorGateBlocked}
            onClick={() =>
              onAction("discover-terminals", {
                snapshotId: binding.snapshotId,
                snapshotHash: binding.snapshotHash,
                objectIds: targetIds,
              })
            }
          >
            Discover selected terminals ({targetIds.length})
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
  separateMembers = false,
}: {
  graph: SceneGraph;
  result: Analysis | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  separateMembers?: boolean;
}) {
  const view = reconcileSceneView(
      graph,
      result?.objects ?? [],
      separateMembers,
    ),
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
        {(graph.terminals ?? [])
          .filter(
            (t) => t.reference && selected?.sceneObjectIds.includes(t.objectId),
          )
          .map((t) => (
            <rect
              key={`reference:${t.id}`}
              x={t.reference!.position[0] - 3}
              y={t.reference!.position[1] - 3}
              width={6}
              height={6}
              fill="none"
              stroke="#156a9b"
            >
              <title>{`Reference only: ${t.reference!.evidence}; hidden contact unlocated`}</title>
            </rect>
          ))}
      </svg>
      {view.objects.map((o) => {
        const l = layout.get(o.id)!;
        return (
          <button
            key={o.id}
            type="button"
            className={`scene-object-label ${selected?.id === o.id ? "is-selected" : ""}`}
            title={`${o.name}${o.grouping ? ` · ${o.grouping === "confirmed" ? "confirmed same object" : "grouped by proposal"} · ${o.sceneObjectIds.length} members` : ""}`}
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
