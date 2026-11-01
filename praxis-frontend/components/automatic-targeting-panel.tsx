import { useState } from "react";
import type { AnalysisJob } from "@/lib/analysis-jobs";
import type { SceneGraph } from "@/lib/scene";
import type { SceneAction } from "./scene-objects";

export function AutomaticTargetingPanel({
  job,
  graph,
  busy,
  onAction,
}: {
  job?: AnalysisJob | null;
  graph: SceneGraph;
  busy: boolean;
  onAction?: ((action: SceneAction, payload: unknown) => void) | undefined;
}) {
  const [target, setTarget] = useState("");
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [identity, setIdentity] = useState<
    Record<string, "correct" | "incorrect" | "uncertain">
  >({});
  const [reference, setReference] = useState<unknown>(undefined);
  const [referenceError, setReferenceError] = useState("");
  const binding = job?.scene?.snapshotRef;
  const inventory = new Set(
    graph.associations
      .filter((a) => a.basis === "inventory")
      .map((a) => a.objectId),
  );
  const connectors = graph.objects.filter(
    (o) => o.category === "connector" && inventory.has(o.id),
  );
  const selected =
    connectors.find((o) => o.id === target)?.id ?? connectors[0]?.id;
  const records = job?.automaticTargeting ?? [];
  return (
    <section aria-label="Automatic connector targeting">
      <h3>Automatic connector targeting</h3>
      <p>
        Prepare an experiment from saved inventory and baseline mask evidence.
        Preparation sends no inference. An interior-point strategy abstains when
        evidence is insufficient.
      </p>
      <label>
        Connector target{" "}
        <select
          aria-label="Automatic connector target"
          value={selected ?? ""}
          onChange={(e) => setTarget(e.target.value)}
        >
          {connectors.map((o) => (
            <option key={o.id} value={o.id}>
              {o.proposedType}
            </option>
          ))}
        </select>
      </label>
      <details>
        <summary>Register a frozen pixel reference (optional)</summary>
        <p>
          Independent reviewed connector and conductor masks must be registered
          before execution for pixel quality scoring. Sparse points and boxes
          cannot supply these scores.
        </p>
        <input
          aria-label="Frozen connector pixel reference"
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            setReference(undefined);
            setReferenceError("");
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 8 * 1024 * 1024) {
              setReferenceError("Use a reference JSON under 8 MB.");
              return;
            }
            try {
              setReference(JSON.parse(await file.text()));
            } catch {
              setReferenceError("The reference must be valid JSON.");
            }
          }}
        />
        {referenceError && <p role="alert">{referenceError}</p>}
        {reference !== undefined && (
          <p>
            Reference selected. The server will validate its target, provenance
            and coordinates.
          </p>
        )}
      </details>
      {binding && onAction && (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy || !selected}
          onClick={() =>
            onAction("prepare-automatic-targeting", {
              objectId: selected,
              snapshotId: binding.snapshotId,
              snapshotHash: binding.snapshotHash,
              ...(reference !== undefined ? { reference } : {}),
            })
          }
        >
          Prepare automatic connector test
        </button>
      )}
      <p>
        Production guided allowance: {job?.scene?.settings?.maxRequests ?? 0}{" "}
        requests. Experiment limits are separate: at most three requests and six
        million crop pixels. Each prepared plan shows its actual request count.
      </p>
      {records.map((r) => (
        <details key={r.workflowId} open>
          <summary>
            {graph.objects.find((o) => o.id === r.objectId)?.proposedType ??
              "Connector"}{" "}
            · {r.status} · {r.phase.replaceAll("_", " ")}
          </summary>
          {r.executionError && (
            <p role="alert">
              Execution error: {r.executionError}. The spent plan cannot be
              replayed.
            </p>
          )}
          {r.protocol && (
            <p>
              Frozen criteria: IoU ≥ {r.protocol.thresholds.minimumIoU},
              connector recall ≥ {r.protocol.thresholds.minimumRecall},
              conductor leakage ≤{" "}
              {r.protocol.thresholds.maximumConductorLeakage * 100}%, and
              correct target identity. Reference:{" "}
              {r.referenceStatus?.replaceAll("_", " ")}.
            </p>
          )}
          <small style={{ overflowWrap: "anywhere" }}>
            Plan {r.workflowId}
          </small>
          <p>
            {r.budget.plannedRequests} planned SAM request(s) ·{" "}
            {r.budget.plannedPixels.toLocaleString()} pixels ·{" "}
            {r.providerBaseUrl} · {r.model}. Zero Muse requests and no retries.
          </p>
          <p>
            Reserved {r.accounting.reservedRequests}; dispatch attempts{" "}
            {r.accounting.dispatchAttempts}; responses recorded{" "}
            {r.accounting.responsesRecorded}; unknown usage{" "}
            {r.accounting.unknownUsageRequests}. Provider-confirmed usage and
            billed cost: unavailable.
          </p>
          <p>
            Interior point: {r.pointStatus}.{" "}
            {r.pointCues
              .map(
                (p) =>
                  `Baseline observation ${p.observationId}, position [${p.point.join(", ")}].`,
              )
              .join(" ")}
          </p>
          {r.arms.map((a) => (
            <p key={a.name}>
              {a.name}: {a.status}. {a.reason}
            </p>
          ))}
          {r.status === "prepared" && onAction && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={approved[r.workflowId] ?? false}
                  onChange={(e) =>
                    setApproved({
                      ...approved,
                      [r.workflowId]: e.target.checked,
                    })
                  }
                />
                Authorize sending these saved photograph crops to{" "}
                {r.providerBaseUrl}: {r.budget.plannedRequests} SAM request(s),{" "}
                {r.budget.plannedPixels.toLocaleString()} pixels, no retries.
              </label>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || !approved[r.workflowId]}
                onClick={() =>
                  onAction("run-automatic-targeting", {
                    workflowId: r.workflowId,
                    authorizeInference: true,
                    providerBaseUrl: r.providerBaseUrl,
                    requests: r.budget.plannedRequests,
                    pixels: r.budget.plannedPixels,
                  })
                }
              >
                Run prepared connector test
              </button>
            </>
          )}
          {r.status === "interrupted" && onAction && (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() =>
                onAction("release-automatic-targeting", {
                  workflowId: r.workflowId,
                })
              }
            >
              Release interrupted reservation without retry
            </button>
          )}
          {binding &&
            onAction &&
            ["released", "failed", "completed"].includes(r.status) && (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() =>
                  onAction("prepare-automatic-targeting", {
                    objectId: r.objectId,
                    snapshotId: binding.snapshotId,
                    snapshotHash: binding.snapshotHash,
                    replacementOf: r.workflowId,
                    authorizeReplacement: true,
                    ...(reference !== undefined ? { reference } : {}),
                  })
                }
              >
                Prepare separately authorized replacement
              </button>
            )}
          {r.experimentId &&
            !["running", "starting"].includes(r.status) &&
            onAction && (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() =>
                  onAction("evaluate-automatic-targeting", {
                    workflowId: r.workflowId,
                    reviews: r.measurements.flatMap((m) =>
                      m.observationIds
                        .filter((id) => identity[id])
                        .map((observationId) => ({
                          observationId,
                          decision: identity[observationId],
                          source: "human_review",
                          reviewedAt: Date.now(),
                        })),
                    ),
                  })
                }
              >
                Record offline mask evaluation
              </button>
            )}
          {r.evaluationError && (
            <p role="alert">
              Latest evaluation failed: {r.evaluationError}. Execution and
              previous evidence are preserved.
            </p>
          )}
          {r.evaluation && (
            <p>
              Evaluation: {r.evaluation.status}; A/B comparison{" "}
              {r.evaluation.abComparison}; {r.evaluation.validMaskArms}/2
              strategies returned masks. Pixel success rate:{" "}
              {r.evaluation.successRate === null
                ? "unavailable"
                : `${r.evaluation.successRate * 100}%`}
              .{" "}
              {r.evaluation.independentGroundTruth
                ? "Independent reviewed reference registered."
                : "No independently validated photographic result."}
            </p>
          )}
          {r.measurements.map((m) => (
            <div key={m.requestId}>
              <p>
                {m.variant}: {m.status} · provider {m.providerOutcome} ·{" "}
                {m.wallMs === null ? "unfinished" : `${m.wallMs} ms`} ·{" "}
                {m.maskCount} mask(s).
              </p>
              {m.observationIds.map((id) => (
                <label key={id}>
                  Recorded identity:{" "}
                  {r.evaluation?.armResults
                    .flatMap((a) => a.maskMetrics)
                    .find((m) => m.observationId === id)?.identityCorrectness ??
                    "unreviewed"}
                  . New decision for {id}
                  <select
                    aria-label={`Mask identity ${id}`}
                    value={identity[id] ?? ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value)
                        setIdentity({
                          ...identity,
                          [id]: value as "correct" | "incorrect" | "uncertain",
                        });
                      else {
                        const next = { ...identity };
                        delete next[id];
                        setIdentity(next);
                      }
                    }}
                  >
                    <option value="">Keep recorded decision</option>
                    <option value="correct">Correct target</option>
                    <option value="incorrect">Wrong target</option>
                    <option value="uncertain">Uncertain</option>
                  </select>
                </label>
              ))}
              {m.previews
                .filter((o) => o.mask)
                .map((o) => (
                  <svg
                    key={o.id}
                    role="img"
                    aria-label={`${m.variant} candidate mask`}
                    viewBox={`0 0 ${graph.image.width} ${graph.image.height}`}
                    style={{
                      width: "100%",
                      maxHeight: 260,
                      background: "#ddd",
                    }}
                  >
                    <image
                      href={`/api/analyses/${r.analysisId}/image`}
                      width={graph.image.width}
                      height={graph.image.height}
                    />
                    <g
                      transform={`translate(${o.bbox[0]} ${o.bbox[1]}) scale(${o.bbox[2] / o.mask!.width} ${o.bbox[3] / o.mask!.height})`}
                    >
                      <path
                        d={o.mask!.path}
                        fill="#7c3aed88"
                        fillRule="evenodd"
                      />
                    </g>
                  </svg>
                ))}
            </div>
          ))}
          <a href={r.evidenceUrl} download>
            Download private experiment evidence
          </a>
          <p>
            Candidate masks require physical identity review. Experiments do not
            merge identities, discover terminals or establish electrical
            connections.
          </p>
        </details>
      ))}
    </section>
  );
}
