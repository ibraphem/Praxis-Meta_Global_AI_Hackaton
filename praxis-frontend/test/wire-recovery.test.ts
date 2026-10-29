import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisJobSchema,
  jobIsActive,
  retryStage,
} from "../lib/analysis-jobs";
import { createAnalysisJobProxy } from "../lib/server/analysis-job-proxy";
import { recoveryReportSchema, wireIdentitySchema } from "../lib/wire-recovery";
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
