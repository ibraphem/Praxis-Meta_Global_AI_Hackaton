import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  allHoles,
  boardOrientation,
  clientPointToImage,
  calibrateBoard,
  pickHole,
  project,
  registerRail,
  terminalHoles,
  unproject,
  type Point,
  type Rows,
} from "../lib/breadboard/calibration";
import { BreadboardOverlay } from "../components/breadboard-overlay";
import { BreadboardWorkspace } from "../components/breadboard-workspace";

const image = { width: 1400, height: 1400 };
// Independent fixture: known projective camera in physical hole-pitch coordinates.
const camera = (p: Point): Point => ({
  x: (22 * p.x + 3 * p.y + 180) / (1 + 0.003 * p.x + 0.008 * p.y),
  y: (2 * p.x + 18 * p.y + 120) / (1 + 0.003 * p.x + 0.008 * p.y),
});
const corners = (rows: Rows) =>
  [
    { x: 0, y: 0 },
    { x: 11, y: 0 },
    { x: 11, y: rows - 1 },
    { x: 0, y: rows - 1 },
  ].map(camera);
const board = (rows: Rows = 30, id = "board_1") =>
  calibrateBoard(id, rows, image, corners(rows));
const near = (a: Point, b: Point) => {
  assert.ok(Math.abs(a.x - b.x) < 1e-7);
  assert.ok(Math.abs(a.y - b.y) < 1e-7);
};

test("perspective calibration maps all terminal holes correctly under rotation and reversed orientation", () => {
  const rotate = (p: Point): Point => ({ x: image.width - 1 - p.y, y: p.x });
  const mirror = (p: Point): Point => ({ x: image.width - 1 - p.x, y: p.y });
  for (const rows of [30, 63] as const)
    for (const orient of [
      (p: Point) => p,
      rotate,
      (p: Point) => rotate(rotate(p)),
      mirror,
    ]) {
      const calibration = calibrateBoard(
        "board_1",
        rows,
        image,
        corners(rows).map(orient),
      );
      const holes = terminalHoles(calibration);
      assert.equal(holes.length, rows * 10);
      for (const hole of holes) {
        const expected = orient(camera(hole.grid));
        near(project(calibration, hole.grid), expected);
        near(unproject(calibration, expected), hole.grid);
        assert.equal(pickHole(calibration, [], expected)?.hole, hole.id);
      }
    }
});

test("a12–e12 share a template group; f12, adjacent rows and different boards stay separate", () => {
  const holes = terminalHoles(board());
  const find = (id: string) => holes.find((hole) => hole.id === id)!;
  assert.equal(find("a12").electricalGroup, find("e12").electricalGroup);
  assert.notEqual(find("e12").electricalGroup, find("f12").electricalGroup);
  assert.notEqual(find("a12").electricalGroup, find("a13").electricalGroup);
  assert.notEqual(
    find("a12").electricalGroup,
    terminalHoles(board(30, "board_2")).find((hole) => hole.id === "a12")
      ?.electricalGroup,
  );
  const selected = pickHole(board(), [], camera({ x: 0, y: 11 }))!;
  assert.deepEqual(selected.groupMembers, ["a12", "b12", "c12", "d12", "e12"]);
  assert.equal(selected.groupBasis, "template");
  assert.equal(selected.visibility, "unverified");
  assert.equal(selected.electricalContact, "unknown");
});

test("hole picking rejects the center channel, background, between-hole positions and invalid coordinates", () => {
  const calibration = board();
  assert.equal(
    pickHole(calibration, [], camera({ x: 0.31, y: 11 }))?.hole,
    "a12",
  );
  for (const grid of [
    { x: 0.33, y: 11 },
    { x: 0.5, y: 11 },
    { x: 5.5, y: 11 },
    { x: 0, y: 30 },
    { x: -3, y: 10 },
  ])
    assert.equal(pickHole(calibration, [], camera(grid)), null);
  for (const point of [
    { x: NaN, y: 2 },
    { x: -1, y: 0 },
    { x: 1400, y: 10 },
  ])
    assert.equal(pickHole(calibration, [], point), null);
});

test("bad, crossed, concave, out-of-bounds, subpixel and nonfinite calibrations fail before use", () => {
  const valid = corners(30);
  for (const anchors of [
    [],
    [valid[0], valid[0], valid[2], valid[3]],
    [valid[0], valid[2], valid[1], valid[3]],
    [valid[0], valid[1], camera({ x: 2, y: 3 }), valid[3]],
    [{ x: NaN, y: 2 }, ...valid.slice(1)],
    [{ x: -1, y: 2 }, ...valid.slice(1)],
    [
      { x: 100, y: 100 },
      { x: 105, y: 100 },
      { x: 105, y: 110 },
      { x: 100, y: 110 },
    ],
  ])
    assert.throws(() => calibrateBoard("board_1", 30, image, anchors));
  assert.throws(() => calibrateBoard("board_1", 31 as Rows, image, valid));
  assert.throws(() =>
    calibrateBoard(
      "board_1",
      30,
      { width: 1_000_000, height: 1_000_000 },
      valid,
    ),
  );
});

const railDefinition = {
  id: "R1",
  label: "positive" as const,
  count: 25 as const,
  layout: "groups-of-five" as const,
  connectivity: "unknown" as const,
  splitAfter: null,
};
const rail = (calibration = board()) =>
  registerRail(
    calibration,
    railDefinition,
    camera({ x: -3, y: 0 }),
    camera({ x: -3, y: 28 }),
  );

test("separately registered rails honor five-hole spacing gaps and default to unknown continuity", () => {
  const calibration = board();
  const registered = rail(calibration);
  const holes = allHoles(calibration, [registered]).filter(
    (hole) => hole.kind === "rail",
  );
  near(holes[4].grid, { x: -3, y: 4 });
  near(holes[5].grid, { x: -3, y: 6 });
  for (const hole of holes) {
    const result = pickHole(calibration, [registered], camera(hole.grid))!;
    assert.equal(result.hole, hole.id);
    assert.equal(result.electricalGroup, null);
    assert.equal(result.groupBasis, "unknown");
    assert.deepEqual(result.groupMembers, []);
  }
  assert.equal(
    pickHole(calibration, [registered], camera({ x: -3, y: 5 })),
    null,
  );
});

test("rail continuity and splits are explicit declarations and never merge separate lanes", () => {
  const calibration = board();
  const split = registerRail(
    calibration,
    { ...railDefinition, connectivity: "split", splitAfter: 12 },
    camera({ x: -3, y: 0 }),
    camera({ x: -3, y: 28 }),
  );
  const continuous = registerRail(
    calibration,
    { ...railDefinition, id: "R2", connectivity: "continuous" },
    camera({ x: -4, y: 0 }),
    camera({ x: -4, y: 28 }),
  );
  const holes = allHoles(calibration, [split, continuous]);
  const find = (id: string) => holes.find((hole) => hole.id === id)!;
  assert.equal(find("R1:1").electricalGroup, find("R1:12").electricalGroup);
  assert.notEqual(find("R1:12").electricalGroup, find("R1:13").electricalGroup);
  assert.equal(find("R2:1").electricalGroup, find("R2:25").electricalGroup);
  assert.notEqual(find("R1:1").electricalGroup, find("R2:1").electricalGroup);
  assert.equal(find("R1:1").groupBasis, "user_declared");
});

test("uniform 50-hole rails work on full boards; unsupported geometry, count, splits and bounds are rejected", () => {
  const calibration = board(63);
  const uniform = registerRail(
    calibration,
    { ...railDefinition, count: 50, layout: "uniform" },
    camera({ x: -3, y: 0 }),
    camera({ x: -3, y: 49 }),
  );
  assert.equal(
    allHoles(calibration, [uniform]).filter((hole) => hole.kind === "rail")
      .length,
    50,
  );
  for (const [first, last] of [
    [
      { x: 2, y: 0 },
      { x: 2, y: 28 },
    ],
    [
      { x: -3, y: 0 },
      { x: -1, y: 28 },
    ],
    [
      { x: -3, y: 0 },
      { x: -3, y: 8 },
    ],
    [
      { x: -100, y: 0 },
      { x: -100, y: 28 },
    ],
  ])
    assert.throws(() =>
      registerRail(board(), railDefinition, camera(first), camera(last)),
    );
  assert.throws(() =>
    registerRail(
      board(),
      { ...railDefinition, connectivity: "split", splitAfter: 0 },
      camera({ x: -3, y: 0 }),
      camera({ x: -3, y: 28 }),
    ),
  );
  assert.throws(() =>
    registerRail(
      board(),
      { ...railDefinition, connectivity: "split", splitAfter: 25 },
      camera({ x: -3, y: 0 }),
      camera({ x: -3, y: 28 }),
    ),
  );
});

test("duplicated overlapping rail geometry is ambiguous rather than an invented assignment", () => {
  const calibration = board();
  const a = rail(calibration),
    b = { ...a, id: "R2" };
  assert.equal(pickHole(calibration, [a, b], camera({ x: -3, y: 0 })), null);
});

test("rendered overlay keeps terminal strips and center gap separate and highlights only the selected group", () => {
  const calibration = board();
  const selected = pickHole(calibration, [], camera({ x: 0, y: 11 }));
  const html = renderToStaticMarkup(
    createElement(BreadboardOverlay, {
      calibration,
      rails: [],
      selected,
      anchors: [],
      image,
    }),
  );
  assert.equal((html.match(/same-group/g) ?? []).length, 5);
  assert.equal((html.match(/picked-hole/g) ?? []).length, 1);
  assert.match(html, /center-gap/);
  assert.match(html, />a1</);
  assert.match(html, />j30</);
  assert.equal((html.match(/<circle/g) ?? []).length, 300);
});

test("calibration is opt-in and the initial workspace leaves image interactions available", () => {
  const html = renderToStaticMarkup(
    createElement(BreadboardWorkspace, {
      image,
      disabled: false,
      imageUrl: "blob:test",
      children: null,
    }),
  );
  assert.match(html, /Calibrate a board/);
  assert.match(html, /Photo zoom/);
  assert.match(html, /blob:test/);
  assert.doesNotMatch(html, /hole-hit-surface/);
  assert.doesNotMatch(html, /grid-hole/);
});

test("click conversion tracks responsive sizing, photo zoom and scroll offsets", () => {
  const pixel = { x: 180, y: 360 };
  for (const rect of [
    { left: 30, top: 150, width: 400, height: 450 },
    { left: -150, top: -220, width: 1600, height: 1800 },
  ]) {
    const clicked = {
      x: rect.left + (pixel.x / 800) * rect.width,
      y: rect.top + (pixel.y / 900) * rect.height,
    };
    near(
      clientPointToImage(clicked, rect, { width: 800, height: 900 })!,
      pixel,
    );
    assert.equal(
      clientPointToImage({ x: rect.left - 1, y: rect.top }, rect, {
        width: 800,
        height: 900,
      }),
      null,
    );
  }
  assert.equal(
    clientPointToImage(
      { x: 0, y: 0 },
      { left: 0, top: 0, width: 0, height: 10 },
      image,
    ),
    null,
  );
});

test("orientation reports image axes and pixel entry preserves its actual source", () => {
  const calibration = calibrateBoard(
    "board_1",
    30,
    { width: 800, height: 900 },
    [
      { x: 180, y: 140 },
      { x: 400, y: 140 },
      { x: 400, y: 720 },
      { x: 180, y: 720 },
    ],
  );
  const orientation = boardOrientation(calibration);
  assert.ok(Math.abs(orientation.columnAxisDegrees) < 1e-8);
  assert.ok(Math.abs(orientation.rowAxisDegrees - 90) < 1e-8);
  assert.equal(
    pickHole(calibration, [], { x: 180, y: 360 }, "pixel_entry")
      ?.selectionSource,
    "pixel_entry",
  );
});

test("the reported 540px diagram calibrates from measured outer holes and preserves interior groups", () => {
  // Measured hole centers from the user's reference diagram; no photograph is stored.
  const calibration = calibrateBoard(
    "board_1",
    30,
    { width: 540, height: 540 },
    [
      { x: 184.5, y: 36.5 },
      { x: 355.5, y: 36.5 },
      { x: 355.5, y: 487.5 },
      { x: 184.5, y: 487.5 },
    ],
  );
  for (const [id, pixel] of [
    ["a12", { x: 184.5, y: 207.5 }],
    ["e12", { x: 246.5, y: 207.5 }],
    ["f12", { x: 293, y: 207.5 }],
    ["j30", { x: 355.5, y: 487.5 }],
  ] as const)
    assert.equal(pickHole(calibration, [], pixel)?.hole, id);
  assert.deepEqual(
    pickHole(calibration, [], { x: 246.5, y: 207.5 })?.groupMembers,
    ["a12", "b12", "c12", "d12", "e12"],
  );
  assert.deepEqual(
    pickHole(calibration, [], { x: 293, y: 207.5 })?.groupMembers,
    ["f12", "g12", "h12", "i12", "j12"],
  );
  // Browser zoom changes CSS pixels; device-pixel ratio is intentionally not applied.
  for (const scale of [0.8, 1, 1.5, 2, 3])
    for (const origin of [
      { x: 100, y: 200 },
      { x: -270, y: -50 },
    ]) {
      const actual = { x: 246.5, y: 207.5 };
      const rect = {
        left: origin.x,
        top: origin.y,
        width: 540 * scale,
        height: 540 * scale,
      };
      const pixel = clientPointToImage(
        { x: origin.x + actual.x * scale, y: origin.y + actual.y * scale },
        rect,
        calibration.image,
      )!;
      assert.equal(pickHole(calibration, [], pixel)?.hole, "e12");
    }
});
