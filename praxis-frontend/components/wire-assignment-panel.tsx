import {
  endpointOutcomes,
  endpointOutcomeLabels,
} from "@/lib/wires/localization-outcomes";
import { useState } from "react";
import { EndpointRequestTiming } from "./endpoint-request-timing";
import { EndpointResolutionDiagnosticsPanel } from "./endpoint-resolution-diagnostics";
import type { EndpointRequestTiming as RequestTiming } from "@/lib/wires/request-timing";
import { componentLabel } from "@/lib/vision";
import {
  assignmentValidity,
  MAX_ASSIGNMENTS,
  wireCandidate,
  type AssignmentContext,
  type CalibratedBoard,
  type WireAssignment,
  type ManualEndpoint,
} from "@/lib/wires/assignments";
import type { Point } from "@/lib/breadboard/calibration";
import {
  proposalValidity,
  reviewSaveIssue,
  type EndpointIndex,
  type WireEndpointReview,
} from "@/lib/wires/proposals";

export interface EndpointCapture {
  assignmentId: string;
  index: 0 | 1;
}
interface Props {
  context: AssignmentContext;
  selectedWireId: string | null;
  boards: CalibratedBoard[];
  records: WireAssignment[];
  capture: EndpointCapture | null;
  activeBoardId: string | null;
  picking: boolean;
  disabled: boolean;
  pausedReason: string;
  onStart: () => void;
  onPick: (id: string, index: 0 | 1) => void;
  onStop: () => void;
  onRemove: (id: string) => void;
  onBoard: (id: string) => void;
  onPoint: (
    point: Point,
    method: Exclude<ManualEndpoint["inputMethod"], "ai_proposal">,
  ) => void;
  review?: WireEndpointReview;
  proposing?: boolean;
  requestTiming?: RequestTiming;
  onCancelProposal?: () => void;
  proposalError?: string;
  canPropose?: boolean;
  onPropose?: (
    focused?: boolean,
    closeups?: boolean,
    normalized?: boolean,
  ) => void;
  onReviewConfirm?: (index: EndpointIndex) => void;
  onReviewCorrect?: (index: EndpointIndex) => void;
  onReviewUnknown?: (index: EndpointIndex) => void;
  onCorrectionConfirm?: (index: EndpointIndex) => void;
  onCorrectionCancel?: (index: EndpointIndex) => void;
  onReviewSave?: () => void;
  onReopen?: (record: WireAssignment) => void;
  onRefine?: (index: EndpointIndex) => void;
}
export function endpointLabel(endpoint: ManualEndpoint | null) {
  return endpoint
    ? `${endpoint.boardId}:${endpoint.resolution.status === "resolved" ? endpoint.resolution.holeId : "unknown"}`
    : "not assigned";
}

/** Assignment records deliberately remain outside the original detection response. */
export function WireAssignmentPanel(props: Props) {
  const {
    context,
    selectedWireId,
    boards,
    records,
    capture,
    picking,
    disabled,
    pausedReason,
  } = props;
  const [focused, setFocused] = useState(false),
    [closeups, setCloseups] = useState(false),
    [normalized, setNormalized] = useState(false);
  const [x, setX] = useState(""),
    [y, setY] = useState("");
  const candidate = selectedWireId
    ? wireCandidate(context, selectedWireId)
    : null;
  const capturedRecord = records.find(
    (record) => record.id === capture?.assignmentId,
  );
  const captureIsStale =
    !!capturedRecord &&
    assignmentValidity(capturedRecord, context, boards).status === "stale";
  const review = props.review;
  const reviewStale =
    !!review &&
    proposalValidity(review.proposal, context, boards).status === "stale";
  const hasAssignment = records.some(
    (record) =>
      record.wireCandidateId === selectedWireId &&
      assignmentValidity(record, context, boards).status !== "stale",
  );
  const reviewDisabled = disabled || !!pausedReason || reviewStale;
  const saveIssue = review ? reviewSaveIssue(review, context, boards) : null;
  return (
    <section
      className="wire-assignment-panel"
      aria-label="Wire endpoint assignments and AI review"
    >
      <h3>
        Wire endpoints <span>AI-assisted review · manual assignment</span>
      </h3>
      <p>
        Select a segmented wire candidate. Ask Muse for insertion proposals or
        pick positions manually. Praxis resolves pixels through your
        calibration; you review each endpoint independently.
      </p>
      {props.onPropose && (
        <div className="endpoint-actions">
          <label>
            <input
              type="checkbox"
              checked={focused}
              disabled={disabled || props.proposing}
              onChange={(e) => setFocused(e.target.checked)}
            />{" "}
            Focused crop + calibrated grid reference (experiment)
          </label>
          <label>
            <input
              type="checkbox"
              checked={closeups}
              disabled={disabled || props.proposing}
              onChange={(e) => setCloseups(e.target.checked)}
            />{" "}
            Insertion close-ups (one extra request; experiment)
          </label>
          <label>
            <input
              type="checkbox"
              checked={normalized}
              disabled={disabled || props.proposing}
              onChange={(e) => setNormalized(e.target.checked)}
            />{" "}
            Normalized coordinate contract (experiment)
          </label>
          {candidate?.touchesCropBoundary && (
            <p role="status">
              This mask is truncated at a crop edge. Recover its continuation
              before proposing physical insertion points.
            </p>
          )}
          <button
            type="button"
            className="button button-primary"
            disabled={
              disabled ||
              !!pausedReason ||
              !candidate ||
              candidate.touchesCropBoundary ||
              !boards.length ||
              !props.canPropose ||
              props.proposing ||
              hasAssignment ||
              (!!review && !reviewStale)
            }
            onClick={() => props.onPropose?.(focused, closeups, normalized)}
          >
            {props.proposing
              ? "Locating endpoints…"
              : "Propose endpoints with Muse"}
          </button>
          {props.proposing && props.onCancelProposal && (
            <button
              type="button"
              className="button button-secondary"
              onClick={props.onCancelProposal}
            >
              Cancel endpoint request
            </button>
          )}
          <small>
            Your photograph and selected wire are sent when you request
            proposals.
          </small>
        </div>
      )}
      {props.requestTiming && (
        <EndpointRequestTiming
          key={props.requestTiming.id}
          timing={props.requestTiming}
        />
      )}
      {props.proposalError && (
        <p role="alert" className="calibration-notice">
          {props.proposalError}
        </p>
      )}
      {review && (
        <div
          className={`endpoint-review ${reviewStale ? "stale" : ""}`}
          aria-label="AI endpoint review"
        >
          <h4>
            {review.proposal.wireCandidateId.replace(
              "jumper_wire_",
              "Jumper wire ",
            )}{" "}
            · endpoint review
          </h4>
          {review.proposal.spatialConsistency?.status === "review_needed" && (
            <p className="calibration-notice" role="status">
              Spatial review needed:{" "}
              {review.proposal.spatialConsistency.reasons
                .join(", ")
                .replaceAll("_", " ")}
              . Mask proximity is advisory; exposed leads may extend outside the
              insulation mask. Wire identity remains unverified.
            </p>
          )}
          <p className="endpoint-limits">
            Dashed amber: proposed · Green: reviewed · Purple: correction
            preview · Gray squares: junction references · ?: unknown
          </p>
          {review.proposal.localization && (
            <section aria-label="Insertion localization outcomes">
              <p>
                Insertion close-up experiment:{" "}
                {review.proposal.localization.status.replaceAll("_", " ")}
                {review.proposal.localization.errorCode
                  ? ` (${review.proposal.localization.errorCode})`
                  : ""}
              </p>
              <ul>
                {endpointOutcomes(review.proposal).map((outcome, i) => (
                  <li key={i}>
                    Endpoint {i === 0 ? "A" : "B"}:{" "}
                    {endpointOutcomeLabels[outcome]}. Saved coarse insertion:{" "}
                    {review.proposal
                      .localization!.coarseEndpoints[
                        i
                      ].proposedImagePosition?.map((v) => v.toFixed(1))
                      .join(", ") ?? "unknown"}
                    .
                  </li>
                ))}
              </ul>
              <p>
                Coarse predictions are retained for comparison. A failed or
                skipped close-up does not confirm a hole or silently restore a
                coarse prediction.
              </p>
              <details>
                <summary>Localization diagnostics</summary>
                <pre>
                  {JSON.stringify(review.proposal.localization, null, 2)}
                </pre>
              </details>
            </section>
          )}
          {reviewStale && (
            <p role="status">
              Stale — analysis or calibration changed. Historical review
              decisions are retained. Request new proposals to continue.
            </p>
          )}
          <ol>
            {review.endpoints.map((endpoint, index) => {
              const i = index as EndpointIndex;
              const original = endpoint.originalProposal;
              const pending = review.pendingCorrections[i];
              const correcting =
                capture?.assignmentId === review.proposal.id &&
                capture.index === i;
              return (
                <li
                  key={endpoint.role}
                  className={`endpoint-review-item endpoint-${endpoint.reviewStatus}`}
                >
                  <strong>
                    Endpoint {endpoint.role} · {endpoint.reviewStatus}
                  </strong>
                  <p>
                    Insertion proposal:{" "}
                    {original.proposedHole
                      ? `${original.proposedHole.boardId}:${original.proposedHole.holeId} · snap ${original.proposedHole.snapDistancePx.toFixed(1)} px`
                      : "unknown hole"}
                    {original.proposedImagePosition &&
                      ` · pixels (${original.proposedImagePosition.map((coordinate) => coordinate.toFixed(1)).join(", ")})`}
                    {" · "}
                    {original.evidence.replaceAll("_", " ")}
                  </p>
                  {original.resolutionDiagnostics && (
                    <EndpointResolutionDiagnosticsPanel
                      diagnostics={original.resolutionDiagnostics}
                    />
                  )}
                  {props.onRefine && (
                    <details className="refinement-experiment">
                      <summary>Local pixel refinement experiment</summary>
                      <p>
                        This opt-in local experiment examines original image
                        pixels and the selected mask. It can suggest a wire-tip
                        boundary, not verify a physical insertion. Original
                        proposals and reviewed endpoints are preserved.
                      </p>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={
                          reviewDisabled ||
                          original.evidence !== "visible_insertion" ||
                          !original.proposedImagePosition
                        }
                        onClick={() => props.onRefine?.(i)}
                      >
                        Experimentally refine endpoint {endpoint.role}
                      </button>
                      {review.refinementExperiments?.[endpoint.role] && (
                        <>
                          <p role="status">
                            Experiment:{" "}
                            {review.refinementExperiments[
                              endpoint.role
                            ]!.status.replaceAll("_", " ")}{" "}
                            ·{" "}
                            {review.refinementExperiments[
                              endpoint.role
                            ]!.reason.replaceAll("_", " ")}{" "}
                            · insertion unverified
                          </p>
                          <pre>
                            {JSON.stringify(
                              review.refinementExperiments[endpoint.role],
                              null,
                              2,
                            )}
                          </pre>
                        </>
                      )}
                    </details>
                  )}
                  {original.connectorJunctionPosition && (
                    <p>
                      Visible connector junction: (
                      {original.connectorJunctionPosition
                        .map((coordinate) => coordinate.toFixed(1))
                        .join(", ")}
                      ) · reference only, not an insertion hole.
                    </p>
                  )}
                  {original.evidence !== "visible_insertion" && (
                    <p className="endpoint-limits">
                      {["occluded_insertion", "occluded"].includes(
                        original.evidence,
                      )
                        ? "Insertion point is occluded — hole unknown."
                        : "A physical insertion point has not been established — hole unknown."}{" "}
                      Correct it only if you can independently establish the
                      hole, or mark this endpoint unknown.
                    </p>
                  )}
                  {endpoint.reviewStatus !== "proposed" && (
                    <p>
                      Reviewed result:{" "}
                      {endpoint.finalHole
                        ? `${endpoint.finalHole.boardId}:${endpoint.finalHole.holeId}`
                        : "unknown"}{" "}
                      · {endpoint.source?.replaceAll("_", " ")}
                    </p>
                  )}
                  <div className="endpoint-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={reviewDisabled || !original.proposedHole}
                      onClick={() => props.onReviewConfirm?.(i)}
                    >
                      Confirm endpoint {endpoint.role}
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={reviewDisabled}
                      onClick={() => props.onReviewCorrect?.(i)}
                    >
                      Correct endpoint {endpoint.role}
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={reviewDisabled}
                      onClick={() => props.onReviewUnknown?.(i)}
                    >
                      Mark endpoint {endpoint.role} unknown
                    </button>
                  </div>
                  {(pending || correcting) && (
                    <div className="correction-preview" role="status">
                      <p>
                        {pending
                          ? `Correction preview: ${endpointLabel(pending)}. The reviewed endpoint changes only when you confirm.`
                          : "Pick a new position on the photograph or enter pixels below."}
                      </p>
                      <div className="endpoint-actions">
                        <button
                          type="button"
                          className="button button-primary"
                          disabled={
                            reviewDisabled ||
                            pending?.resolution.status !== "resolved"
                          }
                          onClick={() => props.onCorrectionConfirm?.(i)}
                        >
                          Confirm correction {endpoint.role}
                        </button>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => props.onCorrectionCancel?.(i)}
                        >
                          Cancel correction {endpoint.role}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="endpoint-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={
                reviewDisabled ||
                !!saveIssue ||
                !review.dirty ||
                (!!capture && capture.assignmentId === review.proposal.id)
              }
              onClick={props.onReviewSave}
            >
              Save reviewed assignment
            </button>
            <span role="status">
              {saveIssue ??
                (review.dirty
                  ? "Ready to save · electrical contact unknown"
                  : "Review saved · electrical contact unknown")}
            </span>
          </div>
          <details>
            <summary>Inspect original proposal and reviewed values</summary>
            <pre>{JSON.stringify(review, null, 2)}</pre>
          </details>
          <p className="endpoint-limits">
            Reviews are kept for this photograph during this session. Unknown
            endpoints produce incomplete assignments; no reviewed assignment
            verifies electrical contact.
          </p>
        </div>
      )}
      <p className="endpoint-limits">
        Wire identity: unverified · Endpoint locations: user selected ·
        Electrical contact: unknown. Selecting two positions does not verify one
        physical wire or seated connectors.
      </p>
      <div className="endpoint-actions">
        <strong>
          {candidate
            ? componentLabel(candidate)
            : "Select a segmented wire in the results or on the photo."}
        </strong>
        <button
          type="button"
          className="button button-primary"
          disabled={
            disabled ||
            !candidate ||
            !boards.length ||
            !!pausedReason ||
            records.length >= MAX_ASSIGNMENTS ||
            (!!review && !reviewStale)
          }
          onClick={props.onStart}
        >
          Assign wire endpoints
        </button>
      </div>
      {!boards.length && (
        <p>Calibrate a breadboard before assigning insertion positions.</p>
      )}
      {pausedReason && (
        <p className="calibration-notice" role="status">
          {pausedReason}
        </p>
      )}
      {records.length >= MAX_ASSIGNMENTS && (
        <p>Remove an old record to make room for another assignment.</p>
      )}
      {capture && (
        <div className="endpoint-capture">
          <p role="status" aria-live="polite">
            {picking
              ? `Pick endpoint ${capture.index + 1} on the photograph, or enter original-image pixels.`
              : captureIsStale
                ? "This assignment is stale. Stop picking, then start a new assignment for the current analysis and calibration."
                : "Endpoint picking is paused. Resume the record after selecting its wire and completing calibration."}
          </p>
          <div className="endpoint-actions">
            <label>
              Board for this endpoint{" "}
              <select
                value={props.activeBoardId ?? ""}
                disabled={disabled || !picking}
                onChange={(event) => props.onBoard(event.target.value)}
              >
                {boards.map((board) => (
                  <option
                    key={board.calibration.breadboardId}
                    value={board.calibration.breadboardId}
                  >
                    {board.calibration.breadboardId} · revision {board.revision}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button button-secondary"
              onClick={props.onStop}
            >
              Stop picking
            </button>
          </div>
          {picking && (
            <form
              className="pixel-entry"
              onSubmit={(event) => {
                event.preventDefault();
                if (x.trim() && y.trim())
                  props.onPoint({ x: Number(x), y: Number(y) }, "pixel_entry");
              }}
            >
              <label>
                Endpoint X{" "}
                <input
                  type="number"
                  min={0}
                  max={(context.analysis?.image.width ?? 1) - 1}
                  step="any"
                  required
                  value={x}
                  onChange={(event) => setX(event.target.value)}
                  disabled={disabled}
                />
              </label>
              <label>
                Endpoint Y{" "}
                <input
                  type="number"
                  min={0}
                  max={(context.analysis?.image.height ?? 1) - 1}
                  step="any"
                  required
                  value={y}
                  onChange={(event) => setY(event.target.value)}
                  disabled={disabled}
                />
              </label>
              <button className="button button-secondary" disabled={disabled}>
                Set endpoint {capture.index + 1}
              </button>
            </form>
          )}
        </div>
      )}
      <ul className="assignment-records">
        {[...records].reverse().map((record) => {
          const validity = assignmentValidity(record, context, boards);
          return (
            <li
              key={record.id}
              className={`assignment-record ${validity.status}`}
            >
              <div className="assignment-heading">
                <strong>
                  {record.wireCandidateId.replace(
                    "jumper_wire_",
                    "Jumper wire ",
                  )}
                </strong>
                <span>
                  {validity.status === "complete"
                    ? record.endpointReview
                      ? "Reviewed locations · contact unknown"
                      : "Manually assigned"
                    : validity.status === "stale"
                      ? "Stale — invalid"
                      : record.endpointReview
                        ? "Reviewed — incomplete"
                        : "Draft — incomplete"}
                </span>
              </div>
              <p className="assignment-connection">
                {endpointLabel(record.endpoints[0])} →{" "}
                {endpointLabel(record.endpoints[1])}
              </p>
              {validity.status === "stale" && (
                <p>
                  Invalidated:{" "}
                  {validity.reasons
                    .map((reason) => reason.replaceAll("_", " "))
                    .join(", ")}
                  . Historical positions are retained; they are not shown as a
                  current connection.
                </p>
              )}
              <ol>
                {record.endpoints.map((endpoint, index) => (
                  <li key={index}>
                    <span>
                      Endpoint {index + 1}: {endpointLabel(endpoint)}
                      {record.endpointReview
                        ? ` · ${record.endpointReview.endpoints[index].reviewStatus}`
                        : endpoint
                          ? " · manually selected"
                          : ""}
                    </span>
                    {endpoint && (
                      <small>
                        {endpoint.resolution.status === "resolved"
                          ? "Resolved through calibrated grid"
                          : "Unknown hole — no unambiguous grid match"}{" "}
                        · contact unknown · calibration revision{" "}
                        {endpoint.calibrationRevision}
                      </small>
                    )}
                    {!record.endpointReview && (
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={
                          disabled ||
                          validity.status === "stale" ||
                          !!pausedReason
                        }
                        onClick={() => props.onPick(record.id, index as 0 | 1)}
                      >
                        {endpoint ? "Replace" : "Pick"} endpoint {index + 1}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              <div className="endpoint-actions">
                {record.endpointReview && (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={
                      disabled || !!pausedReason || validity.status === "stale"
                    }
                    onClick={() => props.onReopen?.(record)}
                  >
                    Reopen endpoint review
                  </button>
                )}
                <details>
                  <summary>Inspect assignment JSON</summary>
                  <pre>{JSON.stringify({ ...record, validity }, null, 2)}</pre>
                </details>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => props.onRemove(record.id)}
                >
                  Remove record
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
