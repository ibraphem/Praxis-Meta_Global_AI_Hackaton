"use client";
import { useState } from "react";
import type { AnalysisJob } from "@/lib/analysis-jobs";
import { jobIsActive } from "@/lib/analysis-jobs";
import { latestIdentityReviews } from "@/lib/wire-recovery";
export type RecoveryAction =
  | "audit-wires"
  | "recover-wires"
  | "verify-wire"
  | "wire-identities"
  | "interpret-recovery";
export function WireRecoveryPanel({
  job,
  imageUrl,
  busy,
  onAction,
}: {
  job: AnalysisJob;
  imageUrl: string;
  busy: boolean;
  onAction: (action: RecoveryAction, payload?: unknown) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [note, setNote] = useState(""),
    [uncovered, setUncovered] = useState(true);
  const report = job.recovery?.report,
    disabled = busy || jobIsActive(job) || !!job.experiment,
    current = report
      ? latestIdentityReviews(job.wireIdentities ?? [], report.reportId)
      : [];
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
            reason: {report.stopReason.replaceAll("_", " ")}.
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
            viewBox={`0 0 ${report.image.width} ${report.image.height}`}
            role="img"
            aria-label="Original photograph with selected observed wire evidence"
          >
            <image
              href={imageUrl}
              width={report.image.width}
              height={report.image.height}
            />
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
                disabled || selected.length !== 1 || !selectedCandidate?.mask
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
              </li>
            ))}
          </ul>
          <details>
            <summary>Coverage diagnostics and source provenance</summary>
            <pre>{JSON.stringify(report, null, 2)}</pre>
          </details>
        </>
      )}
    </section>
  );
}
