import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  analysisJobSchema,
  jobIsActive,
  jobMessage,
} from "../lib/analysis-jobs";
import {
  SceneInventory,
  SceneInventoryNotRun,
  SceneOverlays,
} from "../components/scene-inventory";
import { ResultsPanel } from "../components/results-panel";
import {
  SceneObjectOverlays,
  SceneObjectPanel,
} from "../components/scene-objects";
import { createAnalysisJobProxy } from "../lib/server/analysis-job-proxy";
import { sceneJob, groupedSceneJob } from "./fixtures/scene";

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
  Object.assign(leakage.scene!.graph!.observations[1]!, {
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
  assert.match(results, /Object hypotheses/);
  assert.doesNotMatch(results, /S1 ·/);
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
  const unselected = renderToStaticMarkup(
    createElement(SceneOverlays, { graph, selectedId: null }),
  );
  assert.match(unselected, /9V battery snap connector/);
  assert.doesNotMatch(unselected, /<path/); // inventory boxes do not depend on mask or selection
});

test("absent inventory is explicit for a disabled upload and offers a separate saved-photo discovery action", () => {
  const job = sceneJob();
  delete job.scene;
  job.settings.dynamicScene = false;
  const html = renderToStaticMarkup(
    createElement(SceneInventoryNotRun, { job, busy: false, onStart() {} }),
  );
  assert.match(html, /Not run for this analysis/);
  assert.match(html, /disabled when this photograph was uploaded/);
  assert.match(html, /Discover scene objects/);
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

test("saved-job proxy supports an explicit discovery start without creating another analysis", async () => {
  const job = sceneJob();
  const proxy = createAnalysisJobProxy({
    fetcher: async (url, init) => {
      assert.equal(
        String(url),
        `http://127.0.0.1:3000/api/analyses/${job.analysisId}/start-scene`,
      );
      assert.equal(init?.method, "POST");
      return Response.json(job, { status: 202 });
    },
  });
  const response = await proxy(
    new Request("http://localhost/api/analyses", { method: "POST" }),
    "start-scene",
    job.analysisId,
  );
  assert.equal(response.status, 202);
});

test("object view uses one named primary label and keeps raw segmentation in Evidence or selection", () => {
  const job = sceneJob(),
    graph = job.scene!.graph!;
  const html = renderToStaticMarkup(
    createElement(SceneObjectOverlays, {
      graph,
      result: job.result!,
      selectedId: null,
      onSelect() {},
    }),
  );
  assert.match(html, /Inspect 9V battery snap connector object hypothesis/);
  assert.doesNotMatch(html, /<path|S1|Wire region/);
  assert.match(html, /Approximate Muse location/);
  const selected = renderToStaticMarkup(
    createElement(SceneObjectOverlays, {
      graph,
      result: job.result!,
      selectedId: graph.objects[0]!.id,
      onSelect() {},
    }),
  );
  assert.match(selected, /<path/);
  assert.match(selected, /boundary unconfirmed/);
});

test("scene understanding proxy forwards exact checkpoint and target JSON to fixed actions", async () => {
  const job = sceneJob(),
    ref = job.scene!.snapshotRef!;
  for (const action of [
    "reconcile-scene",
    "discover-terminals",
    "guide-scene",
    "refresh-scene",
  ] as const) {
    const payload = {
      snapshotId: ref.snapshotId,
      snapshotHash: ref.snapshotHash,
      ...(action === "discover-terminals"
        ? { objectIds: [job.scene!.graph!.objects[0]!.id] }
        : action === "guide-scene"
          ? {
              objectIds: [job.scene!.graph!.objects[0]!.id],
              guidedBudget: { maxRequests: 3, maxPixels: 6000000 },
            }
          : {}),
    };
    const proxy = createAnalysisJobProxy({
      fetcher: async (url, init) => {
        assert.equal(
          String(url),
          `http://127.0.0.1:3000/api/analyses/${job.analysisId}/${action}`,
        );
        assert.equal(
          new Headers(init?.headers).get("content-type"),
          "application/json",
        );
        assert.deepEqual(
          JSON.parse(Buffer.from(init?.body as Uint8Array).toString()),
          payload,
        );
        return Response.json(job, {
          status: action !== "reconcile-scene" ? 202 : 200,
        });
      },
    });
    const r = await proxy(
      new Request("http://localhost/api/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      action,
      job.analysisId,
    );
    assert.equal(r.status, action !== "reconcile-scene" ? 202 : 200);
  }
});

test("proposed groups expose members, require an explicit terminal member, and have a separate-members presentation", () => {
  const job = groupedSceneJob(),
    graph = job.scene!.graph!;
  const panel = renderToStaticMarkup(
    createElement(SceneObjectPanel, {
      graph,
      result: job.result!,
      job,
      selectedId: graph.objects[0]!.id,
      onSelect() {},
      busy: false,
      mode: "objects",
      onModeChange() {},
      onAction() {},
    }),
  );
  assert.match(panel, /Grouped by proposal.*2.*members/);
  assert.match(panel, /Original members \(2\)/);
  assert.match(panel, /Confirm same object/);
  assert.match(panel, /Selective terminal discovery/);
  assert.match(panel, /not attempted/);
  assert.match(panel, /disabled="">Discover selected terminals \(0\)/);
  for (const object of graph.objects)
    assert.match(panel, new RegExp(object.id));
  const split = renderToStaticMarkup(
    createElement(SceneObjectOverlays, {
      graph,
      result: job.result!,
      selectedId: null,
      onSelect() {},
      separateMembers: true,
    }),
  );
  assert.equal(
    (split.match(/Inspect 9V battery snap connector object hypothesis/g) ?? [])
      .length,
    2,
  );
});

test("reference-only terminal evidence has a distinct marker, unresolved contact and selective coverage", () => {
  const job = sceneJob(),
    graph = job.scene!.graph!,
    object = graph.objects[0]!;
  const id = "d5a65f52-5192-4a16-9d79-88ac7967064a";
  graph.version = "scene-v2";
  object.terminalIds.push(id);
  graph.terminals = [
    {
      id,
      objectId: object.id,
      label: "A",
      physicalKind: "unknown",
      location: null,
      locationStatus: "unresolved",
      locationEvidence: "occluded",
      reference: { position: [20, 30], evidence: "insulated_housing_junction" },
      pinLabel: null,
      electricalRole: null,
      roleStatus: "unresolved",
      roleMarking: null,
      observationIds: [graph.observations[0]!.id],
      attemptId: job.scene!.attempts[0]!.attemptId,
      requestId: id,
      model: "fixture",
      promptVersion: "physical-terminals-v2",
    },
  ];
  assert.ok(analysisJobSchema.safeParse(job).success);
  const props = {
    graph,
    result: job.result!,
    job,
    selectedId: object.id,
    onSelect() {},
    busy: false,
    mode: "objects" as const,
    onModeChange() {},
  };
  const panel = renderToStaticMarkup(createElement(SceneObjectPanel, props));
  assert.match(panel, /Contact location:.*unresolved/);
  assert.match(panel, /Reference point:.*insulated housing junction/);
  assert.match(panel, /examined but unresolved/);
  assert.doesNotMatch(panel, /visible contact proposed/);
  const overlay = renderToStaticMarkup(
    createElement(SceneObjectOverlays, props),
  );
  assert.match(overlay, /Reference only: insulated_housing_junction/);
  assert.doesNotMatch(overlay, /<circle/);
});
