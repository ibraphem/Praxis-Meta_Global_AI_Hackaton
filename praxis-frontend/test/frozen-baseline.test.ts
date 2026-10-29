import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import baseline from "./fixtures/exact-hole-v1/baseline.json";
import {
  diagnoseHole,
  HOLE_RESOLVER_POLICY,
  type Calibration,
} from "../lib/breadboard/calibration";
import {
  replayEvaluation,
  scoreHolePairs,
  type EvaluationWire,
} from "../lib/wires/evaluation";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const calibration = baseline.inputs.calibration as Calibration;

test("baseline evidence, original resolver and photograph bytes are frozen before experiments", () => {
  assert.equal(
    sha(
      readFileSync(
        new URL("./fixtures/exact-hole-v1/baseline.json", import.meta.url),
      ),
    ),
    "d6f3957aa6dc2cb8a231f741afce07fbd2d24055487b20595259d7e101e3ebce",
  );
  assert.equal(
    sha(
      readFileSync(
        new URL(
          "./fixtures/exact-hole-v1/resolver-original.ts.txt",
          import.meta.url,
        ),
      ),
    ),
    baseline.inputs.originalResolverSha256,
  );
  assert.equal(
    sha(
      readFileSync(
        new URL(
          "./fixtures/exact-hole-v1/jumper_wires_breadboard.png",
          import.meta.url,
        ),
      ),
    ),
    baseline.inputs.photographSha256,
  );
  assert.deepEqual(HOLE_RESOLVER_POLICY, baseline.policy);
  assert.equal(
    sha(
      readFileSync(
        new URL(
          "./fixtures/exact-hole-v1/praxis-exact-hole-benchmark.md",
          import.meta.url,
        ),
      ),
    ),
    baseline.inputs.sourceReportSha256,
  );
  assert.equal(baseline.inputs.selectedSamMasks, null);
});

test("all ten raw proposals reproduce the exact nearest-two distances and rejection reasons", () => {
  for (const wire of baseline.expected) {
    const original = baseline.evidence.proposals.find(
      (proposal) => proposal.wireCandidateId === wire.wireCandidateId,
    )!;
    for (const [i, endpoint] of original.endpoints.entries()) {
      const { role, originalResolvedHole, ...diagnosis } = wire.endpoints[i];
      const actual = diagnoseHole(calibration, [], {
        x: endpoint.proposedImagePosition[0],
        y: endpoint.proposedImagePosition[1],
      });
      assert.equal(role, endpoint.role);
      assert.deepEqual(actual, diagnosis);
      assert.equal(
        actual.reason === "accepted" ? actual.candidates[0].holeId : null,
        originalResolvedHole,
      );
    }
  }
});

test("offline replay reproduces 7/10 endpoints, 2/5 complete wires, zero wrong holes, excluding corrections", () => {
  const wires: EvaluationWire[] = baseline.expected.map((wire) => ({
    id: wire.wireCandidateId,
    boardId: "board_1",
    holes: wire.truth as [string, string],
    proposals: baseline.evidence.proposals
      .find((proposal) => proposal.wireCandidateId === wire.wireCandidateId)!
      .endpoints.map((endpoint) => ({
        x: endpoint.proposedImagePosition[0],
        y: endpoint.proposedImagePosition[1],
      })) as EvaluationWire["proposals"],
  }));
  const replay = replayEvaluation(wires, [{ calibration, rails: [] }]);
  for (const [key, value] of Object.entries(baseline.expectedMetrics))
    assert.equal(replay[key as keyof typeof replay], value);
  assert.ok(
    baseline.evidence.assignments.every(
      (assignment) => assignment.endpoints.length === 2,
    ),
  );
  assert.equal(
    replay.correct,
    7,
    "manual corrections must never count as original successes",
  );
});

test("complete-wire scoring allows endpoint reversal and penalizes duplicates, missing ends and wrong boards", () => {
  assert.deepEqual(
    scoreHolePairs(["board_1:a1", "board_1:j2"], ["board_1:j2", "board_1:a1"]),
    { correct: 2, accepted: 2, wrong: 0, unresolved: 0, complete: true },
  );
  assert.equal(scoreHolePairs(["a1", "j2"], ["a1", "a1"]).correct, 1);
  assert.equal(scoreHolePairs(["a1", "j2"], ["a1", null]).complete, false);
  assert.equal(
    scoreHolePairs(["board_1:a1", "board_1:j2"], ["board_2:a1", "board_2:j2"])
      .correct,
    0,
  );
  const point = { x: 432, y: 544 };
  const ambiguous = replayEvaluation(
    [
      {
        id: "wire",
        boardId: "board_1",
        holes: ["f23", "f10"],
        proposals: [point, point],
      },
    ],
    [
      { calibration, rails: [] },
      { calibration: { ...calibration, breadboardId: "board_2" }, rails: [] },
    ],
  );
  assert.equal(ambiguous.accepted, 0);
});
