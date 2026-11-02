import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analysisJobSchema } from "../lib/analysis-jobs";
import { createAnalysisJobProxy } from "../lib/server/analysis-job-proxy";
import { buildSceneEvaluationEvidence } from "../lib/scene-evaluation-bundle";
const fixture = () =>
  analysisJobSchema.parse(
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), "test/fixtures/connector-junctions.json"),
        "utf8",
      ),
    ).job,
  );
test("real backend synthetic junction contract exports original outcomes, source bindings and one-call accounting", () => {
  const job = fixture(),
    r = job.connectorJunctions![0]!;
  assert.equal(r.outcomes.length, 2);
  assert.equal(r.accounting.dispatchAttempts, 1);
  assert.equal(r.plan.budget.samRequests, 0);
  assert.ok(
    r.outcomes.every(
      (o) => o.kind === "housing_entry" && o.contactPosition === null,
    ),
  );
  const bundle = buildSceneEvaluationEvidence({
    job,
    imageHash: job.imageHash,
    image: job.image,
    analysis: job.result!,
    analysisRunId: job.revision,
    endpointRequests: [],
    capturedAt: 1,
  });
  assert.deepEqual(bundle.connectorJunctions, job.connectorJunctions);
  const wrong = structuredClone(job);
  wrong.connectorJunctions![0]!.plan.imageHash = "f".repeat(64);
  assert.equal(analysisJobSchema.safeParse(wrong).success, false);
});
test("junction proxy forwards only fixed actions and binds private evidence to plan and analysis", async () => {
  const job = fixture(),
    planId = job.connectorJunctions![0]!.plan.planId;
  let calls = 0;
  const proxy = createAnalysisJobProxy({
    environment: { PRAXIS_BACKEND_URL: "http://127.0.0.1:3000" },
    fetcher: async (url, init) => {
      calls++;
      const endpoint = new URL(String(url));
      assert.equal(init?.method, "GET");
      assert.equal(
        endpoint.pathname,
        `/api/analyses/${job.analysisId}/connector-junction-evidence`,
      );
      assert.equal(endpoint.searchParams.get("planId"), planId);
      return Response.json({
        schemaVersion: "praxis-connector-junction-evidence-v1",
        analysisId: job.analysisId,
        record: job.connectorJunctions![0],
        privateEvidence: { source: "synthetic fixture" },
      });
    },
  });
  const good = await proxy(
    new Request(
      `http://localhost/api/analyses/${job.analysisId}/connector-junction-evidence?planId=${planId}`,
    ),
    "connector-junction-evidence",
    job.analysisId,
  );
  assert.equal(good.status, 200);
  assert.match(good.headers.get("content-disposition")!, /attachment/);
  const invalid = await proxy(
    new Request(
      `http://localhost/api/analyses/${job.analysisId}/connector-junction-evidence?planId=invalid`,
    ),
    "connector-junction-evidence",
    job.analysisId,
  );
  assert.equal(invalid.status, 400);
  assert.equal(calls, 1);
});
