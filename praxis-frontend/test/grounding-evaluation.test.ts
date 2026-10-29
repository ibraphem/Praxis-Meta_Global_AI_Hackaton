import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { scoreGrounding } from "../lib/wires/grounding-evaluation";
const load = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../benchmarks/eight-of-ten-2026-10-29/${name}`, import.meta.url),
      "utf8",
    ),
  );
function fixture() {
  const bundle = load("bundle.json"),
    truth = load("truth.json");
  bundle.analysis.provenance.samSnapshotHash = "a".repeat(64);
  const report = {
    version: "endpoint-grounding-experiment-v1",
    imageHash: truth.imageSha256,
    snapshotRef: { samSnapshotHash: "a".repeat(64) },
    measurements: truth.wires.map((w: { id: string }) => {
      const p = bundle.reviews.find(
        (r: { proposal: { wireCandidateId: string } }) =>
          r.proposal.wireCandidateId === w.id,
      ).proposal;
      return {
        variant: "candidate_crop",
        run: 0,
        wireCandidateId: w.id,
        status: "succeeded",
        response: {
          analysisId: bundle.analysisRunId,
          imageId: bundle.image.id,
          wireCandidateId: w.id,
          model: "mock",
          endpoints: p.endpoints.map(
            (e: {
              role: string;
              proposedImagePosition: number[] | null;
              evidence: string;
            }) => ({
              role: e.role,
              proposedImagePosition: e.proposedImagePosition,
              evidence: e.evidence,
              connectorJunctionPosition: null,
            }),
          ),
        },
      };
    }),
    batches: [
      { variant: "candidate_crop", run: 0, wallMs: 70000, providerRequests: 5 },
    ],
  };
  return { bundle, truth, report };
}
test("grounding replay uses original proposals, preserves every truth endpoint and reports unchanged baseline accurately", () => {
  const { bundle, truth, report } = fixture(),
    before = JSON.stringify(bundle),
    score = scoreGrounding(bundle, truth, report);
  assert.equal(score.baseline.correct, 8);
  assert.equal(score.experiments[0].correct, 8);
  assert.equal(score.experiments[0].endpoints, 10);
  assert.equal(score.experiments[0].transitions.correctToWrong, 0);
  assert.equal(JSON.stringify(bundle), before);
});
test("missing calls remain unresolved and regressions cannot be hidden by dropping measured wires", () => {
  const { bundle, truth, report } = fixture();
  report.measurements.splice(0, 1);
  const score = scoreGrounding(bundle, truth, report);
  assert.equal(score.experiments[0].endpoints, 10);
  assert.ok(score.experiments[0].unresolved >= 2);
  assert.ok(score.experiments[0].transitions.correctToUnresolved > 0);
  assert.equal(score.experiments[0].nextTargetsMet, false);
});
test("grounding scorer refuses stale calibration and mismatched endpoint response identities", () => {
  const { bundle, truth, report } = fixture();
  report.measurements[0].response.wireCandidateId = "jumper_wire_99";
  assert.throws(() => scoreGrounding(bundle, truth, report), /provenance/);
  const again = fixture();
  again.bundle.boards[0].revision++;
  assert.throws(
    () => scoreGrounding(again.bundle, again.truth, again.report),
    /stale/,
  );
});
