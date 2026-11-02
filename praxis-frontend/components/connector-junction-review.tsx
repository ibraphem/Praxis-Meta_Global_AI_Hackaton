"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { AnalysisJob } from "@/lib/analysis-jobs";
import type { JunctionRecord } from "@/lib/connector-junctions";
import { junctionReferenceContentSchema } from "@/lib/connector-junctions";
import type { SceneGraph } from "@/lib/scene";
import type { SceneAction } from "./scene-objects";
type Selection = {
  planId: string;
  outcomeId: string;
  position: [number, number] | null;
  editing: boolean;
} | null;
const JunctionContext = createContext<{
  selection: Selection;
  setSelection: (v: Selection) => void;
}>({ selection: null, setSelection: () => {} });
export function JunctionReviewProvider({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const [selection, setSelection] = useState<Selection>(null);
  return (
    <JunctionContext.Provider value={{ selection, setSelection }}>
      {className ? <div className={className}>{children}</div> : children}
    </JunctionContext.Provider>
  );
}
export function ConnectorJunctionPanel({
  job,
  graph,
  busy,
  onAction,
  onSelect,
}: {
  job?: AnalysisJob | null;
  graph: SceneGraph;
  busy: boolean;
  onAction?: ((action: SceneAction, payload: unknown) => void) | undefined;
  onSelect: (id: string) => void;
}) {
  const connectors = graph.objects.filter((o) => o.category === "connector"),
    conductors = graph.objects.filter((o) => o.category === "conductor");
  const [target, setTarget] = useState(""),
    [wireA, setWireA] = useState(""),
    [wireB, setWireB] = useState(""),
    [useMuse, setUseMuse] = useState(false),
    [approvals, setApprovals] = useState<Record<string, boolean>>({}),
    [fileError, setFileError] = useState("");
  const connector =
      connectors.find((o) => o.id === target)?.id ?? connectors[0]?.id,
    a = conductors.find((o) => o.id === wireA)?.id ?? conductors[0]?.id,
    b = conductors.find((o) => o.id === wireB)?.id ?? conductors[1]?.id;
  const gate = job?.connectorValidation?.gates.find(
      (g) => g.objectId === connector,
    ),
    validation = job?.connectorValidation?.evaluations.find(
      (e) => e.evaluationId === gate?.evaluationId,
    ),
    accepted =
      gate?.status === "passed" &&
      validation?.strategy === "C-body-aware-v2" &&
      validation.independentGroundTruth;
  const records = job?.connectorJunctions ?? [];
  const attempted = records.some(
    (r) =>
      r.admittedAt !== null &&
      r.plan.connectorObjectId === connector &&
      r.plan.conductorObjectIds.includes(a ?? "") &&
      r.plan.conductorObjectIds.includes(b ?? ""),
  );
  return (
    <section
      className="connector-junction-panel"
      aria-label="Connector junction discovery"
    >
      <h3>Connector junction discovery · Phase 4B</h3>
      <p>
        One connector, two conductor outcomes. Housing entries do not locate
        hidden contacts. Zero SAM; at most one Muse request, without retries.
      </p>
      {!accepted && (
        <p>
          Blocked: this scene requires an independently accepted Strategy C
          native connector mask. No inference will be sent.
        </p>
      )}
      <label style={{ display: "block" }}>
        Junction connector{" "}
        <select
          aria-label="Junction connector"
          value={connector ?? ""}
          onChange={(e) => {
            setTarget(e.target.value);
            onSelect(e.target.value);
          }}
        >
          {connectors.map((o) => (
            <option key={o.id} value={o.id}>
              {o.proposedType}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "block" }}>
        Conductor A{" "}
        <select
          aria-label="Junction conductor A"
          value={a ?? ""}
          onChange={(e) => setWireA(e.target.value)}
        >
          {conductors.map((o) => (
            <option key={o.id} value={o.id}>
              {o.proposedType}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "block" }}>
        Conductor B{" "}
        <select
          aria-label="Junction conductor B"
          value={b ?? ""}
          onChange={(e) => setWireB(e.target.value)}
        >
          {conductors.map((o) => (
            <option key={o.id} value={o.id}>
              {o.proposedType}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={useMuse}
          onChange={(e) => setUseMuse(e.target.checked)}
        />{" "}
        Include one Muse interpretation after explicit run authorization
      </label>
      <button
        type="button"
        className="button button-secondary"
        disabled={
          busy || !accepted || attempted || !a || !b || a === b || !onAction
        }
        onClick={() =>
          onAction?.("prepare-connector-junctions", {
            connectorObjectId: connector,
            conductorObjectIds: [a, b],
            snapshotHash: job?.scene?.snapshotRef?.snapshotHash,
            useMuse,
          })
        }
      >
        Prepare connector junction attempt
      </button>
      {attempted && (
        <p>
          This selection already has a bounded junction attempt. Review or
          export its outcomes.
        </p>
      )}
      {records.map((r) => (
        <details key={r.plan.planId} open>
          <summary>Connector junction attempt · {r.phase}</summary>
          <p>
            Frozen Strategy C mask{" "}
            {r.plan.segmentation.observationId.slice(0, 8)}.{" "}
            {r.plan.budget.museRequests} planned Muse request(s),{" "}
            {r.plan.budget.inputPixels.toLocaleString()} total input-image
            pixels. Both original crop and evidence overlay count toward the
            budget.
          </p>
          <p>
            Reserved {r.accounting.reservedRequests}; dispatched{" "}
            {r.accounting.dispatchAttempts}; responses{" "}
            {r.accounting.responsesRecorded}; unknown usage{" "}
            {r.accounting.unknownUsageRequests}. No billing estimate.
          </p>
          {r.errorCode && (
            <p role="alert">
              Stopped: {r.errorCode}. This attempt is not replayed.
            </p>
          )}
          {r.phase === "prepared" && (
            <>
              {r.plan.useMuse && (
                <label>
                  <input
                    type="checkbox"
                    checked={approvals[r.plan.planId] ?? false}
                    onChange={(e) =>
                      setApprovals({
                        ...approvals,
                        [r.plan.planId]: e.target.checked,
                      })
                    }
                  />{" "}
                  Authorize sending these two saved crop images to{" "}
                  {r.plan.providerBaseUrl}: one Muse request,{" "}
                  {r.plan.budget.inputPixels} pixels, zero SAM and no retries.
                </label>
              )}
              <button
                type="button"
                className="button button-secondary"
                disabled={
                  busy ||
                  !onAction ||
                  (r.plan.useMuse && !approvals[r.plan.planId])
                }
                onClick={() =>
                  onAction?.("run-connector-junctions", {
                    planId: r.plan.planId,
                    authorizeInference: r.plan.useMuse,
                    providerBaseUrl: r.plan.providerBaseUrl,
                    museRequests: r.plan.budget.museRequests,
                    pixels: r.plan.budget.inputPixels,
                  })
                }
              >
                {r.plan.useMuse
                  ? "Run one junction interpretation"
                  : "Finish offline junction attempt"}
              </button>
            </>
          )}
          {r.effectiveOutcomes.map((o) => (
            <JunctionOutcomeReview
              key={`${o.id}:${r.revision}`}
              record={r}
              outcome={o}
              graph={graph}
              busy={busy}
              onAction={onAction}
            />
          ))}
          <details>
            <summary>Independent junction point reference</summary>
            <p>
              Upload a small original-image point-reference JSON from a separate
              reviewer. Corrections to predictions are not independent ground
              truth. Assistant or non-blinded references remain diagnostic.
            </p>
            <input
              type="file"
              aria-label="Independent junction point reference"
              accept="application/json,.json"
              disabled={busy || !onAction}
              onChange={async (e) => {
                setFileError("");
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  if (file.size > 65536)
                    throw Error("Use a point reference under 64 KB.");
                  const raw = JSON.parse(await file.text()),
                    content = junctionReferenceContentSchema.parse(
                      raw.content ?? raw,
                    );
                  onAction?.("freeze-junction-reference", {
                    planId: r.plan.planId,
                    content,
                  });
                } catch {
                  setFileError(
                    "Provide valid two-conductor coordinates, visibility and reviewer provenance.",
                  );
                }
              }}
            />
            {fileError && <p role="alert">{fileError}</p>}
            {r.references.map((ref) => (
              <p key={ref.referenceHash}>
                Reference {ref.version}:{" "}
                {ref.independent
                  ? "blinded independent human (attested)"
                  : "provisional / non-blinded or assistant reference"}
                .{" "}
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={
                    busy ||
                    !onAction ||
                    !["finished", "failed", "interrupted"].includes(r.phase)
                  }
                  onClick={() =>
                    onAction?.("evaluate-connector-junctions", {
                      planId: r.plan.planId,
                      referenceHash: ref.referenceHash,
                    })
                  }
                >
                  Score original junction proposals
                </button>{" "}
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={
                    busy ||
                    !onAction ||
                    !["finished", "failed", "interrupted"].includes(r.phase)
                  }
                  onClick={() =>
                    onAction?.("evaluate-connector-junctions", {
                      planId: r.plan.planId,
                      referenceHash: ref.referenceHash,
                      layer: "reviewed",
                    })
                  }
                >
                  Score reviewed junctions
                </button>
              </p>
            ))}
          </details>
          {r.evaluations.map((e) => (
            <p key={e.evaluationId}>
              Junction evaluation ({e.predictionLayer}): {e.status}; visible
              localized within 5 source pixels: {e.localizedWithinTolerance}/
              {e.visibleExpected}; unresolved visible: {e.unresolvedVisible};
              appropriate abstentions: {e.appropriateAbstentions}/
              {e.hiddenExpected}; wrong confirmed claims:{" "}
              {e.wrongConfirmedAssociations}/{e.confirmedCount}; provenance{" "}
              {(e.provenanceCoverage * 100).toFixed(0)}%.{" "}
              {e.independentGroundTruth
                ? "Independent human reference."
                : "Diagnostic reference; photographic accuracy is not independently established."}
            </p>
          ))}
          <a href={r.evidenceUrl} download>
            Download junction evidence archive
          </a>
        </details>
      ))}
    </section>
  );
}
function JunctionOutcomeReview({
  record,
  outcome: o,
  graph,
  busy,
  onAction,
}: {
  record: JunctionRecord;
  outcome: JunctionRecord["effectiveOutcomes"][number];
  graph: SceneGraph;
  busy: boolean;
  onAction?: ((action: SceneAction, payload: unknown) => void) | undefined;
}) {
  const { selection, setSelection } = useContext(JunctionContext),
    selected =
      selection?.planId === record.plan.planId && selection.outcomeId === o.id;
  const [kind, setKind] = useState<"housing_entry" | "exposed_contact">(
      o.kind === "exposed_contact" ? "exposed_contact" : "housing_entry",
    ),
    [x, setX] = useState(String(o.position?.[0] ?? "")),
    [y, setY] = useState(String(o.position?.[1] ?? "")),
    [reason, setReason] = useState(""),
    [reviewer, setReviewer] = useState(""),
    [original, setOriginal] = useState(false),
    [visible, setVisible] = useState(false);
  const point =
    selected && selection.position
      ? selection.position
      : x !== "" &&
          y !== "" &&
          Number.isInteger(Number(x)) &&
          Number.isInteger(Number(y))
        ? ([Number(x), Number(y)] as [number, number])
        : null;
  const send = (decision: "confirm" | "correct" | "unknown") => {
    onAction?.("review-connector-junction", {
      planId: record.plan.planId,
      revision: record.revision,
      outcomeId: o.id,
      decision,
      position: decision === "unknown" ? null : point,
      kind: decision === "unknown" ? "unknown" : kind,
      reason,
      reviewer,
      originalImageOnly: original,
      visibleEvidence: visible,
    });
    setSelection(null);
  };
  const allowed =
    !busy &&
    !!onAction &&
    ["finished", "failed", "interrupted"].includes(record.phase) &&
    original &&
    reviewer.trim().length > 0 &&
    reason.trim().length >= 8;
  return (
    <div
      role="group"
      aria-label={`Review junction ${o.expectedConductorObjectId}`}
      style={{ padding: 8, border: "1px solid #ddd", margin: "8px 0" }}
    >
      <strong>
        {graph.objects.find((c) => c.id === o.expectedConductorObjectId)
          ?.proposedType ?? o.expectedConductorObjectId}{" "}
        · {o.associationStatus}
      </strong>
      <p>
        {o.kind.replaceAll("_", " ")} · {o.visibility}; source position{" "}
        {o.position?.join(", ") ?? "unresolved"}. Contact {o.contactVisibility};
        contact position {o.contactPosition?.join(", ") ?? "unlocated"}.
        Electrical continuity remains unestablished.
      </p>
      <p>{o.reason}</p>
      <button
        type="button"
        className="button button-secondary"
        disabled={busy}
        onClick={() =>
          setSelection({
            planId: record.plan.planId,
            outcomeId: o.id,
            position: o.position,
            editing: true,
          })
        }
      >
        Correct this junction on image
      </button>
      {selected && selection.editing && (
        <p role="status">
          Click the visible junction in the original photograph, or enter source
          pixel coordinates below.
        </p>
      )}
      <label style={{ display: "block" }}>
        Junction kind{" "}
        <select
          aria-label={`Junction kind ${o.expectedConductorObjectId}`}
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="housing_entry">
            Housing entry · hidden contact unlocated
          </option>
          <option value="exposed_contact">
            Actual exposed conductive contact
          </option>
        </select>
      </label>
      <label>
        X{" "}
        <input
          aria-label={`Junction X ${o.expectedConductorObjectId}`}
          type="number"
          min={0}
          value={point?.[0] ?? x}
          onChange={(e) => {
            setX(e.target.value);
            if (selected && selection.position)
              setY(String(selection.position[1]));
            if (selected) setSelection(null);
          }}
          style={{ width: 75 }}
        />
      </label>
      <label>
        Y{" "}
        <input
          aria-label={`Junction Y ${o.expectedConductorObjectId}`}
          type="number"
          min={0}
          value={point?.[1] ?? y}
          onChange={(e) => {
            setY(e.target.value);
            if (selected && selection.position)
              setX(String(selection.position[0]));
            if (selected) setSelection(null);
          }}
          style={{ width: 75 }}
        />
      </label>
      <label style={{ display: "block" }}>
        Reviewer{" "}
        <input
          aria-label={`Junction reviewer ${o.expectedConductorObjectId}`}
          value={reviewer}
          onChange={(e) => setReviewer(e.target.value)}
        />
      </label>
      <label style={{ display: "block" }}>
        Evidence note{" "}
        <textarea
          aria-label={`Junction evidence note ${o.expectedConductorObjectId}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <label style={{ display: "block" }}>
        <input
          type="checkbox"
          checked={original}
          onChange={(e) => setOriginal(e.target.checked)}
        />{" "}
        I reviewed the original photograph
      </label>
      <label style={{ display: "block" }}>
        <input
          type="checkbox"
          checked={visible}
          onChange={(e) => setVisible(e.target.checked)}
        />{" "}
        This kind of junction is visibly supported
      </label>
      <button
        type="button"
        className="button button-secondary"
        disabled={
          !allowed ||
          !visible ||
          !point ||
          o.visibility !== "visible" ||
          kind !== o.kind ||
          JSON.stringify(point) !== JSON.stringify(o.position)
        }
        onClick={() => send("confirm")}
      >
        Confirm visible association
      </button>
      <button
        type="button"
        className="button button-secondary"
        disabled={!allowed || !visible || !point}
        onClick={() => send("correct")}
      >
        Save junction correction
      </button>
      <button
        type="button"
        className="button button-secondary"
        disabled={!allowed}
        onClick={() => send("unknown")}
      >
        Mark junction unknown
      </button>
    </div>
  );
}
export function ConnectorJunctionOverlays({
  records,
  image,
  onSelect,
}: {
  records: JunctionRecord[];
  image: { width: number; height: number };
  onSelect: (id: string) => void;
}) {
  const { selection, setSelection } = useContext(JunctionContext);
  if (!records.length) return null;
  return (
    <svg
      aria-label="Connector junction markers"
      viewBox={`0 0 ${image.width} ${image.height}`}
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: selection?.editing ? "auto" : "none",
        zIndex: selection?.editing ? 250 : 205,
      }}
      onPointerDown={(e) => {
        if (selection?.editing) e.stopPropagation();
      }}
      onClick={(e) => {
        if (!selection?.editing) return;
        e.stopPropagation();
        const svg = e.currentTarget,
          matrix = svg.getScreenCTM();
        if (!matrix) return;
        const p = svg.createSVGPoint();
        p.x = e.clientX;
        p.y = e.clientY;
        const local = p.matrixTransform(matrix.inverse());
        setSelection({
          ...selection,
          position: [
            Math.max(0, Math.min(image.width - 1, Math.round(local.x))),
            Math.max(0, Math.min(image.height - 1, Math.round(local.y))),
          ],
          editing: false,
        });
      }}
    >
      {records.flatMap((r) =>
        r.effectiveOutcomes
          .filter((o) => o.position)
          .map((o) => (
            <g
              key={o.id}
              role="button"
              tabIndex={0}
              aria-label={`Inspect junction ${o.expectedConductorObjectId}`}
              style={{
                pointerEvents: selection?.editing ? "none" : "auto",
                cursor: "pointer",
              }}
              onClick={(e) => {
                if (selection?.editing) return;
                e.stopPropagation();
                onSelect(r.plan.connectorObjectId);
                setSelection({
                  planId: r.plan.planId,
                  outcomeId: o.id,
                  position: o.position,
                  editing: false,
                });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onSelect(r.plan.connectorObjectId);
                  setSelection({
                    planId: r.plan.planId,
                    outcomeId: o.id,
                    position: o.position,
                    editing: false,
                  });
                }
              }}
            >
              <circle
                cx={o.position![0]}
                cy={o.position![1]}
                r={5}
                fill={
                  o.associationStatus === "confirmed" ? "#15803d" : "#d97706"
                }
                stroke="white"
                strokeWidth={1}
              >
                <title>{`${o.kind}: ${o.associationStatus}. Hidden contacts remain unlocated.`}</title>
              </circle>
            </g>
          )),
      )}
      {selection?.position && (
        <circle
          cx={selection.position[0]}
          cy={selection.position[1]}
          r={7}
          fill="none"
          stroke="#0070c0"
          strokeWidth={2}
        />
      )}
    </svg>
  );
}
