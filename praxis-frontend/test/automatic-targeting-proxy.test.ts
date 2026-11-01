import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnalysisJobProxy } from "../lib/server/analysis-job-proxy";
import { automaticWorkflowJob } from "./fixtures/automatic-targeting";

test("automatic proxy forwards the frozen authorization without computing cues or changing its request allowance", async () => {
  const job = automaticWorkflowJob(),
    record = job.automaticTargeting![0]!;
  const body = {
    workflowId: record.workflowId,
    authorizeInference: true,
    providerBaseUrl: record.providerBaseUrl,
    requests: record.budget.plannedRequests,
    pixels: record.budget.plannedPixels,
  };
  let calls = 0;
  const proxy = createAnalysisJobProxy({
    logger: () => {},
    fetcher: async (url, init) => {
      calls++;
      assert.equal(
        new URL(String(url)).pathname,
        `/api/analyses/${job.analysisId}/run-automatic-targeting`,
      );
      assert.equal(init!.method, "POST");
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)),
        body,
      );
      return Response.json(job, { status: 202 });
    },
  });
  const response = await proxy(
    new Request(
      `http://localhost/api/analyses/${job.analysisId}/run-automatic-targeting`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    "run-automatic-targeting",
    job.analysisId,
  );
  assert.equal(response.status, 202);
  assert.equal(calls, 1);
  assert.deepEqual(
    (await response.json()).automaticTargeting,
    job.automaticTargeting,
  );
});

test("private download preserves query binding, rejects foreign evidence and never submits inference", async () => {
  const job = automaticWorkflowJob(),
    workflowId = job.automaticTargeting![0]!.workflowId;
  for (const wrongBinding of [false, true]) {
    let calls = 0;
    const proxy = createAnalysisJobProxy({
      logger: () => {},
      fetcher: async (url, init) => {
        calls++;
        assert.equal(init!.method, "GET");
        assert.equal(
          new URL(String(url)).searchParams.get("workflowId"),
          workflowId,
        );
        return Response.json({
          schemaVersion: "praxis-automatic-targeting-evidence-v1",
          workflow: {
            workflowId,
            contract: {
              plan: { analysisId: wrongBinding ? "foreign" : job.analysisId },
            },
          },
        });
      },
    });
    const response = await proxy(
      new Request(
        `http://localhost/api/analyses/${job.analysisId}/automatic-targeting-evidence?workflowId=${workflowId}`,
      ),
      "automatic-targeting-evidence",
      job.analysisId,
    );
    assert.equal(response.status, wrongBinding ? 502 : 200);
    assert.equal(calls, 1);
    if (!wrongBinding)
      assert.match(response.headers.get("content-disposition")!, /attachment/);
  }
});
