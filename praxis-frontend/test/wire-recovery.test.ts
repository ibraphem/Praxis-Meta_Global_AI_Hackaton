import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisJobSchema,
  jobIsActive,
  retryStage,
} from "../lib/analysis-jobs";
import { createAnalysisJobProxy } from "../lib/server/analysis-job-proxy";
import {
  recoveryReportSchema,
  wireIdentitySchema,
  effectiveIdentityReviews,
} from "../lib/wire-recovery";
import { completedJob } from "./fixtures/analysis-job";
import { recoveryReport } from "./fixtures/wire-recovery";

const result = {
  image: { width: 1426, height: 1008 },
  objects: [],
  provenance: {
    mode: "combined",
    reasoningModel: "muse",
    segmentationModel: "sam",
  },
};
function job() {
  const j = completedJob(result);
  j.recovery = {
    status: "succeeded",
    attempts: [],
    operation: "audit",
    budget: { requests: 0, pixels: 0, verificationRequests: 0, rounds: 0 },
    visited: [],
    report: recoveryReport(j.sam.attempts[0]!.attemptId),
  };
  return j;
}
test("new recovery responses and retry guards preserve separate candidate and connection contracts", () => {
  const j = job();
  assert.ok(analysisJobSchema.safeParse(j).success);
  j.recovery!.status = "running";
  assert.equal(jobIsActive(j), true);
  assert.equal(retryStage(j), null);
  const report = j.recovery!.report!;
  assert.equal(
    recoveryReportSchema.safeParse({
      ...report,
      candidates: [{ ...report.candidates[0], identityStatus: "verified" }],
    }).success,
    false,
  );
  assert.equal(
    recoveryReportSchema.safeParse({
      ...report,
      candidates: [{ ...report.candidates[0], guidanceEligible: true }],
    }).success,
    false,
  );
  assert.equal(
    recoveryReportSchema.safeParse({
      ...report,
      candidates: [
        {
          ...report.candidates[0],
          mask: { ...report.candidates[0]!.mask, path: "<script/>" },
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    wireIdentitySchema.safeParse({
      reviewId: j.analysisId,
      reportId: report.reportId,
      candidateIds: ["jumper_wire_1"],
      state: "verified",
      note: "observed",
      reviewSource: "human",
      reviewedAt: 1,
      electricalConnectionStatus: "established",
    }).success,
    false,
  );
});
test("recovery proxy forwards bounded JSON to fixed actions and validates the saved response", async () => {
  const j = job(),
    calls: { url: string; init: RequestInit | undefined }[] = [];
  const proxy = createAnalysisJobProxy({
    fetcher: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(j);
    },
  });
  for (const action of ["verify-wire", "wire-identities"] as const) {
    const body =
      action === "verify-wire"
        ? { candidateId: "jumper_wire_1" }
        : {
            reportId: j.recovery!.report!.reportId,
            candidateIds: ["jumper_wire_1"],
            state: "uncertain",
            note: "crossing obscures identity",
          };
    const response = await proxy(
      new Request("http://localhost/api/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      action,
      j.analysisId,
    );
    assert.equal(response.status, action === "wire-identities" ? 200 : 202);
    const call = calls.at(-1)!;
    assert.ok(call.url.endsWith(`/${j.analysisId}/${action}`));
    assert.equal(call.init!.method, "POST");
    assert.equal(
      JSON.parse(new TextDecoder().decode(call.init!.body as Uint8Array))
        .candidateId,
      action === "verify-wire" ? "jumper_wire_1" : undefined,
    );
  }
  const before = calls.length;
  const oversized = await proxy(
    new Request("http://localhost/api/analyses", {
      method: "POST",
      body: "x".repeat(8193),
    }),
    "wire-identities",
    j.analysisId,
  );
  assert.equal(oversized.status, 413);
  assert.equal(calls.length, before);
});

test("carried reviews keep human provenance and are superseded by explicit current decisions", () => {
  const j = job(),
    report = j.recovery!.report!;
  const source = {
    reviewId: j.sam.attempts[0]!.attemptId,
    reportId: "3".repeat(64),
    candidateIds: ["jumper_wire_8"],
    state: "verified" as const,
    note: "independent inspection",
    reviewSource: "human" as const,
    reviewedAt: 1,
    electricalConnectionStatus: "unestablished" as const,
  };
  report.reviewReconciliation = [
    {
      sourceReviewId: source.reviewId,
      sourceReportId: source.reportId,
      sourceCandidateIds: source.candidateIds,
      candidateIds: ["jumper_wire_1"],
      status: "carried",
      reason: "unchanged_evidence",
    },
  ];
  j.wireIdentities = [source];
  const carried = effectiveIdentityReviews(j.wireIdentities, report);
  assert.equal(carried[0]!.reviewedAt, 1);
  assert.equal(carried[0]!.inheritedFromReportId, source.reportId);
  assert.deepEqual(carried[0]!.candidateIds, ["jumper_wire_1"]);
  const direct = {
    ...source,
    reviewId: j.muse.attempts[0]!.attemptId,
    reportId: report.reportId,
    candidateIds: ["jumper_wire_1"],
    state: "uncertain" as const,
  };
  assert.deepEqual(effectiveIdentityReviews([source, direct], report), [
    direct,
  ]);
  report.reviewReconciliation[0]!.status = "needs_review";
  assert.equal(effectiveIdentityReviews([source], report).length, 0);
  assert.equal(analysisJobSchema.safeParse(j).success, true);
});

test("saved crop outcomes including interrupted and legacy unknown records pass through the proxy", async () => {
  const j = job();
  j.recovery!.cropAttempts = ["timed_out", "interrupted", "legacy_unknown"].map(
    (status, i) => ({
      attemptId: [
        j.analysisId,
        j.sam.attempts[0]!.attemptId,
        j.muse.attempts[0]!.attemptId,
      ][i]!,
      region: [0, 0, 100, 80],
      status: status as "timed_out" | "interrupted" | "legacy_unknown",
      upstreamOutcome: "unknown",
      startedAt: 1,
    }),
  );
  j.recovery!.report!.stopReason = "blocked_regions";
  const proxy = createAnalysisJobProxy({
    fetcher: async () => Response.json(j),
  });
  const response = await proxy(
    new Request("http://localhost/api/analyses"),
    "get",
    j.analysisId,
  );
  assert.equal(response.status, 200);
  const decoded = analysisJobSchema.parse(await response.json());
  assert.deepEqual(decoded.recovery!.cropAttempts, j.recovery!.cropAttempts);
});

test("selectable-evidence reconciliation metadata survives the saved-analysis schema without claiming identity or contact", () => {
  const source = "00000000-0000-4000-8000-000000000001";
  const selected = {
    ...result,
    objects: [
      {
        id: "jumper_wire_7",
        type: "jumper_wire",
        bbox: [10, 10, 80, 20],
        mask: {
          format: "svg_path",
          width: 80,
          height: 20,
          path: "M0 8L80 8L80 10L0 10Z",
        },
        interpretation: "uncertain",
        geometryStatus: "segmented",
        localizationSource: "sam",
        identityStatus: "unverified",
        guidanceEligible: false,
        selectionEvidence: {
          evidenceHash: "a".repeat(64),
          sourceSnapshotId: source,
          sourceAttemptId: source,
          state: "retained",
          requiresReview: true,
          reasons: ["not_selected_by_latest_interpretation"],
        },
      },
    ],
    provenance: {
      ...result.provenance,
      wireSelection: {
        version: "preserve-wire-evidence-v1",
        previousSnapshotId: source,
        previousAttemptId: source,
        restoredHistorical: 1,
        priorSelectable: 1,
        rawSelectable: 0,
        matched: 0,
        retained: 1,
        added: 0,
        reviewRequired: 1,
        deferredObjectIds: [],
      },
    },
  };
  const parsed = analysisJobSchema.parse(completedJob(selected));
  assert.deepEqual(
    parsed.result!.objects[0].selectionEvidence,
    selected.objects[0].selectionEvidence,
  );
  assert.equal(parsed.result!.objects[0].identityStatus, "unverified");
  assert.equal(parsed.result!.provenance.wireSelection!.restoredHistorical, 1);
  const unsafe = structuredClone(selected);
  unsafe.objects[0].guidanceEligible = true;
  assert.throws(() => completedJob(unsafe));
});
