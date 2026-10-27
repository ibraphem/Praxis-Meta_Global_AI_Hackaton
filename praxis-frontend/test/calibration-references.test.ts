import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  placeReference,
  referenceInstruction,
  referenceNames,
  referenceTarget,
} from "../lib/breadboard/references";
import { calibrateBoard } from "../lib/breadboard/calibration";
import { BreadboardOverlay } from "../components/breadboard-overlay";
import { CalibrationGuide } from "../components/calibration-guide";
import { CalibrationLoupe } from "../components/calibration-loupe";

const reported = [
  { x: 248.8, y: 380.2 },
  { x: 231.4, y: 142 },
  { x: 307.6, y: 329.1 },
  { x: 339.4, y: 256.7 },
];
test("the reported invalid reference set never requests grid alignment review", () => {
  assert.throws(() =>
    calibrateBoard("board_1", 30, { width: 540, height: 540 }, reported),
  );
  const instruction = referenceInstruction(
    30,
    reported,
    null,
    false,
    "Invalid quadrilateral.",
  );
  assert.match(instruction, /Correct the reference points/);
  assert.doesNotMatch(instruction, /Confirm only if it aligns/);
});
test("any named reference can be replaced without changing other slots or the input array", () => {
  const original = JSON.stringify(reported);
  for (let index = 0; index < 4; index++) {
    const next = placeReference(reported, index, { x: 180, y: 35 });
    assert.deepEqual(next[index], { x: 180, y: 35 });
    for (let other = 0; other < 4; other++)
      if (other !== index) assert.deepEqual(next[other], reported[other]);
    assert.equal(JSON.stringify(reported), original);
    assert.equal(referenceTarget(reported, index), index);
    assert.match(
      referenceInstruction(
        30,
        reported,
        index,
        false,
        "Invalid quadrilateral.",
      ),
      new RegExp(`Replace ${referenceNames(30)[index]}`),
    );
  }
});
test("sequential placement finishes after four points and review is available only for valid geometry", () => {
  let points: typeof reported = [];
  for (const point of reported) points = placeReference(points, null, point);
  assert.deepEqual(points, reported);
  assert.equal(referenceTarget(points, null), null);
  assert.equal(placeReference(points, null, { x: 0, y: 0 }), points);
  assert.match(referenceInstruction(63, [], null, false, ""), /Set a1/);
  assert.match(
    referenceInstruction(63, points, null, true, ""),
    /Check the grid/,
  );
  assert.deepEqual(referenceNames(63), ["a1", "j1", "j63", "a63"]);
});
test("anchor markers and guide use hole names and show the active reference", () => {
  const html = renderToStaticMarkup(
    createElement(BreadboardOverlay, {
      calibration: null,
      rails: [],
      selected: null,
      anchors: reported,
      anchorLabels: referenceNames(30),
      activeAnchor: 2,
      image: { width: 540, height: 540 },
    }),
  );
  for (const label of referenceNames(30))
    assert.match(html, new RegExp(`>${label}</text>`));
  assert.equal((html.match(/active-anchor/g) ?? []).length, 1);
  const guide = renderToStaticMarkup(
    createElement(CalibrationGuide, { rows: 63, active: 1 }),
  );
  assert.match(guide, /j63/);
  assert.match(guide, /not power rails/);
  assert.match(guide, /guide-active/);
});
test("magnifier reads the same source pixel as placement without adding overlays or remote requests", () => {
  const html = renderToStaticMarkup(
    createElement(CalibrationLoupe, {
      imageUrl: "blob:local-photo",
      image: { width: 540, height: 540 },
      point: { x: 184.5, y: 36.5 },
      label: "Place a1 here",
    }),
  );
  assert.match(html, /viewBox="160.5 12.5 48 48"/);
  assert.match(html, /href="blob:local-photo"/);
  assert.match(html, /x 184.5, y 36.5/);
  assert.match(html, /loupe-crosshair/);
  const initial = renderToStaticMarkup(
    createElement(CalibrationLoupe, {
      imageUrl: "blob:local-photo",
      image: { width: 540, height: 540 },
      point: null,
      label: "Place a1 here",
    }),
  );
  assert.doesNotMatch(initial, /<image/);
  assert.match(initial, /Move over the photo/);
});
