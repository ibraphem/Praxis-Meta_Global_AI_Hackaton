import assert from "node:assert/strict";
import { test } from "node:test";
import { refineWireTip, type RefinementPatch } from "../lib/wires/refinement";
import { spatialConsistency } from "../lib/wires/spatial-consistency";
import type { Component } from "../lib/vision";
function patch(): RefinementPatch {
  const width = 64,
    height = 40,
    rgba = new Uint8ClampedArray(width * height * 4),
    selectedMask = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba.set([240, 240, 240, 255], i);
  }
  for (let y = 18; y <= 22; y++)
    for (let x = 20; x <= 50; x++) {
      const i = (y * width + x) * 4;
      rgba.set([180, 30, 20, 255], i);
      selectedMask.set([255, 255, 255, 255], i);
    }
  return {
    width,
    height,
    rgba,
    selectedMask,
    seed: { x: 12, y: 20 },
    origin: { x: 0, y: 0 },
    searchRadius: 24,
  };
}

test("local refinement uses original pixels plus selected-mask support without any hole coordinates", () => {
  const input = patch(),
    original = { ...input.seed },
    pixels = input.rgba.slice();
  const result = refineWireTip(input);
  assert.equal(result.status, "supported_tip");
  assert.ok(
    result.refinedPosition &&
      Math.abs(result.refinedPosition.x - 20) <= 1 &&
      Math.abs(result.refinedPosition.y - 20) <= 1,
  );
  assert.deepEqual(result.originalPosition, original);
  assert.equal(result.physicalInsertion, "unverified");
  assert.deepEqual(input.rgba, pixels);
  assert.ok(result.elapsedMs >= 0);
});

test("unsupported, low-contrast, ambiguous and truncated hypotheses remain rejected", () => {
  const noMask = patch();
  noMask.selectedMask.fill(0);
  assert.equal(refineWireTip(noMask).status, "rejected");
  const flat = patch();
  for (let i = 0; i < flat.rgba.length; i += 4)
    flat.rgba.set([240, 240, 240, 255], i);
  assert.equal(refineWireTip(flat).reason, "low_contrast");
  const middle = patch();
  middle.seed = { x: 35, y: 20 };
  assert.equal(refineWireTip(middle).reason, "ambiguous_terminal_direction");
  const truncated = patch();
  for (let y = 18; y <= 22; y++)
    for (let x = 0; x < 20; x++) {
      const i = (y * truncated.width + x) * 4;
      truncated.rgba.set([180, 30, 20, 255], i);
      truncated.selectedMask.set([255, 255, 255, 255], i);
    }
  truncated.seed = { x: 3, y: 20 };
  assert.equal(refineWireTip(truncated).reason, "terminal_truncated_by_patch");
  assert.equal(
    refineWireTip({ ...patch(), rgba: new Uint8ClampedArray(4) }).reason,
    "invalid_patch",
  );
});

test("wire consistency is a soft signal that permits exposed leads outside the SAM insulation mask", () => {
  const wire: Component = {
    id: "jumper_wire_1",
    type: "jumper_wire",
    bbox: [100, 100, 50, 10],
    interpretation: "uncertain",
    mask: {
      format: "svg_path",
      width: 50,
      height: 10,
      path: "M0 0L50 0L50 10L0 10Z",
    },
  };
  assert.equal(
    spatialConsistency(
      wire,
      [
        { x: 90, y: 105 },
        { x: 160, y: 105 },
      ],
      20,
    ).status,
    "near_mask",
  );
  const far = spatialConsistency(
    wire,
    [
      { x: 10, y: 10 },
      { x: 140, y: 105 },
    ],
    20,
  );
  assert.equal(far.status, "review_needed");
  assert.equal(far.physicalWireIdentity, "unverified");
  assert.deepEqual(far.reasons, ["endpoint_A_far_from_visible_mask"]);
});

test("controlled refinement comparison preserves accepted raw points and scores unsupported results as unresolved", async () => {
  const { compareRefinement } =
    await import("../lib/wires/refinement-evaluation");
  const { calibrateBoard, project, terminalHoles } =
    await import("../lib/breadboard/calibration");
  const { replaceBoard } = await import("../lib/wires/assignments");
  const board = replaceBoard(
    undefined,
    calibrateBoard("board_1", 30, { width: 1000, height: 1000 }, [
      { x: 50, y: 50 },
      { x: 160, y: 50 },
      { x: 160, y: 340 },
      { x: 50, y: 340 },
    ]),
  );
  const a = project(
    board.calibration,
    terminalHoles(board.calibration).find((hole) => hole.id === "b12")!.grid,
  );
  const b = project(
    board.calibration,
    terminalHoles(board.calibration).find((hole) => hole.id === "e14")!.grid,
  );
  let calls = 0;
  const comparison = await compareRefinement(
    [
      {
        id: "jumper_wire_1",
        boardId: "board_1",
        holes: ["b12", "e14"],
        proposals: [a, { x: 500, y: 500 }],
      },
    ],
    [board],
    async (_id, index, original) => {
      calls++;
      assert.equal(index, 1);
      assert.deepEqual(original, { x: 500, y: 500 });
      return { ...refineWireTip(patch()), refinedPosition: b };
    },
  );
  assert.equal(calls, 1);
  assert.equal(comparison.raw.correct, 1);
  assert.equal(comparison.refined.correct, 2);
  assert.equal(comparison.raw.completeWires, 0);
  assert.equal(comparison.refined.completeWires, 1);
  const rejected = await compareRefinement(
    [
      {
        id: "jumper_wire_1",
        boardId: "board_1",
        holes: ["b12", "e14"],
        proposals: [a, { x: 500, y: 500 }],
      },
    ],
    [board],
    async () => null,
  );
  assert.equal(rejected.refined.correct, rejected.raw.correct);
  assert.equal(rejected.refined.unresolved, 1);
});
