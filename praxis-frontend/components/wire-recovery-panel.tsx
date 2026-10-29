"use client";
import { useState } from "react";
import type { AnalysisJob } from "@/lib/analysis-jobs";
import { jobIsActive } from "@/lib/analysis-jobs";
import {
  effectiveIdentityReviews,
  latestIdentityReviews,
} from "@/lib/wire-recovery";
export type RecoveryAction =
  | "audit-wires"
  | "recover-wires"
  | "recover-short-wires"
  | "verify-wire"
  | "wire-identities"
  | "interpret-recovery";
export function WireRecoveryPanel({
  job,
  imageUrl,
  busy,
  onAction,
  recoveryContext,
}: {
  job: AnalysisJob;
  imageUrl: string;
  busy: boolean;
  recoveryContext?: { pitchPx: number; gridPoints: [number, number][] };
  onAction: (action: RecoveryAction, payload?: unknown) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [note, setNote] = useState(""),
    [uncovered, setUncovered] = useState(true),
    [markPoint, setMarkPoint] = useState(false),
    [seed, setSeed] = useState<[number, number] | null>(null),
    [pitch, setPitch] = useState("");
  const report = job.recovery?.report,
    disabled = busy || jobIsActive(job) || !!job.experiment,
    current = report
      ? effectiveIdentityReviews(job.wireIdentities ?? [], report)
      : [];
  const cropAttempts = job.recovery?.cropAttempts ?? [];
  const legacyCount = cropAttempts.length
    ? 0
    : (job.recovery?.visited.length ?? 0);
  const uninspected = cropAttempts.filter((a) => a.status !== "succeeded");
  const explicit = report
    ? latestIdentityReviews(job.wireIdentities ?? [], report.reportId)
    : [];
  const pending = (report?.reviewReconciliation ?? []).filter(
    (l) =>
      l.status === "needs_review" &&
      !explicit.some((r) =>
        r.candidateIds.some((id) => l.candidateIds.includes(id)),
      ),
  );
  const selectedCandidate = report?.candidates.find(
      (c) => c.id === selected[0],
    ),
    model = report?.modelReviews.find((r) => r.candidateId === selected[0]);
  const review = (state: "verified" | "uncertain" | "rejected") => {
    if (report && selected.length)
      onAction("wire-identities", {
        reportId: report.reportId,
        candidateIds: selected,
        state,
        note,
      });
  };
  return (
    <section
      className="wire-recovery-panel"
      aria-label="Wire coverage and identity review"
    >
      <h2>Wire coverage and recovery</h2>
      <p>
        Visual candidates, reviewed physical wires, and electrical connections
        are separate. Coverage is a diagnostic, not proof that every wire was
        found. Re-audit after identity review to update verified coverage.
      </p>
      <div className="analysis-job-actions">
        <button
          className="button button-secondary"
          disabled={disabled || job.sam.status !== "succeeded"}
          onClick={() => onAction("audit-wires")}
        >
          Audit wire coverage
        </button>
        <button
          className="button button-secondary"
          disabled={disabled || !report || report.cropRegions.length === 0}
          onClick={() => onAction("recover-wires")}
        >
          Recover prioritized regions
        </button>
        <button
          className="button button-secondary"
          disabled={disabled || !report}
          onClick={() =>
            onAction("recover-short-wires", {
              pitchPx: Number(
                pitch ||
                  recoveryContext?.pitchPx ||
                  Math.max(2, Math.min(job.image.width, job.image.height) / 80),
              ),
              gridPoints: recoveryContext?.gridPoints ?? [],
            })
          }
        >
          Find short wires automatically
        </button>
        {job.recovery?.snapshotRef && (
          <button
            className="button button-secondary"
            disabled={
              disabled ||
              report?.sourceSnapshotId !==
                job.recovery.snapshotRef.samSnapshotId
            }
            onClick={() => onAction("interpret-recovery")}
          >
            Interpret recovered candidates
          </button>
        )}
      </div>
      <div>
        {recoveryContext && (
          <p>
            Using {recoveryContext.gridPoints.length} calibrated hole references
            as search priors. Share again after recalibration.
          </p>
        )}
        <label>
          Hole spacing in original pixels (search scale only){" "}
          <input
            type="number"
            min="2"
            max="200"
            value={pitch}
            onChange={(e) => setPitch(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={markPoint}
            onChange={(e) => setMarkPoint(e.target.checked)}
          />{" "}
          Mark a missing wire body on the photograph
        </label>
        <button
          className="button button-secondary"
          disabled={disabled || !seed || !report}
          onClick={() =>
            onAction("recover-short-wires", {
              pitchPx: Number(
                pitch ||
                  recoveryContext?.pitchPx ||
                  Math.max(2, Math.min(job.image.width, job.image.height) / 80),
              ),
              gridPoints: recoveryContext?.gridPoints ?? [],
              manualPoint: seed,
            })
          }
        >
          Recover marked wire (user assisted)
        </button>
        {seed && (
          <p>
            Reviewer seed: {seed.join(", ")}. This locates a visual hypothesis
            and does not verify identity or contact.
          </p>
        )}
      </div>
      {job.recovery && (
        <p className="mono">
          SAM crop requests used: {job.recovery.budget.requests} · Crop pixels:{" "}
          {job.recovery.budget.pixels.toLocaleString()} · Muse verification
          requests: {job.recovery.budget.verificationRequests} · Rounds:{" "}
          {job.recovery.budget.rounds}
        </p>
      )}
      {job.recovery?.attempts.at(-1) && (
        <p role="status">
          Latest recovery action:{" "}
          {job.recovery.attempts.at(-1)!.status.replaceAll("_", " ")}
          {job.recovery.attempts.at(-1)!.errorCode
            ? ` (${job.recovery.attempts.at(-1)!.errorCode})`
            : ""}
          . A timeout leaves upstream completion unknown; cached evidence and
          consumed budgets are preserved.
        </p>
      )}
      {(cropAttempts.length > 0 || (job.recovery?.visited.length ?? 0) > 0) && (
        <details open>
          <summary>Crop inspection outcomes</summary>
          <p>
            {cropAttempts.filter((a) => a.status === "succeeded").length}{" "}
            successful crop inspections · {uninspected.length + legacyCount}{" "}
            attempts without a confirmed successful inspection. Previously
            attempted regions are blocked from redispatch; consumed budgets
            remain charged.
          </p>
          {!cropAttempts.length && (
            <p>
              Legacy attempted regions have unknown outcomes; they are not
              confirmed successful inspections.
            </p>
          )}
          <ul>
            {cropAttempts.map((a) => (
              <li key={a.attemptId}>
                Region [{a.region.join(", ")}]: {a.status.replaceAll("_", " ")}
                {a.errorCode ? ` (${a.errorCode})` : ""} · Upstream:{" "}
                {a.upstreamOutcome.replaceAll("_", " ")}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!report ? (
        <p>
          Run an offline coverage audit of the saved SAM checkpoint. This makes
          no model requests.
        </p>
      ) : (
        <>
          <p>
            <strong>
              {report.summary.rawSamCandidates} SAM candidates ·{" "}
              {report.summary.geometryAccepted} pass geometry checks ·{" "}
              {report.summary.cvTraces} classical traces ·{" "}
              {report.summary.uncoveredTraces} unexplained traces
            </strong>
          </p>
          <p>
            {current.filter((r) => r.state === "verified").length}{" "}
            human-verified groups · Electrical connections: unestablished. Stop
            reason:{" "}
            {report.stopReason === "blocked_regions"
              ? "uninspected regions blocked by previous attempts"
              : report.stopReason.replaceAll("_", " ")}
            .
            {report.summary.truncated
              ? " Audit limits were reached; additional traces may remain."
              : ""}
          </p>
          <label>
            <input
              type="checkbox"
              checked={uncovered}
              onChange={(e) => setUncovered(e.target.checked)}
            />{" "}
            Show uncovered trace hypotheses
          </label>
          <svg
            className="wire-recovery-preview"
            onClick={(event) => {
              if (!markPoint || disabled) return;
              const svg = event.currentTarget,
                m = svg.getScreenCTM();
              if (!m) return;
              const p = svg.createSVGPoint();
              p.x = event.clientX;
              p.y = event.clientY;
              const q = p.matrixTransform(m.inverse());
              if (
                q.x >= 0 &&
                q.y >= 0 &&
                q.x < report.image.width &&
                q.y < report.image.height
              )
                setSeed([Math.floor(q.x), Math.floor(q.y)]);
            }}
            viewBox={`0 0 ${report.image.width} ${report.image.height}`}
            role="img"
            aria-label="Original photograph with selected observed wire evidence"
          >
            <image
              href={imageUrl}
              width={report.image.width}
              height={report.image.height}
            />
            {seed && (
              <circle
                cx={seed[0]}
                cy={seed[1]}
                r={Math.max(5, report.image.width / 200)}
                fill="none"
                stroke="#e040fb"
                strokeWidth="3"
              />
            )}
            {report.candidates
              .filter(
                (c) =>
                  selected.includes(c.id) ||
                  (uncovered &&
                    c.source === "cv_trace" &&
                    c.candidateCoverage < 0.8),
              )
              .map((c) => (
                <g key={c.id}>
                  {c.mask ? (
                    <g
                      transform={`translate(${c.bbox[0]} ${c.bbox[1]}) scale(${c.bbox[2] / c.mask.width} ${c.bbox[3] / c.mask.height})`}
                    >
                      <path
                        d={c.mask.path}
                        fill="#f59e0b"
                        fillOpacity="0.2"
                        stroke="#f59e0b"
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  ) : (
                    <polyline
                      points={c.points.map((p) => p.join(",")).join(" ")}
                      fill="none"
                      stroke={selected.includes(c.id) ? "#f59e0b" : "#ff409d"}
                      strokeWidth={Math.max(2, report.image.width / 750)}
                    />
                  )}
                </g>
              ))}
            {model?.endpoints
              .filter((e) => e.position)
              .map((e) => (
                <circle
                  key={e.role}
                  cx={e.position![0]}
                  cy={e.position![1]}
                  r={Math.max(4, report.image.width / 300)}
                  fill="none"
                  stroke="#e040fb"
                  strokeWidth="3"
                />
              ))}
          </svg>
          <div className="wire-recovery-candidates">
            {report.candidates.map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(c.id)}
                  disabled={
                    disabled ||
                    (!selected.includes(c.id) && selected.length >= 8)
                  }
                  onChange={() =>
                    setSelected((ids) =>
                      ids.includes(c.id)
                        ? ids.filter((id) => id !== c.id)
                        : [...ids, c.id],
                    )
                  }
                />
                <strong>{c.id}</strong> · {c.source} ·{" "}
                {c.geometryAccepted
                  ? "passes geometry checks"
                  : c.rejectionReasons.join(", ")}
                {c.source === "cv_trace" && (
                  <span>
                    {" "}
                    · Candidate-covered {Math.round(c.candidateCoverage * 100)}%
                    · Verified-covered {Math.round(c.verifiedCoverage * 100)}%
                  </span>
                )}
                {c.touchesCropBoundary && (
                  <span>
                    {" "}
                    · Truncated at crop boundary; recover continuation
                  </span>
                )}
                {c.touchesImageBoundary && (
                  <span> · Touches photograph boundary</span>
                )}
              </label>
            ))}
          </div>
          <p>
            Amber masks are observed segmentation hypotheses. Pink lines are
            unexplained visual traces. Possible continuations across occlusions
            remain unverified and are never drawn as observed wire pixels.
          </p>
          <label>
            Review note{" "}
            <input
              value={note}
              maxLength={240}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Evidence supporting this identity decision"
            />
          </label>
          <div className="analysis-job-actions">
            <button
              className="button button-secondary"
              disabled={
                disabled ||
                selected.length !== 1 ||
                !selectedCandidate?.mask ||
                selectedCandidate.touchesCropBoundary
              }
              onClick={() =>
                onAction("verify-wire", { candidateId: selected[0] })
              }
            >
              Ask Muse to verify candidate
            </button>
            <button
              className="button button-secondary"
              disabled={disabled || !selected.length}
              onClick={() => review("verified")}
            >
              Verify one physical wire
            </button>
            <button
              className="button button-secondary"
              disabled={disabled || !selected.length}
              onClick={() => review("uncertain")}
            >
              Keep identity uncertain
            </button>
            <button
              className="button button-secondary"
              disabled={disabled || !selected.length}
              onClick={() => review("rejected")}
            >
              Reject candidate group
            </button>
          </div>
          {model && (
            <p role="status">
              Muse proposal: {model.decision.replaceAll("_", " ")}.{" "}
              {model.endpoints
                .map(
                  (e) =>
                    `${e.role}: ${e.position ? e.position.map((n) => n.toFixed(1)).join(", ") : "unknown"} (${e.evidence})`,
                )
                .join(" · ")}
              . These positions do not assign holes or establish a connection.
            </p>
          )}
          <ul>
            {current.map((r) => (
              <li key={r.reviewId}>
                {r.state}: {r.candidateIds.join(" + ")} · {r.note || "No note"}{" "}
                · Electrical connection unestablished
                {r.inheritedFromReportId
                  ? " · Carried from an unchanged prior review"
                  : ""}
              </li>
            ))}
          </ul>
          {pending.length > 0 && (
            <div role="status">
              <p>
                {pending.length} prior identity groups require re-review; their
                verification does not count toward current coverage.
              </p>
              <ul>
                {pending.map((l) => (
                  <li key={l.sourceReviewId}>
                    Needs re-review: {l.sourceCandidateIds.join(" + ")} ·{" "}
                    {l.reason.replaceAll("_", " ")}
                    {l.candidateIds.length
                      ? ` · Current candidates: ${l.candidateIds.join(" + ")}`
                      : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!report.hypotheses.length && (
            <details>
              <summary>Unverified fragment associations</summary>
              <ul>
                {report.hypotheses.map((h, i) => (
                  <li key={i}>
                    {h.candidateIds.join(" + ")} · {h.kind.replaceAll("_", " ")}{" "}
                    · unverified; no bridge or connection established
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!report.shortRegions?.length && (
            <p>
              {report.shortRegions.length} native-resolution spatial prompt
              hypotheses. Selected regions and source are preserved in crop
              diagnostics; dark traces may be shadows or components.
            </p>
          )}
          <details>
            <summary>Coverage diagnostics and source provenance</summary>
            <pre>{JSON.stringify(report, null, 2)}</pre>
          </details>
        </>
      )}
    </section>
  );
}
