import { useState } from "react";
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
  onPoint: (point: Point, method: ManualEndpoint["inputMethod"]) => void;
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
  return (
    <section
      className="wire-assignment-panel"
      aria-label="Manual wire endpoint assignments"
    >
      <h3>
        Wire endpoints <span>Manual assignment</span>
      </h3>
      <p>
        Select a segmented wire candidate, then pick two visible insertion
        positions. Each endpoint can use a different calibrated board.
      </p>
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
            records.length >= MAX_ASSIGNMENTS
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
                    ? "Manually assigned"
                    : validity.status === "stale"
                      ? "Stale — invalid"
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
                      {endpoint ? " · manually selected" : ""}
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
                  </li>
                ))}
              </ol>
              <div className="endpoint-actions">
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
