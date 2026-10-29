import {
  project,
  terminalHoles,
  type Calibration,
  type Point,
} from "./calibration";
import type { CalibratedBoard } from "../wires/assignments";
export interface CalibrationCheckpoint {
  holeId: string;
  observed: Point;
  predicted: Point;
  residual: Point;
  errorPx: number;
  rowRegion: "first_third" | "middle_third" | "last_third";
  strip: "a–e" | "f–j";
  source: "independent_raw_mark";
}
export interface CalibrationAudit {
  id: string;
  photoId: string;
  boardId: string;
  revision: number;
  calibration: Calibration;
  checkpoints: CalibrationCheckpoint[];
  collection: "blinded_unsnapped";
}
export function startCalibrationAudit(
  id: string,
  photoId: string,
  board: CalibratedBoard,
): CalibrationAudit {
  return {
    id,
    photoId,
    boardId: board.calibration.breadboardId,
    revision: board.revision,
    calibration: structuredClone(board.calibration),
    checkpoints: [],
    collection: "blinded_unsnapped",
  };
}
export function auditIsCurrent(
  audit: CalibrationAudit,
  photoId: string,
  boards: CalibratedBoard[],
) {
  return (
    audit.photoId === photoId &&
    boards.some(
      (board) =>
        board.calibration.breadboardId === audit.boardId &&
        board.revision === audit.revision,
    )
  );
}
export function markCalibrationCheckpoint(
  audit: CalibrationAudit,
  holeId: string,
  point: Point,
): CalibrationAudit {
  const id = holeId.trim().toLowerCase();
  const hole = terminalHoles(audit.calibration).find((hole) => hole.id === id);
  if (!hole) throw new Error("Choose an existing terminal hole, such as b12.");
  if (
    [
      "a1",
      "j1",
      `a${audit.calibration.rows}`,
      `j${audit.calibration.rows}`,
    ].includes(id)
  )
    throw new Error("Use additional holes, not the four calibration anchors.");
  const { width, height } = audit.calibration.image;
  if (
    ![point.x, point.y].every(Number.isFinite) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= width ||
    point.y >= height
  )
    throw new Error("Mark a raw position inside this photograph.");
  if (audit.checkpoints.some((checkpoint) => checkpoint.holeId === id))
    throw new Error(
      "This hole already has a checkpoint. Remove it before marking again.",
    );
  const predicted = project(audit.calibration, hole.grid);
  const residual = { x: point.x - predicted.x, y: point.y - predicted.y };
  const checkpoint: CalibrationCheckpoint = {
    holeId: id,
    observed: { ...point },
    predicted,
    residual,
    errorPx: Math.hypot(residual.x, residual.y),
    rowRegion:
      hole.grid.y < audit.calibration.rows / 3
        ? "first_third"
        : hole.grid.y < (2 * audit.calibration.rows) / 3
          ? "middle_third"
          : "last_third",
    strip: id[0] <= "e" ? "a–e" : "f–j",
    source: "independent_raw_mark",
  };
  return { ...audit, checkpoints: [...audit.checkpoints, checkpoint] };
}
export function calibrationResiduals(checkpoints: CalibrationCheckpoint[]) {
  if (!checkpoints.length) return null;
  const errors = checkpoints
      .map((point) => point.errorPx)
      .sort((a, b) => a - b),
    n = errors.length;
  const mean = {
    x: checkpoints.reduce((sum, point) => sum + point.residual.x, 0) / n,
    y: checkpoints.reduce((sum, point) => sum + point.residual.y, 0) / n,
  };
  return {
    count: n,
    meanResidual: mean,
    rmsPx: Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / n),
    medianPx:
      n % 2
        ? errors[Math.floor(n / 2)]
        : (errors[n / 2 - 1] + errors[n / 2]) / 2,
    p95Px: errors[Math.ceil(n * 0.95) - 1],
    maxPx: errors[n - 1],
    regional: ["first_third", "middle_third", "last_third", "a–e", "f–j"].map(
      (region) => {
        const points = checkpoints.filter(
          (point) => point.rowRegion === region || point.strip === region,
        );
        return {
          region,
          count: points.length,
          meanDx: points.length
            ? points.reduce((sum, point) => sum + point.residual.x, 0) /
              points.length
            : null,
          meanDy: points.length
            ? points.reduce((sum, point) => sum + point.residual.y, 0) /
              points.length
            : null,
          rmsPx: points.length
            ? Math.sqrt(
                points.reduce((sum, point) => sum + point.errorPx ** 2, 0) /
                  points.length,
              )
            : null,
        };
      },
    ),
  };
}
