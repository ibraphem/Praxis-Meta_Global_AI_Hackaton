import { test, before } from "node:test";
import assert from "node:assert/strict";
import cv from "@techstark/opencv-js";
import { fitHoleLattice } from "../lib/cv/lattice";
import { detectGeometry } from "../lib/cv/geometry";
import { matchLocalEndpoints, type RasterMask } from "../lib/cv/endpoints";
import {
  calibrateBoard,
  terminalHoles,
  project,
} from "../../praxis-backend/server/src/shared/calibration";
import type { CircuitInput, CircuitInspection } from "../lib/automatic-circuit";
import {
  confirmClearProposals,
  canConfirmMeasuredGrid,
} from "../lib/cv/review";
before(async () => {
  if (!cv.Mat)
    await new Promise<void>((resolve) => {
      (
        cv as typeof cv & { onRuntimeInitialized: () => void }
      ).onRuntimeInitialized = resolve;
    });
});
function grid(rows: 30 | 63 = 30, rotation = 0) {
  const width = 1600,
    height = 1600,
    pitch = rows === 30 ? 30 : 17;
  const center = { x: 800, y: 800 },
    angle = (rotation * Math.PI) / 180;
  const at = (x: number, y: number) => ({
    x: center.x + x * Math.cos(angle) - y * Math.sin(angle),
    y: center.y + x * Math.sin(angle) + y * Math.cos(angle),
  });
  const anchors = [
    at(-5.5 * pitch, (-(rows - 1) * pitch) / 2),
    at(5.5 * pitch, (-(rows - 1) * pitch) / 2),
    at(5.5 * pitch, ((rows - 1) * pitch) / 2),
    at(-5.5 * pitch, ((rows - 1) * pitch) / 2),
  ];
  const calibration = calibrateBoard(
    "board_1",
    rows,
    { width, height },
    anchors,
  );
  const points = terminalHoles(calibration).map((h) =>
    project(calibration, h.grid),
  );
  return { width, height, calibration, points, pitch };
}
test("lattice fitting measures both supported boards across rotation and missing holes", () => {
  for (const rows of [30, 63] as const)
    for (const rotation of [0, 15, 90, 180]) {
      const g = grid(rows, rotation),
        points = g.points.filter((_, i) => i % 13 !== 0);
      let result;
      try {
        result = fitHoleLattice(points, g.width, g.height);
      } catch (e) {
        throw Error(`${rows}/${rotation}: ${e}`);
      }
      assert.equal(result.rows, rows);
      assert.ok(result.holes.length > points.length * 0.85);
      assert.ok(result.rmsPitch < 0.02);
      const fitted = calibrateBoard(
        "board_1",
        rows,
        { width: g.width, height: g.height },
        result.anchors,
      );
      for (const h of terminalHoles(fitted)) {
        const p = project(fitted, h.grid),
          nearest = Math.min(
            ...g.points.map((q) => Math.hypot(p.x - q.x, p.y - q.y)),
          );
        assert.ok(
          nearest < g.pitch * 0.1,
          `grid drift ${rows}/${rotation}: ${nearest}`,
        );
      }
    }
});
test("OpenCV extracts actual pixels and fits the generated hole pattern", () => {
  const g = grid(),
    rgba = new Uint8ClampedArray(g.width * g.height * 4);
  rgba.fill(255);
  for (const p of g.points)
    for (let y = Math.round(p.y) - 5; y <= p.y + 5; y++)
      for (let x = Math.round(p.x) - 5; x <= p.x + 5; x++) {
        const i = (y * g.width + x) * 4;
        rgba[i] = 25;
        rgba[i + 1] = 25;
        rgba[i + 2] = 25;
      }
  const result = detectGeometry(cv, rgba, g.width, g.height);
  assert.equal(result.status, "measured", result.reason);
  assert.ok(result.fit!.holes.length >= 280);
  assert.ok(result.fit!.rmsPitch < 0.03);
});
test("rail geometry is fitted independently and carries no continuity claim", () => {
  const g = grid(),
    rgba = new Uint8ClampedArray(g.width * g.height * 4).fill(255),
    points = [...g.points];
  for (const x of [-3, -2, 13, 14])
    for (let i = 0; i < 25; i++)
      points.push(
        project(g.calibration, { x, y: 0.5 + i + Math.floor(i / 5) }),
      );
  for (const p of points)
    for (let y = Math.round(p.y) - 5; y <= p.y + 5; y++)
      for (let x = Math.round(p.x) - 5; x <= p.x + 5; x++) {
        const i = (y * g.width + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 25;
      }
  const result = detectGeometry(cv, rgba, g.width, g.height);
  assert.equal(result.status, "measured", result.reason);
  assert.equal(result.fit!.rails!.length, 4);
  assert.ok(
    result.fit!.rails!.every(
      (r) =>
        r.count === 25 &&
        r.layout === "groups-of-five" &&
        !("connectivity" in r),
    ),
  );
});
test("uniform dots without a centre channel and insufficient evidence are rejected", () => {
  const points = Array.from({ length: 300 }, (_, i) => ({
    x: 200 + (i % 10) * 25,
    y: 150 + Math.floor(i / 10) * 25,
  }));
  assert.throws(() => fitHoleLattice(points, 1000, 1400), /banks/);
  assert.throws(
    () => fitHoleLattice(points.slice(0, 20), 1000, 1400),
    /Not enough/,
  );
});
function endpointFixture() {
  const c = calibrateBoard("board_1", 30, { width: 640, height: 960 }, [
    { x: 100, y: 100 },
    { x: 430, y: 100 },
    { x: 430, y: 900 },
    { x: 100, y: 900 },
  ]);
  const input: CircuitInput = {
    schemaVersion: "praxis-connectivity-input-v1",
    analysisId: "11111111-1111-4111-8111-111111111111",
    imageHash: "a".repeat(64),
    revision: 0,
    validationScope: "photograph",
    coverage: { state: "unresolved", evidence: [] },
    boards: [
      {
        id: "board_1",
        revision: 1,
        calibration: c,
        rails: [],
        topologyState: "unresolved",
        evidence: [],
      },
    ],
    components: [
      {
        id: "wire",
        label: "Measured wire",
        type: "jumper_wire",
        bbox: [90, 200, 230, 210],
        objectRef: { kind: "manual", id: "wire" },
        terminalIds: ["a", "b"],
        state: "unresolved",
        continuity: "unresolved",
        evidence: [],
      },
    ],
    terminals: ["a", "b"].map((id) => ({
      id,
      componentId: "wire",
      label: id,
      position: null,
      role: null,
      roleState: "unresolved",
      evidence: [],
    })),
    associations: ["a", "b"].map((id) => ({
      id,
      terminalId: id,
      type: "insertion",
      target: null,
      state: "unresolved",
      evidence: [],
      originalProposalRef: null,
    })),
  };
  const a = project(c, { x: 0, y: 4 }),
    b = project(c, { x: 7, y: 4 }),
    mask: RasterMask = {
      componentId: "wire",
      data: new Uint8Array(250 * 250),
      width: 250,
      height: 250,
      left: 80,
      top: 190,
    };
  const poly = [a, { x: 180, y: 375 }, b];
  for (let segment = 0; segment < 2; segment++) {
    const a = poly[segment],
      b = poly[segment + 1],
      steps = Math.ceil(Math.hypot(a.x - b.x, a.y - b.y));
    for (let n = 0; n <= steps; n++) {
      const x = Math.round(a.x + ((b.x - a.x) * n) / steps) - mask.left,
        y = Math.round(a.y + ((b.y - a.y) * n) / steps) - mask.top;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          mask.data[(y + dy) * mask.width + x + dx] = 1;
    }
  }
  return { input, mask, rgba: new Uint8ClampedArray(640 * 960 * 4).fill(255) };
}
test("local wire skeleton endpoints map to holes without changing confirmation states", () => {
  const { input, mask, rgba } = endpointFixture(),
    results = matchLocalEndpoints(cv, rgba, 640, 960, input, [mask]);
  assert.equal(results.length, 2);
  assert.ok(
    results.every((r) => r.status === "supported"),
    JSON.stringify(results),
  );
  assert.deepEqual(results.map((r) => r.candidates[0].holeId).sort(), [
    "a5",
    "f5",
  ]);
  assert.ok(input.associations.every((a) => a.state === "unresolved"));
});
test("missing or duplicate wire masks stay unresolved", () => {
  const { input, mask, rgba } = endpointFixture();
  for (const masks of [[], [mask, mask]]) {
    const results = matchLocalEndpoints(cv, rgba, 640, 960, input, masks);
    assert.ok(
      results.every((r) => r.status === "unresolved" && r.position === null),
    );
  }
});
test("batch review confirms clear proposals while leaving unresolved contacts and roles untouched", () => {
  const { input, mask, rgba } = endpointFixture(),
    endpoints = matchLocalEndpoints(cv, rgba, 640, 960, input, [mask]);
  endpoints.forEach(
    (e, i) =>
      (input.associations[i].target = {
        kind: "hole",
        boardId: "board_1",
        holeId: e.candidates[0].holeId,
        calibrationRevision: 1,
      }),
  );
  input.terminals.push({
    id: "hidden",
    componentId: "module",
    label: "Hidden contact",
    position: null,
    role: null,
    roleState: "unresolved",
    evidence: [],
  });
  input.components.push({
    id: "module",
    label: "Unknown module",
    type: "power_module",
    bbox: null,
    objectRef: { kind: "manual", id: "module" },
    terminalIds: ["hidden"],
    state: "unresolved",
    continuity: "unresolved",
    evidence: [],
  });
  input.associations.push({
    id: "hidden",
    terminalId: "hidden",
    target: null,
    type: "proximity",
    state: "unresolved",
    evidence: [],
    originalProposalRef: null,
  });
  const calibration = input.boards[0].calibration;
  const view: CircuitInspection = {
    id: input.analysisId,
    imageHash: input.imageHash,
    image: calibration.image,
    createdAt: 0,
    revision: 0,
    status: "needs_review",
    stage: "Review",
    model: "synthetic",
    requestCount: 2,
    error: null,
    warnings: [],
    observations: null,
    input,
    graph: null,
    reviewedAt: null,
    reviewer: null,
    hybrid: {
      geometry: {
        version: "opencv-lattice-v1",
        image: calibration.image,
        processing: calibration.image,
        status: "measured",
        reason: "Synthetic grid",
        holeCount: 300,
        fit: {
          rows: 30,
          observedRows: 30,
          anchors: calibration.anchors,
          holes: terminalHoles(
            calibration as Parameters<typeof terminalHoles>[0],
          ).map((h) => ({
            ...project(calibration as Parameters<typeof project>[0], h.grid),
            column: "abcdefghij".indexOf(h.id[0]),
            row: Number(h.id.slice(1)) - 1,
          })),
          pitch: 30,
          rmsPitch: 0,
          inlierRatio: 1,
        },
      },
      numbering: {
        firstPrintedRow: 1,
        rowDirection: "forward",
        columnDirection: "forward",
        note: "Visible labels",
      },
      wireMasks: [],
      endpoints,
      localStatus: "ready",
    },
  };
  const confirmed = confirmClearProposals(view, input);
  assert.ok(
    confirmed.associations
      .slice(0, 2)
      .every((a) => a.state === "confirmed_manual"),
  );
  assert.equal(confirmed.components[0].continuity, "confirmed_manual");
  assert.equal(confirmed.associations[2].state, "unresolved");
  assert.ok(confirmed.terminals.every((t) => t.roleState === "unresolved"));
  assert.ok(input.associations.every((a) => a.state === "unresolved"));
  view.hybrid!.numbering!.firstPrintedRow = null;
  assert.equal(canConfirmMeasuredGrid(view, input), false);
  assert.throws(() => confirmClearProposals(view, input), /numbering/);
  input.boards[0].topologyState = "confirmed_manual";
  assert.equal(canConfirmMeasuredGrid(view, input), true);
});
