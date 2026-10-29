import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calibrateBoard,
  project,
  terminalHoles,
  type Point,
} from "../lib/breadboard/calibration";
import { replaceBoard } from "../lib/wires/assignments";
import { compareRefinement } from "../lib/wires/refinement-evaluation";
import { refinementTerminalSummary } from "../lib/wires/refinement-report";
import type { EvaluationWire } from "../lib/wires/evaluation";
import type { RefinementResult } from "../lib/wires/refinement";
const board = replaceBoard(
  undefined,
  calibrateBoard("board_1", 30, { width: 1000, height: 1000 }, [
    { x: 50, y: 50 },
    { x: 160, y: 50 },
    { x: 160, y: 340 },
    { x: 50, y: 340 },
  ]),
);
const point = (id: string) =>
  project(
    board.calibration,
    terminalHoles(board.calibration).find((hole) => hole.id === id)!.grid,
  );
const a = point("b12"),
  b = point("e14");
const wire = (
  proposals: EvaluationWire["proposals"] = [a, b],
): EvaluationWire => ({
  id: "jumper_wire_1",
  boardId: "board_1",
  holes: ["b12", "e14"],
  proposals,
});
const result = (original: Point, refined: Point): RefinementResult => ({
  method: "color-tip-experiment-v1",
  status: "supported_tip",
  originalPosition: { ...original },
  refinedPosition: { ...refined },
  reason: "synthetic_test_result",
  physicalInsertion: "unverified",
  evidence: {
    contrast: 100,
    componentPixels: 20,
    elongation: 10,
    movementPx: Math.hypot(original.x - refined.x, original.y - refined.y),
  },
  elapsedMs: 1,
});

test("all-endpoints mode runs all ten original points, including eight already-resolved predictions", async () => {
  const wires = Array.from({ length: 5 }, (_, i) => ({
    ...wire(),
    id: `jumper_wire_${i + 1}`,
    proposals: [
      i === 3 ? { x: a.x + 4.5, y: a.y } : { ...a },
      i === 4 ? { x: b.x + 4.5, y: b.y } : { ...b },
    ] as EvaluationWire["proposals"],
  }));
  const snapshot = JSON.stringify({ wires, board });
  let calls = 0;
  const report = await compareRefinement(
    wires,
    [board],
    async (_wire, _index, original) => {
      calls++;
      return result(original, original);
    },
    { allEndpoints: true },
  );
  assert.equal(calls, 10);
  assert.equal(report.experiments.length, 10);
  assert.equal(report.skipped.length, 0);
  assert.equal(report.mode, "all_endpoints");
  assert.equal(report.raw.correct, 8);
  assert.equal(report.raw.completeWires, 3);
  assert.equal(report.refined.correct, 8);
  assert.equal(report.acceptance.passed, false);
  assert.equal(JSON.stringify({ wires, board }), snapshot);
});

test("default mode preserves resolved points; all-endpoints mode exposes rejected correct predictions", async () => {
  let calls = 0;
  const raw = await compareRefinement([wire()], [board], async () => {
    calls++;
    return null;
  });
  assert.equal(calls, 0);
  assert.equal(raw.refined.correct, 2);
  assert.equal(raw.skipped.length, 2);
  const all = await compareRefinement(
    [wire()],
    [board],
    async () => {
      calls++;
      return null;
    },
    { allEndpoints: true },
  );
  assert.equal(calls, 2);
  assert.equal(all.refined.correct, 0);
  assert.equal(all.refined.unresolved, 2);
  assert.equal(all.transitions.correctToUnresolved, 2);
  assert.equal(all.acceptance.noCorrectEndpointRegressions, false);
  assert.equal(all.acceptance.recommendation, "keep_opt_in");
});

test("wrong-hole regressions fail acceptance and cannot be hidden by rematching A/B after refinement", async () => {
  const report = await compareRefinement(
    [wire()],
    [board],
    async (_id, i, original) => result(original, i ? a : b),
    { allEndpoints: true },
  );
  assert.equal(report.refined.correct, 0);
  assert.equal(report.refined.wrong, 2);
  assert.equal(report.transitions.correctToWrong, 2);
  assert.equal(report.acceptance.zeroWrongHoleAssignments, false);
  assert.equal(report.acceptance.passed, false);
});

test("raw-reversed roles are aligned once, and independent pixel references are respected", async () => {
  const observedA = { x: a.x + 1, y: a.y },
    observedB = { x: b.x + 1, y: b.y };
  const input = {
    ...wire([
      { x: b.x + 2, y: b.y },
      { x: a.x + 2, y: a.y },
    ]),
    groundTruthPositions: [observedA, observedB] as [Point, Point],
  };
  const report = await compareRefinement(
    [input],
    [board],
    async (_id, i, original) => result(original, i ? observedA : observedB),
    { allEndpoints: true },
  );
  assert.equal(report.raw.correct, 2);
  assert.equal(report.refined.correct, 2);
  assert.ok(report.endpoints.every((endpoint) => endpoint.truthOrderReversed));
  assert.deepEqual(
    report.endpoints.map((endpoint) => endpoint.truth),
    ["board_1:e14", "board_1:b12"],
  );
  assert.equal(report.localizationError.referenceCounts.independentlyMarked, 2);
  assert.equal(report.localizationError.raw.meanPx, 1);
  assert.equal(report.localizationError.refined.meanPx, 0);
  assert.equal(report.acceptance.localizationImprovement, true);
  assert.equal(report.acceptance.passed, true);
});

test("pixel error can improve without changing strict resolution and with no relaxed thresholds", async () => {
  const input = wire([{ x: a.x + 4.5, y: a.y }, b]);
  const report = await compareRefinement(
    [input],
    [board],
    async (_id, i, original) =>
      result(original, i ? b : { x: a.x + 3.8, y: a.y }),
    { allEndpoints: true },
  );
  assert.equal(report.raw.correct, 1);
  assert.equal(report.refined.correct, 1);
  assert.equal(report.refined.unresolved, 1);
  assert.equal(report.acceptance.resolvedEndpointImprovement, false);
  assert.equal(report.acceptance.localizationImprovement, true);
  assert.equal(report.acceptance.passed, true);
  assert.equal(
    report.localizationError.referenceCounts.calibrationProjected,
    2,
  );
  assert.ok(report.localizationError.paired.meanImprovementPx! > 0.3);
  assert.match(
    refinementTerminalSummary(report),
    /calibration-projected \(not independently measured truth\)/,
  );
});

test("dropping hard unresolved coordinates cannot manufacture an error-only acceptance pass", async () => {
  const input = wire([
    { x: a.x + 4.5, y: a.y },
    { x: b.x + 2, y: b.y },
  ]);
  const report = await compareRefinement(
    [input],
    [board],
    async (_id, i, original) => (i ? result(original, b) : null),
    { allEndpoints: true },
  );
  assert.equal(report.localizationError.raw.count, 2);
  assert.equal(report.localizationError.refined.count, 1);
  assert.ok(report.localizationError.paired.meanImprovementPx! > 0);
  assert.equal(report.acceptance.completePairedErrorCoverage, false);
  assert.equal(report.acceptance.localizationImprovement, false);
  assert.equal(report.acceptance.passed, false);
});

test("null original points remain explicit skips and stay in the endpoint denominator", async () => {
  const report = await compareRefinement(
    [wire([null, b])],
    [board],
    async (_id, _i, original) => result(original, original),
    { allEndpoints: true },
  );
  assert.equal(report.experiments.length, 1);
  assert.equal(report.raw.endpoints, 2);
  assert.equal(report.refined.unresolved, 1);
  assert.equal(report.skipped[0].reason, "no_original_visible_insertion");
  assert.equal(report.endpoints[0].raw.errorPx, null);
  assert.equal(report.endpoints[0].refined.errorPx, null);
});
