import assert from "node:assert/strict";
import { test } from "node:test";
import { automaticWorkflowJob } from "./fixtures/automatic-targeting";
import { analysisJobSchema, jobIsActive } from "../lib/analysis-jobs";
import { buildSceneEvaluationEvidence } from "../lib/scene-evaluation-bundle";

test("real server-generated synthetic records survive public validation and complete browser export without implying photographic readiness", () => {
  const job = automaticWorkflowJob(),
    before = JSON.stringify(job);
  const bundle = buildSceneEvaluationEvidence({
    job,
    imageHash: job.imageHash,
    image: job.image,
    analysis: job.result!,
    analysisRunId: job.revision,
    endpointRequests: [],
    capturedAt: Date.now(),
  });
  assert.deepEqual(
    bundle.automaticTargeting.experiments,
    job.automaticTargeting,
  );
  const record = bundle.automaticTargeting.experiments[0]!;
  assert.equal(record.evaluation!.status, "synthetic_pass");
  assert.equal(record.evaluation!.independentGroundTruth, false);
  assert.equal(record.accounting.dispatchAttempts, 2);
  assert.equal(record.accounting.providerConfirmedUsage, null);
  assert.equal(record.measurements.length, 2);
  assert.equal(record.budget.scope, "isolated_experiment");
  assert.equal(JSON.stringify(bundle).includes("base64"), false);
  assert.equal(JSON.stringify(job), before);
  job.automaticTargeting![0]!.status = "starting";
  assert.equal(jobIsActive(job), true);
});

test("public experiment schema rejects unsafe masks and retains spent unknown usage after release", () => {
  const job = automaticWorkflowJob(),
    record = job.automaticTargeting![0]!;
  record.status = "released";
  record.phase = "outcome_unknown";
  record.accounting.unknownUsageRequests = 1;
  const parsed = analysisJobSchema.parse(job);
  assert.equal(
    parsed.automaticTargeting![0]!.accounting.unknownUsageRequests,
    1,
  );
  record.measurements[0]!.previews[0]!.mask!.path = "<script>";
  assert.equal(analysisJobSchema.safeParse(job).success, false);
});
