import { useState } from "react";
import {
  calibrationResiduals,
  auditIsCurrent,
  type CalibrationAudit,
} from "@/lib/breadboard/validation";
import type { Point } from "@/lib/breadboard/calibration";
import type { CalibratedBoard } from "@/lib/wires/assignments";

interface Props {
  photoId: string;
  boards: CalibratedBoard[];
  activeBoard: CalibratedBoard | null;
  audits: CalibrationAudit[];
  activeAuditId: string | null;
  target: string;
  disabled: boolean;
  onStart: () => void;
  onTarget: (hole: string) => void;
  onMark: (point: Point) => void;
  onFinish: () => void;
  onRemove: (auditId: string, holeId: string) => void;
}
export function CalibrationValidationPanel(props: Props) {
  const [x, setX] = useState(""),
    [y, setY] = useState("");
  const active = props.audits.find((audit) => audit.id === props.activeAuditId);
  return (
    <section
      className="endpoint-review"
      aria-label="Independent calibration validation"
    >
      <h3>Independent calibration validation</h3>
      <p>
        Mark additional physical hole centers with all projected overlays
        hidden. Marks are raw pixels, never snapped. Use holes other than the
        four calibration anchors or previous endpoint corrections. This measures
        error; it does not change calibration.
      </p>
      <button
        type="button"
        className="button button-secondary"
        disabled={props.disabled || !props.activeBoard || !!active}
        onClick={props.onStart}
      >
        Start blinded calibration check
      </button>
      {active && (
        <div>
          <p role="status">
            All overlays hidden · {active.boardId} · revision {active.revision}.
            Choose a hole label, then mark its physical center on the
            photograph.
          </p>
          {!auditIsCurrent(active, props.photoId, props.boards) && (
            <p role="alert">
              This validation is stale. Finish and start a check for the current
              calibration.
            </p>
          )}
          <label>
            Checkpoint hole{" "}
            <input
              value={props.target}
              onChange={(event) => props.onTarget(event.target.value)}
              placeholder="b12"
            />
          </label>
          <form
            className="pixel-entry"
            onSubmit={(event) => {
              event.preventDefault();
              if (x.trim() && y.trim())
                props.onMark({ x: Number(x), y: Number(y) });
            }}
          >
            <label>
              Checkpoint X{" "}
              <input
                type="number"
                step="any"
                required
                value={x}
                onChange={(event) => setX(event.target.value)}
              />
            </label>
            <label>
              Checkpoint Y{" "}
              <input
                type="number"
                step="any"
                required
                value={y}
                onChange={(event) => setY(event.target.value)}
              />
            </label>
            <button
              className="button button-secondary"
              disabled={
                props.disabled ||
                !auditIsCurrent(active, props.photoId, props.boards)
              }
            >
              Record raw checkpoint
            </button>
          </form>
          <button
            type="button"
            className="button button-primary"
            onClick={props.onFinish}
          >
            Finish blinded calibration check
          </button>
        </div>
      )}
      {props.audits.map((audit) => {
        const current = auditIsCurrent(audit, props.photoId, props.boards),
          report = calibrationResiduals(audit.checkpoints);
        return (
          <details key={audit.id} open={!!report && !active}>
            <summary>
              {audit.boardId} · revision {audit.revision} ·{" "}
              {audit.checkpoints.length} independent marks ·{" "}
              {current ? "current" : "stale"}
            </summary>
            {active ? (
              <p>Residuals stay hidden until collection finishes.</p>
            ) : (
              report && (
                <>
                  <p>
                    Mean shift: ({report.meanResidual.x.toFixed(2)},{" "}
                    {report.meanResidual.y.toFixed(2)}) px · RMS:{" "}
                    {report.rmsPx.toFixed(2)} px · Median:{" "}
                    {report.medianPx.toFixed(2)} px · P95:{" "}
                    {report.p95Px.toFixed(2)} px · Maximum:{" "}
                    {report.maxPx.toFixed(2)} px
                  </p>
                  <p>
                    Compare direction and magnitude across regions before
                    deciding whether error is systematic, local, or perspective
                    dependent. These measurements do not automatically classify
                    or correct it.
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>Hole</th>
                        <th>dx / dy (observed − projected)</th>
                        <th>Error</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {audit.checkpoints.map((point) => (
                        <tr key={point.holeId}>
                          <td>{point.holeId}</td>
                          <td>
                            {point.residual.x.toFixed(2)} /{" "}
                            {point.residual.y.toFixed(2)} px
                          </td>
                          <td>{point.errorPx.toFixed(2)} px</td>
                          <td>
                            <button
                              type="button"
                              onClick={() =>
                                props.onRemove(audit.id, point.holeId)
                              }
                            >
                              Remove checkpoint {point.holeId}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <details>
                    <summary>
                      Inspect calibration residuals and regional measurements
                    </summary>
                    <pre>
                      {JSON.stringify({ audit, report, current }, null, 2)}
                    </pre>
                  </details>
                </>
              )
            )}
          </details>
        );
      })}
    </section>
  );
}
