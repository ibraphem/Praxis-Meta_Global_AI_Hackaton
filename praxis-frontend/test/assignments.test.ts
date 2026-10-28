import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { analysisSchema } from "../lib/vision";
import {
  calibrateBoard,
  project,
  terminalHoles,
  registerRail,
} from "../lib/breadboard/calibration";
import {
  assignEndpoint,
  assignmentValidity,
  createAssignment,
  replaceBoard,
  reviseRails,
  wireCandidate,
  type AssignmentContext,
  type CalibratedBoard,
} from "../lib/wires/assignments";
import { WireAssignmentPanel } from "../components/wire-assignment-panel";
import { WireEndpointOverlay } from "../components/wire-endpoint-overlay";

const image = { width: 1000, height: 1000 };
function board(id = "board_1", shift = 0): CalibratedBoard {
  return replaceBoard(
    undefined,
    calibrateBoard(id, 30, image, [
      { x: 50 + shift, y: 50 },
      { x: 160 + shift, y: 50 },
      { x: 160 + shift, y: 340 },
      { x: 50 + shift, y: 340 },
    ]),
  );
}
function context(): AssignmentContext {
  return {
    photoId: "photo-one",
    analysisRunId: "analysis-one",
    analysis: analysisSchema.parse({
      image,
      objects: [
        {
          id: "jumper_wire_1",
          type: "jumper_wire",
          bbox: [10, 10, 20, 20],
          localizationSource: "sam",
          interpretation: "uncertain",
          geometryStatus: "segmented",
          identityStatus: "unverified",
          guidanceEligible: false,
          mask: {
            format: "svg_path",
            width: 20,
            height: 20,
            path: "M1 1L3 1L3 18L1 18Z",
          },
        },
      ],
      provenance: {
        mode: "combined",
        reasoningModel: "muse",
        segmentationModel: "sam",
      },
    }),
  };
}
function point(b: CalibratedBoard, id: string) {
  return project(
    b.calibration,
    terminalHoles(b.calibration).find((h) => h.id === id)!.grid,
  );
}
function complete() {
  const a = board(),
    b = board("board_2", 500),
    boards = [a, b],
    ctx = context();
  const original = JSON.stringify(ctx.analysis);
  let record = createAssignment("connection_1", ctx, "jumper_wire_1");
  record = assignEndpoint(
    record,
    0,
    point(a, "a12"),
    "image_click",
    a,
    ctx,
    boards,
  );
  record = assignEndpoint(
    record,
    1,
    point(b, "f18"),
    "pixel_entry",
    b,
    ctx,
    boards,
  );
  return { record, ctx, boards, a, b, original };
}

test("manual endpoints resolve across boards while original detections and evidence states remain unchanged", () => {
  const { record, ctx, boards, original } = complete();
  assert.deepEqual(assignmentValidity(record, ctx, boards), {
    status: "complete",
    reasons: [],
  });
  assert.equal(record.endpoints[0]?.boardId, "board_1");
  assert.equal(record.endpoints[1]?.boardId, "board_2");
  for (const [index, id] of ["a12", "f18"].entries()) {
    const endpoint = record.endpoints[index]!;
    assert.equal(endpoint.selectionSource, "manual");
    assert.equal(endpoint.locationVerification, "user_selected");
    assert.equal(endpoint.electricalContact, "unknown");
    assert.equal(endpoint.resolution.status, "resolved");
    if (endpoint.resolution.status === "resolved") {
      assert.equal(endpoint.resolution.holeId, id);
      assert.equal(endpoint.resolution.source, "calibrated_grid");
    }
  }
  assert.equal(record.endpoints[0]?.inputMethod, "image_click");
  assert.equal(record.endpoints[1]?.inputMethod, "pixel_entry");
  assert.deepEqual(record.wireIdentity, {
    status: "unverified",
    associationSource: "user",
  });
  assert.equal(JSON.stringify(ctx.analysis), original);
  assert.equal("endpoints" in ctx.analysis!.objects[0], false);
  assert.equal(ctx.analysis!.objects[0].guidanceEligible, false);
  // Insertion points can be outside the segmented body: this does not verify association.
  assert.ok(record.endpoints[1]!.selectedImagePosition.x > 30);
});

test("manual source positions are retained independently of their snapped grid locations", () => {
  const ctx = context(),
    b = board();
  const source = { x: 51, y: 161 };
  const record = assignEndpoint(
    createAssignment("connection_1", ctx, "jumper_wire_1"),
    0,
    source,
    "pixel_entry",
    b,
    ctx,
    [b],
  );
  source.x = 999;
  const endpoint = record.endpoints[0]!;
  assert.deepEqual(endpoint.selectedImagePosition, { x: 51, y: 161 });
  assert.equal(endpoint.resolution.status, "resolved");
  if (endpoint.resolution.status === "resolved") {
    assert.equal(endpoint.resolution.holeId, "a12");
    assert.ok(Math.abs(endpoint.resolution.imagePosition.x - 50) < 1e-7);
    assert.ok(endpoint.resolution.snapDistancePx > 1);
  }
});

test("background and center-channel selections remain unknown rather than inventing an insertion", () => {
  const ctx = context(),
    b = board();
  let record = createAssignment("connection_1", ctx, "jumper_wire_1");
  record = assignEndpoint(
    record,
    0,
    project(b.calibration, { x: 5.5, y: 11 }),
    "image_click",
    b,
    ctx,
    [b],
  );
  record = assignEndpoint(record, 1, point(b, "f18"), "image_click", b, ctx, [
    b,
  ]);
  assert.deepEqual(record.endpoints[0]?.resolution, {
    status: "unknown",
    source: "none",
    reason: "no_unambiguous_hole",
  });
  assert.equal(assignmentValidity(record, ctx, [b]).status, "draft");
});

test("editing one endpoint preserves the other endpoint and the previous record snapshot", () => {
  const { record, ctx, boards, a } = complete();
  const before = JSON.stringify(record);
  const edited = assignEndpoint(
    record,
    0,
    point(a, "e15"),
    "image_click",
    a,
    ctx,
    boards,
  );
  assert.equal(JSON.stringify(record), before);
  assert.deepEqual(edited.endpoints[1], record.endpoints[1]);
  assert.equal(
    edited.endpoints[0]?.resolution.status === "resolved" &&
      edited.endpoints[0].resolution.holeId,
    "e15",
  );
});

test("confirmed recalibration invalidates snapshots permanently across geometry reversion; cancelled drafts leave them current", () => {
  const { record, ctx, boards, a, b } = complete();
  const before = JSON.stringify(record);
  assert.equal(assignmentValidity(record, ctx, boards).status, "complete"); // Pending/cancelled edits never replace confirmed board state.
  const recalibrated = replaceBoard(a, a.calibration);
  assert.equal(recalibrated.revision, 2);
  assert.deepEqual(assignmentValidity(record, ctx, [recalibrated, b]), {
    status: "stale",
    reasons: ["calibration_changed"],
  });
  const reverted = replaceBoard(recalibrated, a.calibration);
  assert.equal(reverted.revision, 3);
  assert.equal(assignmentValidity(record, ctx, [reverted, b]).status, "stale");
  assert.equal(JSON.stringify(record), before);
  assert.throws(
    () =>
      assignEndpoint(
        record,
        0,
        point(reverted, "a12"),
        "image_click",
        reverted,
        ctx,
        [reverted, b],
      ),
    /stale/,
  );
});

test("rail geometry, continuity changes and removal advance the board revision and invalidate its assignments", () => {
  const { record, ctx, a, b } = complete();
  const rail = registerRail(
    a.calibration,
    {
      id: "R1",
      label: "positive",
      count: 25,
      layout: "groups-of-five",
      connectivity: "unknown",
      splitAfter: null,
    },
    project(a.calibration, { x: -3, y: 0 }),
    project(a.calibration, { x: -3, y: 28 }),
  );
  const added = reviseRails(a, [rail]);
  const changed = reviseRails(added, [{ ...rail, connectivity: "continuous" }]);
  const removed = reviseRails(changed, []);
  assert.deepEqual(
    [added.revision, changed.revision, removed.revision],
    [2, 3, 4],
  );
  for (const current of [added, changed, removed])
    assert.equal(assignmentValidity(record, ctx, [current, b]).status, "stale");
});

test("unknown rail continuity still permits a location without assigning an electrical group or contact", () => {
  const ctx = context(),
    base = board();
  const rail = registerRail(
    base.calibration,
    {
      id: "R1",
      label: "positive",
      count: 25,
      layout: "groups-of-five",
      connectivity: "unknown",
      splitAfter: null,
    },
    project(base.calibration, { x: -3, y: 0 }),
    project(base.calibration, { x: -3, y: 28 }),
  );
  const current = reviseRails(base, [rail]);
  const record = assignEndpoint(
    createAssignment("connection_1", ctx, "jumper_wire_1"),
    0,
    project(current.calibration, { x: -3, y: 4 }),
    "image_click",
    current,
    ctx,
    [current],
  );
  const endpoint = record.endpoints[0]!;
  assert.equal(endpoint.resolution.status, "resolved");
  if (endpoint.resolution.status === "resolved") {
    assert.equal(endpoint.resolution.holeId, "R1:5");
    assert.equal(endpoint.resolution.electricalGroup, null);
    assert.equal(endpoint.resolution.groupBasis, "unknown");
  }
  assert.equal(endpoint.electricalContact, "unknown");
});

test("only associated boards invalidate a record; removing an associated board is explicit", () => {
  const { record, ctx, boards } = complete();
  const other = board("board_3", 250);
  const changed = replaceBoard(other, other.calibration);
  assert.equal(
    assignmentValidity(record, ctx, [...boards, changed]).status,
    "complete",
  );
  assert.deepEqual(assignmentValidity(record, ctx, [boards[0]]), {
    status: "stale",
    reasons: ["board_removed"],
  });
});

test("reanalysis invalidates even when a new result reuses the same wire ID; failures and photo changes never revive it", () => {
  const { record, ctx, boards } = complete();
  const newRun = { ...ctx, analysisRunId: "analysis-two" };
  assert.deepEqual(assignmentValidity(record, newRun, boards), {
    status: "stale",
    reasons: ["analysis_changed"],
  });
  assert.equal(
    assignmentValidity(record, { ...newRun, analysis: null }, boards).status,
    "stale",
  );
  assert.ok(
    assignmentValidity(
      record,
      { ...ctx, photoId: "photo-two" },
      boards,
    ).reasons.includes("photo_changed"),
  );
  const removed = { ...ctx, analysis: { ...ctx.analysis!, objects: [] } };
  assert.ok(
    assignmentValidity(record, removed, boards).reasons.includes(
      "wire_unavailable",
    ),
  );
});

test("invalid image positions, non-wire candidates and mismatched calibration dimensions cannot be assigned", () => {
  const ctx = context(),
    b = board();
  const record = createAssignment("connection_1", ctx, "jumper_wire_1");
  assert.throws(() => createAssignment("connection_2", ctx, "wire_region_1"));
  const withLed = {
    ...ctx,
    analysis: analysisSchema.parse({
      ...ctx.analysis,
      objects: [
        ...ctx.analysis!.objects,
        {
          id: "led_1",
          type: "led",
          bbox: [50, 50, 10, 10],
          interpretation: "confirmed",
        },
      ],
    }),
  };
  assert.throws(() => createAssignment("connection_2", withLed, "led_1"));
  assert.throws(() =>
    createAssignment(
      "connection_2",
      { ...ctx, analysisRunId: null },
      "jumper_wire_1",
    ),
  );
  for (const p of [
    { x: NaN, y: 50 },
    { x: -1, y: 50 },
    { x: 1000, y: 50 },
  ])
    assert.throws(() =>
      assignEndpoint(record, 0, p, "image_click", b, ctx, [b]),
    );
  assert.equal(
    wireCandidate(
      { ...ctx, analysis: { ...ctx.analysis!, objects: [] } },
      "jumper_wire_1",
    ),
    null,
  );
  const mismatch = {
    ...b,
    calibration: { ...b.calibration, image: { width: 900, height: 1000 } },
  };
  assert.throws(() =>
    assignEndpoint(record, 0, { x: 50, y: 50 }, "image_click", mismatch, ctx, [
      mismatch,
    ]),
  );
});

test("the panel separates assignment provenance and verification states, retains stale records and disables their editing", () => {
  const { record, ctx, boards } = complete();
  const ignore = () => {};
  const render = (context: AssignmentContext) =>
    renderToStaticMarkup(
      createElement(WireAssignmentPanel, {
        context,
        selectedWireId: "jumper_wire_1",
        boards,
        records: [record],
        capture: { assignmentId: record.id, index: 0 },
        activeBoardId: "board_1",
        picking: false,
        disabled: false,
        pausedReason: "",
        onStart: ignore,
        onPick: ignore,
        onStop: ignore,
        onRemove: ignore,
        onBoard: ignore,
        onPoint: ignore,
      }),
    );
  const current = render(ctx);
  assert.match(current, /board_1:a12/);
  assert.match(current, /board_2:f18/);
  assert.match(current, /Wire identity: unverified/);
  assert.match(current, /Electrical contact: unknown/);
  assert.match(current, /manually selected/);
  assert.match(current, /Inspect assignment JSON/);
  const stale = render({ ...ctx, analysisRunId: "analysis-two" });
  assert.match(stale, /Stale — invalid/);
  assert.match(stale, /analysis changed/);
  assert.match(stale, /start a new assignment/);
  assert.match(stale, /disabled=""[^>]*>Replace endpoint/);
});

test("endpoint overlays distinguish unresolved positions, never invent a wire path, and hide stale geometry", () => {
  const { record, ctx, boards } = complete();
  const html = renderToStaticMarkup(
    createElement(WireEndpointOverlay, {
      assignment: record,
      image,
      validity: assignmentValidity(record, ctx, boards),
    }),
  );
  assert.equal((html.match(/<circle/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<line|<path/);
  assert.match(html, /contact unknown/);
  const unknown = assignEndpoint(
    record,
    0,
    { x: 5, y: 5 },
    "image_click",
    boards[0],
    ctx,
    boards,
  );
  const unknownHtml = renderToStaticMarkup(
    createElement(WireEndpointOverlay, {
      assignment: unknown,
      image,
      validity: assignmentValidity(unknown, ctx, boards),
    }),
  );
  assert.match(unknownHtml, /endpoint-unknown/);
  assert.match(unknownHtml, /cx="5" cy="5"/);
  assert.match(unknownHtml, /unknown hole/);
  const hidden = renderToStaticMarkup(
    createElement(WireEndpointOverlay, {
      assignment: record,
      image,
      validity: { status: "stale", reasons: ["calibration_changed"] },
    }),
  );
  assert.equal(hidden, "");
});
