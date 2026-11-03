import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCircuitSession } from "../lib/circuit-session";
import { destinationHoles, friendlyCameraError } from "../lib/camera-flow";
import {
  allHoles,
  type Calibration,
  type Rail,
} from "../lib/breadboard/calibration";
test("repair choices use the observed LED-anode net, exclude occupied/uncertain holes and never seed observed endpoints", () => {
  const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/camera-demo.json", import.meta.url),
        "utf8",
      ),
    ),
    view = parseCircuitSession(fixture.fault),
    input = view.input!,
    holes = input.boards.flatMap((b) =>
      allHoles(b.calibration as Calibration, b.rails as Rail[]).map((h) => ({
        value: `${b.id}/${h.id}`,
        label: h.id,
      })),
    );
  const choices = destinationHoles(view, holes);
  assert.ok(choices.some((h) => h.value === "board_1/c6"));
  assert.equal(
    choices.some((h) => h.value === "board_1/a7"),
    false,
  );
  assert.equal(
    choices.some((h) => h.value === "board_1/b6"),
    false,
  );
  const before = JSON.stringify(input);
  input.associations.push({
    id: "uncertain-target",
    terminalId: "J1:b",
    target: {
      kind: "hole",
      boardId: "board_1",
      holeId: "c6",
      calibrationRevision: 1,
    },
    type: "proximity",
    state: "unresolved",
    evidence: [],
    originalProposalRef: null,
  });
  assert.equal(
    destinationHoles(view, holes).some((h) => h.value === "board_1/c6"),
    false,
  );
  input.associations.pop();
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(destinationHoles({ ...view, graph: null }, holes), []);
});
test("camera errors offer a next action without concealing evidence or budget failures", () => {
  assert.match(
    friendlyCameraError("Camera permission denied."),
    /Allow camera access/,
  );
  assert.match(friendlyCameraError("NotFoundError"), /Connect a camera/);
  assert.match(friendlyCameraError("NotReadableError"), /Close other apps/);
  assert.equal(
    friendlyCameraError("The capture budget is exhausted."),
    "The capture budget is exhausted.",
  );
});
