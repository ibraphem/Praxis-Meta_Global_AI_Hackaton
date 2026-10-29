import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { EndpointResponse } from "../lib/wires/proposals";
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

test("failed close-ups preserve same-run coarse scores while all unavailable endpoints remain in operational yield", () => {
  const { bundle, truth, report } = fixture();
  const before = scoreGrounding(bundle, truth, report).experiments[0];
  const index = before.results.findIndex((r) => r.correct === 2);
  const m = report.measurements[index];
  const coarseEndpoints = structuredClone(m.response.endpoints);
  m.status = "failed";
  m.response.endpoints = m.response.endpoints.map(
    (e: EndpointResponse["endpoints"][number]) => ({
      ...e,
      proposedImagePosition: null,
      evidence: "insufficient",
    }),
  );
  Object.assign(m.response, {
    localization: {
      status: "failed",
      errorCode: "INVALID_PROVIDER_OUTPUT",
      requestStatus: "failed",
      coarseEndpoints,
      frames: ["A", "B"].map((role) => ({
        role,
        bbox: [0, 0, 100, 100],
        width: 100,
        height: 100,
      })),
    },
  });
  const score = scoreGrounding(bundle, truth, report).experiments[0];
  assert.equal(score.coarse.correct, 8);
  assert.equal(score.coarse.availableEndpoints, 10);
  assert.equal(score.correct, 6);
  assert.equal(score.endpoints, 10);
  assert.equal(score.outcomeCounts.failed, 2);
  assert.equal(score.outcomeCounts.abstained, before.outcomeCounts.abstained);
  assert.equal(score.transitions.correctToUnavailable, 2);
  assert.equal(score.transitions.correctToAbstention, 0);
  assert.equal(score.coarseTransitions.correctToUnresolved, 2);
  assert.equal(score.coarseTransitions.correctToUnavailable, 2);
  assert.equal(score.refinementNoRegression, false);
  assert.equal(score.completedLocalization.endpoints, 8);
  assert.equal(score.completedLocalization.conditionalYield, 6 / 8);
  assert.equal(score.noRegression, false);
});

test("mixed close-up outcomes distinguish one completed model abstention from an endpoint without an anchor", () => {
  const { bundle, truth, report } = fixture();
  report.version = "endpoint-grounding-experiment-v2";
  const before = scoreGrounding(bundle, truth, report).experiments[0];
  const m =
    report.measurements[before.results.findIndex((r) => r.correct === 2)];
  const coarseEndpoints = structuredClone(m.response.endpoints);
  coarseEndpoints[1] = {
    ...coarseEndpoints[1],
    proposedImagePosition: null,
    evidence: "insufficient",
  };
  m.response.endpoints = coarseEndpoints.map(
    (e: EndpointResponse["endpoints"][number]) => ({
      ...e,
      proposedImagePosition: null,
      evidence: "insufficient",
    }),
  );
  Object.assign(m.response, {
    localization: {
      status: "completed",
      requestStatus: "succeeded",
      coarseEndpoints,
      frames: [{ role: "A", bbox: [0, 0, 100, 100], width: 100, height: 100 }],
      endpointOutcomes: [
        { role: "A", status: "abstained" },
        { role: "B", status: "no_anchor" },
      ],
    },
  });
  const score = scoreGrounding(bundle, truth, report).experiments[0];
  assert.equal(score.outcomeCounts.no_anchor, 1);
  assert.equal(score.transitions.correctToAbstention, 1);
  assert.equal(score.transitions.correctToSkipped, 1);
  assert.equal(score.transitions.correctToUnavailable, 0);
  assert.equal(score.completedLocalization.endpoints, 9);
  assert.equal(score.executionCounts.succeeded, 5);
  assert.equal(score.requestExecution, null); // Older artifacts lacking transport diagnostics must not imply zero requests.
});

test("a handled crop fragment is blocked, not a successful localization or coarse model abstention", () => {
  const { bundle, truth, report } = fixture();
  const m = report.measurements[0];
  m.response.endpoints = m.response.endpoints.map(
    (e: EndpointResponse["endpoints"][number]) => ({
      ...e,
      proposedImagePosition: null,
      evidence: "insufficient",
    }),
  );
  Object.assign(m.response, {
    localization: {
      status: "crop_fragment",
      coarseEndpoints: m.response.endpoints,
      frames: [],
    },
    diagnostics: {
      requestId: "00000000-0000-0000-0000-000000000000",
      elapsedMs: 1,
      timings: [],
    },
  });
  const score = scoreGrounding(bundle, truth, report).experiments[0];
  assert.equal(score.outcomeCounts.crop_fragment, 2);
  assert.equal(score.completedLocalization.endpoints, 8);
  assert.equal(score.coarse.availableEndpoints, 8);
  assert.equal(score.executionCounts.succeeded, 5);
});

test("coarse provenance and bounds are checked even when the active refinement failed", () => {
  const { bundle, truth, report } = fixture();
  const m = report.measurements[0];
  m.status = "failed";
  const coarseEndpoints = structuredClone(m.response.endpoints);
  coarseEndpoints[0].proposedImagePosition = [
    bundle.analysis.image.width + 1,
    100,
  ];
  Object.assign(m.response, {
    localization: { status: "failed", coarseEndpoints, frames: [] },
  });
  assert.throws(
    () => scoreGrounding(bundle, truth, report),
    /provenance or bounds/,
  );
});
