import { useState } from "react";
import type { AnalysisJob } from "@/lib/analysis-jobs";
import type { SceneGraph } from "@/lib/scene";
import type { SceneAction } from "./scene-objects";
import type { AutomaticTargetingRecord } from "@/lib/connector-workflow";
const lacksImprovedCues = (r: AutomaticTargetingRecord) =>
  r.algorithmVersion === "automatic-targeting-v2" &&
  !r.arms.some((a) => a.name !== "A-inventory-box-v2" && a.prompt !== null);

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
  const [targetingVersion, setTargetingVersion] = useState<"v1" | "v2">("v1");
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
      <label>
        Targeting protocol{" "}
        <select
          aria-label="Targeting protocol"
          value={targetingVersion}
          onChange={(e) => setTargetingVersion(e.target.value as "v1" | "v2")}
        >
          <option value="v1">Original A/B protocol</option>
          <option value="v2">V2 mask-aware and body-cue experiment</option>
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
              ...(targetingVersion === "v2" ? { targetingVersion: "v2" } : {}),
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
          {r.targetingDiagnostics && (
            <details>
              <summary>V2 automatic cue diagnostics</summary>
              <p>
                Eligible baseline masks:{" "}
                {r.targetingDiagnostics.eligibleBaselineMasks}. Body cue:{" "}
                {r.targetingDiagnostics.bodyProposal.status} (
                {r.targetingDiagnostics.bodyProposal.reason.replaceAll(
                  "_",
                  " ",
                )}
                ). The body box remains an unconfirmed proposal.
              </p>
              {r.targetingDiagnostics.bodyProposal.pixelDiagnostics && (
                <p>
                  Dark pixels in target:{" "}
                  {
                    r.targetingDiagnostics.bodyProposal.pixelDiagnostics
                      .darkPixels
                  }
                  ; excluded by reviewed masks:{" "}
                  {
                    r.targetingDiagnostics.bodyProposal.pixelDiagnostics
                      .excludedByNativeMasks
                  }
                  ; excluded by uncertain boxes:{" "}
                  {
                    r.targetingDiagnostics.bodyProposal.pixelDiagnostics
                      .excludedByUncertainBoxes
                  }
                  ; remaining:{" "}
                  {
                    r.targetingDiagnostics.bodyProposal.pixelDiagnostics
                      .remainingDarkPixels
                  }
                  .
                </p>
              )}
              <p>
                Body positives: {r.targetingDiagnostics.bodyProposal.positivePoints.length}
                {r.targetingDiagnostics.bodyProposal.mergedComponentPixels
                  ? ` (merged ${r.targetingDiagnostics.bodyProposal.mergedComponentPixels} adjacent compact dark pixels)`
                  : ""}
                . Negative points:{" "}
                {
                  r.targetingDiagnostics.negativeCues.filter(
                    (n) =>
                      !n.source || n.source === "reviewed_conductor_mask",
                  ).length
                }{" "}
                from reviewed conductor masks,{" "}
                {
                  r.targetingDiagnostics.negativeCues.filter(
                    (n) => n.source === "saturated_red_pixels",
                  ).length
                }{" "}
                from saturated-red lead pixels
                {r.targetingDiagnostics.chromaticCue &&
                r.targetingDiagnostics.chromaticCue.status === "abstained"
                  ? ` (red cue abstained: ${r.targetingDiagnostics.chromaticCue.reason.replaceAll("_", " ")})`
                  : ""}
                ,{" "}
                {
                  r.targetingDiagnostics.negativeCues.filter(
                    (n) =>
                      n.source === "bright_neutral_surface" ||
                      n.source === "chromatic_host_surface",
                  ).length
                }{" "}
                from neighbouring surfaces beside the body
                {r.targetingDiagnostics.keepRing
                  ? `. Scoring keep-ring: dark crop pixels plus ${r.targetingDiagnostics.keepRing.haloPx} px`
                  : ""}
                {r.targetingDiagnostics.surfaceCues?.some(
                  (c) => c.status === "abstained",
                )
                  ? ` (abstained: ${r.targetingDiagnostics.surfaceCues
                      .filter((c) => c.status === "abstained")
                      .map(
                        (c) =>
                          `${c.source.replace("_surface", "").replaceAll("_", " ")} ${c.reason.replaceAll("_", " ")}`,
                      )
                      .join("; ")})`
                  : ""}
                . Uncertain neighbor-box exclusions:{" "}
                {
                  r.targetingDiagnostics.exclusions.filter(
                    (e) => e.mode === "uncertain_bbox",
                  ).length
                }
                ; boxes covering most of the target, reported but not stamped:{" "}
                {
                  r.targetingDiagnostics.exclusions.filter(
                    (e) => e.mode === "colocated_box_not_stamped",
                  ).length
                }
                .
              </p>
              <ul>
                {r.targetingDiagnostics.baseline.map((o) => (
                  <li key={o.observationId}>
                    Observation {o.observationId.slice(0, 8)}:{" "}
                    {o.reasons.join(", ").replaceAll("_", " ") || "eligible"};{" "}
                    {o.eligibleInteriorPixels} eligible interior pixels;{" "}
                    {o.pixelRejections.uncertainNeighborBox} blocked by
                    uncertain boxes.
                  </li>
                ))}
              </ul>
              <p>
                V2 compares all three declared strategies; only the body-aware
                arm is required to meet mask quality thresholds. An arm counts
                as compared when it was measured or when this frozen plan
                records a reasoned abstention for it; a planned arm that never
                ran remains incomplete. Frozen references carry a 2 px
                boundary band moved to uncertain. Provisional or non-blinded
                references cannot establish independent acceptance.
              </p>
            </details>
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
            {r.algorithmVersion ? "Baseline interior point" : "Interior point"}:{" "}
            {r.pointStatus}.{" "}
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
              {lacksImprovedCues(r) && (
                <p>
                  No improved targeting cue is supported. Execution is blocked;
                  inspect the abstention diagnostics before spending another
                  request.
                </p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={approved[r.workflowId] ?? false}
                  disabled={lacksImprovedCues(r)}
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
                disabled={
                  busy || !approved[r.workflowId] || lacksImprovedCues(r)
                }
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
              Evaluation: {r.evaluation.status};{" "}
              {r.algorithmVersion ? "three-strategy" : "A/B"} comparison{" "}
              {r.evaluation.abComparison}; {r.evaluation.validMaskArms}/
              {r.evaluation.plannedStrategyCount}
              strategies returned masks. Pixel success rate:{" "}
              {r.evaluation.successRate === null
                ? "unavailable"
                : `${r.evaluation.successRate * 100}%`}
              .{" "}
              {r.evaluation.independentGroundTruth
                ? "Independent reviewed reference registered."
                : "No independently validated photographic result in the original frozen protocol; retrospective results are shown separately below."}
            </p>
          )}
          <p>
            Connector boundary gate:{" "}
            {job?.connectorValidation?.gates.find(
              (g) => g.objectId === r.objectId,
            )?.status ?? "not recorded"}
            .
          </p>
          <p>
            <a
              href={`/reference/${r.analysisId}/${r.workflowId}`}
              target="_blank"
              rel="noreferrer"
            >
              Annotate original photograph without prediction overlays
            </a>
          </p>
          <p>
            Declare prior prediction exposure. Non-blinded human references
            receive diagnostic scores but cannot unlock independent validation.
          </p>
          {job?.connectorValidation?.references
            .filter((ref) => ref.objectId === r.objectId)
            .map((ref) => (
              <div key={ref.referenceHash}>
                <p>
                  Reference version {ref.annotationVersion}:{" "}
                  {ref.independent
                    ? "blinded independent human reference"
                    : ref.source === "human_review" &&
                        ref.predictionExposure === "seen_before"
                      ? "non-blinded human reference"
                      : "provisional reference"}
                  .
                </p>
                {onAction && (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() =>
                      onAction("evaluate-connector-reference", {
                        workflowId: r.workflowId,
                        referenceHash: ref.referenceHash,
                      })
                    }
                  >
                    {r.algorithmVersion
                      ? "Evaluate saved body-aware mask against reference"
                      : "Evaluate saved A mask against reference"}
                  </button>
                )}
              </div>
            ))}
          {job?.connectorValidation?.evaluations
            .filter((e) => e.workflowId === r.workflowId)
            .map((e) => (
              <p key={e.evaluationId}>
                {e.protocolVersion
                  ? "Retrospective v2 validation"
                  : "Retrospective A validation"}
                : {e.status}; comparison {e.abComparison}.{" "}
                {e.metrics
                  .map(
                    (m) =>
                      `IoU ${m.iou.toFixed(3)}, recall ${m.recall.toFixed(3)}, precision ${m.precision?.toFixed(3) ?? "undefined"}, red leakage ${m.redWireLeakage?.toFixed(3) ?? "undefined"}, black leakage ${m.blackWireLeakage?.toFixed(3) ?? "undefined"}, identity ${m.identityCorrectness}.`,
                  )
                  .join(" ")}
              </p>
            ))}
          <a
            href={`/api/analyses/${r.analysisId}/connector-validation-evidence?workflowId=${r.workflowId}`}
            download
          >
            Download reference and prediction evidence
          </a>
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
