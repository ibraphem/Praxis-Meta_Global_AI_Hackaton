import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  analysisJobSchema,
  jobIsActive,
  jobMessage,
} from "../lib/analysis-jobs";
import { SceneInventory, SceneOverlays } from "../components/scene-inventory";
import { ResultsPanel } from "../components/results-panel";
import { createAnalysisJobProxy } from "../lib/server/analysis-job-proxy";
import { sceneJob } from "./fixtures/scene";

test("scene contracts preserve dynamic labels and reject promoted identities, cross-image evidence and native mask leakage", () => {
  const job = sceneJob();
  assert.equal(
    analysisJobSchema.parse(job).scene!.graph!.objects[0]!.proposedType,
    "9V battery snap connector",
  );
  const promoted = structuredClone(job) as unknown as {
    scene: { graph: { objects: { recognitionStatus: string }[] } };
  };
  promoted.scene.graph.objects[0]!.recognitionStatus = "verified";
  assert.equal(analysisJobSchema.safeParse(promoted).success, false);
  const mismatch = structuredClone(job);
  mismatch.scene!.graph!.imageHash = "a".repeat(64);
  assert.equal(analysisJobSchema.safeParse(mismatch).success, false);
  const leakage = structuredClone(job);
  Object.assign(leakage.scene!.graph!.observations[0]!, {
    encodedMask: { payload: "private" },
  });
  assert.equal(analysisJobSchema.safeParse(leakage).success, false);
});

test("scene work keeps polling active without changing the legacy result or presenting connections as verified", () => {
  const job = sceneJob(),
    original = JSON.stringify(job.result);
  job.scene!.status = "running";
  assert.equal(jobIsActive(job), true);
  assert.match(jobMessage(job), /Existing candidates remain available/);
  job.scene!.status = "timed_out";
  assert.equal(jobIsActive(job), false);
  assert.equal(JSON.stringify(job.result), original);
  const html = renderToStaticMarkup(
    createElement(SceneInventory, {
      scene: job.scene!,
      selectedId: job.scene!.graph!.objects[0]!.id,
      onSelect() {},
      onRetry() {},
      busy: false,
    }),
  );
  assert.match(html, /9V battery snap connector/);
  assert.match(html, /prompt target/);
  assert.match(html, /electrical connections remain unestablished/);
  assert.doesNotMatch(html, /SAM SCORE|electrically connected/);
  const results = renderToStaticMarkup(
    createElement(ResultsPanel, {
      result: job.result!,
      scene: job.scene!,
      loading: false,
      selectedId: null,
      onSelect() {},
      elapsed: null,
    }),
  );
  assert.doesNotMatch(results, /No components identified/);
  assert.match(results, /Scene hypotheses are available above/);
});

test("scene overlay projects candidate mask geometry and estimated boxes in the original image frame", () => {
  const graph = sceneJob().scene!.graph!;
  const html = renderToStaticMarkup(
    createElement(SceneOverlays, { graph, selectedId: graph.objects[0]!.id }),
  );
  assert.match(html, /viewBox="0 0 100 80"/);
  assert.match(html, /translate\(10 20\) scale\(1 1\)/);
  assert.match(html, /left:10%/);
  assert.match(html, /top:25%/);
  assert.equal(
    renderToStaticMarkup(
      createElement(SceneOverlays, { graph, selectedId: null }),
    ),
    "",
  );
});

test("saved-job proxy forwards an explicit inventory retry and preserves scene evidence", async () => {
  const job = sceneJob();
  const proxy = createAnalysisJobProxy({
    fetcher: async (url, init) => {
      assert.equal(
        String(url),
        `http://127.0.0.1:3000/api/analyses/${job.analysisId}/retry-scene`,
      );
      assert.equal(init?.method, "POST");
      return Response.json(job, { status: 202 });
    },
  });
  const response = await proxy(
    new Request("http://localhost/api/analyses", { method: "POST" }),
    "retry-scene",
    job.analysisId,
  );
  assert.equal(response.status, 202);
  assert.equal(
    (await response.json()).scene.graph.objects[0].proposedType,
    "9V battery snap connector",
  );
});
