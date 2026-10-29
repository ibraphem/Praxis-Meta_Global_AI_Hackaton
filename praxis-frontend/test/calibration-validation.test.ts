import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calibrateBoard,
  project,
  terminalHoles,
} from "../lib/breadboard/calibration";
import { replaceBoard } from "../lib/wires/assignments";
import {
  startCalibrationAudit,
  markCalibrationCheckpoint,
  calibrationResiduals,
  auditIsCurrent,
} from "../lib/breadboard/validation";
const board = replaceBoard(
  undefined,
  calibrateBoard("board_1", 30, { width: 1000, height: 1000 }, [
    { x: 50, y: 50 },
    { x: 160, y: 50 },
    { x: 160, y: 340 },
    { x: 50, y: 340 },
  ]),
);
const center = (id: string) =>
  project(
    board.calibration,
    terminalHoles(board.calibration).find((hole) => hole.id === id)!.grid,
  );

test("independent marks remain unsnapped, retain signed residuals and never alter calibration", () => {
  const before = JSON.stringify(board),
    original = startCalibrationAudit("audit", "photo", board),
    predicted = center("b12");
  const audit = markCalibrationCheckpoint(original, "b12", {
    x: predicted.x + 3,
    y: predicted.y - 2,
  });
  assert.deepEqual(audit.checkpoints[0].residual, { x: 3, y: -2 });
  assert.equal(audit.checkpoints[0].source, "independent_raw_mark");
  assert.equal(audit.checkpoints[0].observed.x, predicted.x + 3);
  assert.equal(original.checkpoints.length, 0);
  assert.equal(JSON.stringify(board), before);
  assert.throws(
    () => markCalibrationCheckpoint(audit, "b12", predicted),
    /already/,
  );
});

test("calibration summaries expose directional and regional error without diagnosing or fitting automatically", () => {
  let audit = startCalibrationAudit("audit", "photo", board);
  for (const id of ["b2", "e15", "g29"]) {
    const p = center(id);
    audit = markCalibrationCheckpoint(audit, id, { x: p.x + 3, y: p.y - 2 });
  }
  const summary = calibrationResiduals(audit.checkpoints)!;
  assert.deepEqual(summary.meanResidual, { x: 3, y: -2 });
  assert.ok(Math.abs(summary.rmsPx - Math.sqrt(13)) < 1e-10);
  assert.ok(summary.regional.slice(0, 3).every((region) => region.count === 1));
  assert.equal(calibrationResiduals([]), null);
  assert.equal(auditIsCurrent(audit, "photo", [board]), true);
  assert.equal(auditIsCurrent(audit, "other", [board]), false);
  assert.equal(
    auditIsCurrent(audit, "photo", [replaceBoard(board, board.calibration)]),
    false,
  );
});

test("anchors, nonexistent holes and invalid raw positions cannot masquerade as independent checks", () => {
  const audit = startCalibrationAudit("audit", "photo", board);
  for (const id of ["a1", "j1", "a30", "j30"])
    assert.throws(
      () => markCalibrationCheckpoint(audit, id, center(id)),
      /additional/,
    );
  for (const id of ["a31", "R1:2", "n12"])
    assert.throws(() =>
      markCalibrationCheckpoint(audit, id, { x: 100, y: 100 }),
    );
  for (const point of [
    { x: NaN, y: 100 },
    { x: -1, y: 100 },
    { x: 1000, y: 100 },
  ])
    assert.throws(() => markCalibrationCheckpoint(audit, "b12", point));
});
