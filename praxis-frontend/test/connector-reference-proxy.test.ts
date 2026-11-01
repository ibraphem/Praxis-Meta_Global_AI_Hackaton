import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createAnalysisJobProxy } from "../lib/server/analysis-job-proxy";
import { automaticWorkflowJob } from "./fixtures/automatic-targeting";

function annotationView() {
  const job = automaticWorkflowJob(),
    r = job.automaticTargeting![0]!;
  return {
    schemaVersion: "praxis-connector-annotation-view-v1",
    analysisId: job.analysisId,
    workflowId: r.workflowId,
    imageHash: job.imageHash,
    imageUrl: `/api/analyses/${job.analysisId}/connector-annotation-image?workflowId=${r.workflowId}`,
    draft: {
      draftId: randomUUID(),
      workflowId: r.workflowId,
      imageHash: job.imageHash,
      objectId: r.objectId,
      image: job.image,
      revision: 0,
      updatedAt: 0,
      content: {
        version: "connector-annotation-v1",
        annotationMethod: "manual_brush",
        regions: { connector: [], redWire: [], blackWire: [], uncertain: [] },
        reviewer: "Unassigned",
        source: "human_review",
        predictionExposure: "unknown",
        originalImageOnly: false,
        independentAttestation: false,
        boundaryDefinition:
          "Visible connector body, excluding separately visible insulated wires.",
      },
    },
    references: [],
    note: "Original image and reviewer annotations only.",
  };
}
test("annotation proxy rejects prediction-bearing responses and preserves the bound original-only view", async () => {
  const view = annotationView();
  for (const leaked of [false, true]) {
    let posts = 0;
    const proxy = createAnalysisJobProxy({
      logger: () => {},
      fetcher: async (url, init) => {
        assert.equal(
          new URL(String(url)).searchParams.get("workflowId"),
          view.workflowId,
        );
        if (init!.method === "POST") posts++;
        return Response.json({
          ...view,
          ...(leaked ? { prediction: { mask: "forbidden" } } : {}),
        });
      },
    });
    const response = await proxy(
      new Request(
        `http://localhost/api/analyses/${view.analysisId}/connector-annotation?workflowId=${view.workflowId}`,
      ),
      "connector-annotation",
      view.analysisId,
    );
    assert.equal(response.status, leaked ? 502 : 200);
    assert.equal(posts, 0);
    if (!leaked) assert.deepEqual(await response.json(), view);
  }
});
test("annotation save uses the annotation-only response without interpreting or requesting model results", async () => {
  const view = annotationView(),
    payload = {
      workflowId: view.workflowId,
      revision: 0,
      content: view.draft.content,
    };
  const proxy = createAnalysisJobProxy({
    logger: () => {},
    fetcher: async (_url, init) => {
      assert.equal(init!.method, "POST");
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)),
        payload,
      );
      return Response.json(view);
    },
  });
  const response = await proxy(
    new Request(
      `http://localhost/api/analyses/${view.analysisId}/save-connector-reference`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),
    "save-connector-reference",
    view.analysisId,
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).schemaVersion,
    "praxis-connector-annotation-view-v1",
  );
});
