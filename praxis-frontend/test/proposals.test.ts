import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { analysisSchema } from "../lib/vision";
import {
  calibrateBoard,
  project,
  registerRail,
  terminalHoles,
} from "../lib/breadboard/calibration";
import {
  assignmentValidity,
  replaceBoard,
  reviseRails,
  type AssignmentContext,
  type CalibratedBoard,
} from "../lib/wires/assignments";
import {
  cancelCorrection,
  confirmCorrection,
  confirmEndpoint,
  createProposal,
  markEndpointUnknown,
  ProposalRequestGate,
  proposalValidity,
  reviewedAssignment,
  reviewSaveIssue,
  stageCorrection,
  startReview,
  type EndpointResponse,
} from "../lib/wires/proposals";
import { WireAssignmentPanel } from "../components/wire-assignment-panel";
import { WireEndpointOverlay } from "../components/wire-endpoint-overlay";

const image = { width: 1000, height: 1000 };
const boards = [
  replaceBoard(
    undefined,
    calibrateBoard("board_1", 30, image, [
      { x: 50, y: 50 },
      { x: 160, y: 50 },
      { x: 160, y: 340 },
      { x: 50, y: 340 },
    ]),
  ),
];
const context: AssignmentContext = {
  photoId: "photo-1",
  analysisRunId: "analysis-1",
  analysis: analysisSchema.parse({
    image,
    objects: [1, 2].map((i) => ({
      id: `jumper_wire_${i}`,
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
    })),
    provenance: {
      mode: "combined",
      reasoningModel: "muse",
      segmentationModel: "sam",
    },
  }),
};
function p(id: string, board: CalibratedBoard = boards[0]) {
  return project(
    board.calibration,
    terminalHoles(board.calibration).find((hole) => hole.id === id)!.grid,
  );
}
function fixture(currentBoards = boards) {
  const a = p("a12"),
    b = p("e14");
  const response: EndpointResponse = {
    analysisId: "analysis-1",
    imageId: "photo-1",
    wireCandidateId: "jumper_wire_1",
    model: "muse",
    endpoints: [
      {
        role: "A",
        proposedImagePosition: [a.x + 1, a.y + 1],
        evidence: "visible_insertion",
      },
      {
        role: "B",
        proposedImagePosition: [b.x, b.y],
        evidence: "visible_connector",
      },
    ],
  };
  return startReview(
    createProposal("proposal-1", response, context, currentBoards),
  );
}
function confirmed() {
  return confirmEndpoint(
    confirmEndpoint(fixture(), 0, context, boards),
    1,
    context,
    boards,
  );
}

test("accept independent proposals and save with explicit source and unverified identity/contact", () => {
  const original = fixture();
  const a = confirmEndpoint(original, 0, context, boards);
  assert.equal(a.endpoints[0].reviewStatus, "confirmed");
  assert.equal(a.endpoints[1].reviewStatus, "proposed");
  assert.match(reviewSaveIssue(a, context, boards)!, /both/);
  const record = reviewedAssignment(
    "connection_1",
    confirmEndpoint(a, 1, context, boards),
    context,
    boards,
  );
  assert.equal(assignmentValidity(record, context, boards).status, "complete");
  assert.equal(record.endpoints[0]?.selectionSource, "ai_user_confirmed");
  assert.equal(record.endpoints[0]?.inputMethod, "ai_proposal");
  assert.equal(record.endpoints[0]?.locationVerification, "user_confirmed");
  assert.deepEqual(
    record.endpointReview!.endpoints[0].finalPosition,
    original.proposal.endpoints[0].proposedImagePosition,
  );
  assert.equal(record.endpointReview!.endpoints[0].finalHole!.holeId, "a12");
  assert.equal(record.wireIdentity.status, "unverified");
  assert.ok(
    record.endpoints.every(
      (endpoint) => endpoint?.electricalContact === "unknown",
    ),
  );
  assert.equal(context.analysis!.objects[0].guidanceEligible, false);
  assert.equal(original.endpoints[0].reviewStatus, "proposed");
});

test("correct only B, stage before confirmation, and preserve A and the original proposal", () => {
  const original = confirmed(),
    snapshot = JSON.stringify(original);
  const staged = stageCorrection(
    original,
    1,
    p("f18"),
    "image_click",
    boards[0],
    context,
    boards,
  );
  assert.deepEqual(staged.endpoints, original.endpoints);
  assert.match(reviewSaveIssue(staged, context, boards)!, /pending/);
  const result = confirmCorrection(staged, 1, context, boards);
  assert.deepEqual(result.endpoints[0], original.endpoints[0]);
  assert.deepEqual(result.proposal, original.proposal);
  assert.deepEqual(
    result.endpoints[1].originalProposal,
    original.endpoints[1].originalProposal,
  );
  assert.equal(result.endpoints[1].finalHole?.holeId, "f18");
  assert.equal(result.endpoints[1].source, "manual_correction");
  assert.equal(
    result.endpoints[1].observation?.selectionSource,
    "manual_correction",
  );
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(cancelCorrection(staged, 1).pendingCorrections[1], null);
});

test("unknown A is reviewed and savable as incomplete, without substituting rejected geometry", () => {
  const original = confirmed();
  const unknown = markEndpointUnknown(original, 0, context, boards);
  const record = reviewedAssignment("connection_1", unknown, context, boards);
  assert.equal(record.endpoints[0], null);
  assert.equal(record.endpointReview!.endpoints[0].finalHole, null);
  assert.equal(record.endpointReview!.endpoints[0].finalPosition, null);
  assert.deepEqual(
    record.endpointReview!.endpoints[0].originalProposal,
    original.proposal.endpoints[0],
  );
  assert.equal(record.endpointReview!.endpoints[0].source, "user_unknown");
  assert.equal(assignmentValidity(record, context, boards).status, "draft");
  const both = markEndpointUnknown(unknown, 1, context, boards);
  assert.deepEqual(
    reviewedAssignment("connection_2", both, context, boards).endpoints,
    [null, null],
  );
});

test("correct a proposal to a registered power rail through the existing resolver", () => {
  const board = boards[0];
  const rail = registerRail(
    board.calibration,
    {
      id: "R1",
      label: "positive",
      count: 25,
      layout: "groups-of-five",
      connectivity: "unknown",
      splitAfter: null,
    },
    project(board.calibration, { x: -3, y: 0 }),
    project(board.calibration, { x: -3, y: 28 }),
  );
  const revised = reviseRails(board, [rail]),
    current = [revised];
  let review = fixture(current);
  review = confirmEndpoint(review, 0, context, current);
  review = stageCorrection(
    review,
    1,
    project(revised.calibration, { x: -3, y: 12 }),
    "image_click",
    revised,
    context,
    current,
  );
  review = confirmCorrection(review, 1, context, current);
  assert.equal(review.endpoints[1].finalHole?.holeId, "R1:11");
  assert.equal(review.endpoints[1].observation?.resolution.status, "resolved");
  assert.equal(review.endpoints[1].observation?.electricalContact, "unknown");
  assert.equal(
    reviewedAssignment("connection_1", review, context, current).wireIdentity
      .status,
    "unverified",
  );
});

test("reopen saved snapshots and revise one endpoint without mutating the saved record", () => {
  const saved = reviewedAssignment(
    "connection_1",
    confirmed(),
    context,
    boards,
  );
  const snapshot = JSON.stringify(saved);
  const edited = markEndpointUnknown(saved.endpointReview!, 1, context, boards);
  assert.equal(edited.savedAssignmentId, saved.id);
  assert.equal(edited.dirty, true);
  const resaved = reviewedAssignment(saved.id, edited, context, boards);
  assert.equal(resaved.endpointReview!.dirty, false);
  assert.equal(resaved.endpointReview!.endpoints[1].reviewStatus, "unknown");
  assert.equal(JSON.stringify(saved), snapshot);
});

test("calibration, rail changes, removed boards, image changes and repeated wire IDs invalidate reviews", () => {
  const review = confirmed();
  for (const currentBoards of [
    [replaceBoard(boards[0], boards[0].calibration)],
    [reviseRails(boards[0], [])],
    [],
  ]) {
    assert.equal(
      proposalValidity(review.proposal, context, currentBoards).status,
      "stale",
    );
    assert.throws(() =>
      reviewedAssignment("connection_1", review, context, currentBoards),
    );
    assert.throws(
      () => confirmEndpoint(review, 0, context, currentBoards),
      /stale/,
    );
    const saved = reviewedAssignment("connection_1", review, context, boards);
    assert.equal(
      assignmentValidity(saved, context, currentBoards).status,
      "stale",
    );
    assert.equal(review.endpoints[0].reviewStatus, "confirmed");
  }
  for (const changed of [
    { ...context, analysisRunId: "analysis-2" },
    { ...context, photoId: "photo-2" },
    { ...context, analysis: null },
  ]) {
    assert.equal(
      proposalValidity(review.proposal, changed, boards).status,
      "stale",
    );
    assert.throws(() =>
      reviewedAssignment("connection_1", review, changed, boards),
    );
  }
});

test("same-hole endpoints are flagged, while shared electrical groups are valid distinct locations", () => {
  const original = confirmed();
  const same = confirmCorrection(
    stageCorrection(
      original,
      1,
      p("a12"),
      "image_click",
      boards[0],
      context,
      boards,
    ),
    1,
    context,
    boards,
  );
  assert.match(reviewSaveIssue(same, context, boards)!, /same physical hole/);
  assert.throws(() =>
    reviewedAssignment("connection_1", same, context, boards),
  );
  const different = confirmCorrection(
    stageCorrection(
      original,
      1,
      p("b12"),
      "image_click",
      boards[0],
      context,
      boards,
    ),
    1,
    context,
    boards,
  );
  assert.equal(reviewSaveIssue(different, context, boards), null);
});

test("ambiguous boards, background and weak evidence never force a hole", () => {
  const original = fixture();
  const overlap = replaceBoard(undefined, {
    ...boards[0].calibration,
    breadboardId: "board_2",
  });
  const response = {
    ...original.proposal,
    endpoints: original.proposal.endpoints.map(
      ({ role, proposedImagePosition, evidence }) => ({
        role,
        proposedImagePosition,
        evidence,
      }),
    ),
  };
  const clean = {
    analysisId: response.analysisId,
    imageId: response.imageId,
    wireCandidateId: response.wireCandidateId,
    model: response.model,
    endpoints: response.endpoints,
  } as EndpointResponse;
  const ambiguous = startReview(
    createProposal("overlap", clean, context, [...boards, overlap]),
  );
  assert.equal(ambiguous.proposal.endpoints[0].proposedHole, null);
  assert.throws(() =>
    confirmEndpoint(ambiguous, 0, context, [...boards, overlap]),
  );
  const hidden = startReview(
    createProposal(
      "hidden",
      {
        ...clean,
        endpoints: [
          { role: "A", proposedImagePosition: null, evidence: "occluded" },
          {
            role: "B",
            proposedImagePosition: [500, 500],
            evidence: "wire_mask_tip",
          },
        ],
      },
      context,
      boards,
    ),
  );
  assert.ok(
    hidden.proposal.endpoints.every(
      (endpoint) => endpoint.proposedHole === null,
    ),
  );
  const staged = stageCorrection(
    original,
    0,
    { x: 500, y: 500 },
    "pixel_entry",
    boards[0],
    context,
    boards,
  );
  assert.throws(
    () => confirmCorrection(staged, 0, context, boards),
    /unambiguous/,
  );
});

test("generation IDs reject late replies after wire switching, reanalysis, new requests and manual edits", async () => {
  const gate = new ProposalRequestGate();
  for (const event of [
    "wire switch",
    "analysis",
    "calibration",
    "manual edit",
  ]) {
    const request = gate.begin();
    const result = Promise.resolve({ event, request });
    gate.invalidate();
    assert.equal(gate.accepts((await result).request), false);
  }
  const old = gate.begin(),
    current = gate.begin();
  assert.equal(gate.accepts(old), false);
  assert.equal(gate.accepts(current), true);
});

test("review panel and overlays show proposals, independent actions, original provenance, unknown and stale states", () => {
  const review = confirmed(),
    noop = () => {};
  const html = renderToStaticMarkup(
    createElement(WireAssignmentPanel, {
      context,
      selectedWireId: "jumper_wire_1",
      boards,
      records: [],
      capture: null,
      activeBoardId: "board_1",
      picking: false,
      disabled: false,
      pausedReason: "",
      onStart: noop,
      onPick: noop,
      onStop: noop,
      onRemove: noop,
      onBoard: noop,
      onPoint: noop,
      review,
    }),
  );
  assert.match(html, /Confirm endpoint A/);
  assert.match(html, /Correct endpoint B/);
  assert.match(html, /Mark endpoint A unknown/);
  assert.match(html, /Inspect original proposal/);
  assert.match(html, /Save reviewed assignment/);
  assert.match(html, /electrical contact unknown/);
  const proposed = renderToStaticMarkup(
    createElement(WireEndpointOverlay, {
      review: fixture(),
      image,
      validity: { status: "draft", reasons: [] },
    }),
  );
  assert.match(proposed, /endpoint-proposed/);
  assert.doesNotMatch(proposed, /<line|<path/);
  const unknown = renderToStaticMarkup(
    createElement(WireEndpointOverlay, {
      review: markEndpointUnknown(review, 0, context, boards),
      image,
      validity: { status: "draft", reasons: [] },
    }),
  );
  assert.match(unknown, /endpoint-unknown/);
  const hidden = renderToStaticMarkup(
    createElement(WireEndpointOverlay, {
      review,
      image,
      validity: { status: "stale", reasons: ["calibration_changed"] },
    }),
  );
  assert.equal(hidden, "");
});
