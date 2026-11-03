import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sceneJob } from "../fixtures/scene";
import { randomUUID } from "node:crypto";

test("saved scene hypotheses remain selectable during discovery and inspection overlays survive a reload", async ({
  page,
}, testInfo) => {
  // Synthetic labels test UI behavior, not recognition accuracy on this fixture image.
  const job = sceneJob(1426, 1008);
  job.scene!.status = "running";
  const image = readFileSync(
    resolve(
      process.cwd(),
      "test/fixtures/exact-hole-v1/jumper_wires_breadboard.png",
    ),
  );
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (route) =>
    route.fulfill({ contentType: "image/png", body: image }),
  );
  await page.goto(`/workspace?analysis=${job.analysisId}`);
  const panel = page.getByRole("region", { name: "Reconciled scene objects" });
  await expect(panel).toBeVisible();
  const locations = page.getByLabel("Physical object hypotheses", {
    exact: true,
  });
  const label = locations.getByRole("button", {
    name: /9V battery snap connector/,
  });
  await expect(label).toBeVisible();
  await expect(
    panel.getByRole("region", { name: "Selected object evidence" }),
  ).toHaveCount(0);
  await label.click();
  await expect(
    panel.getByRole("region", { name: "Selected object evidence" }),
  ).toContainText("Physical identity proposed");
  await panel.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Dynamic scene inventory" }),
  ).toContainText("prompt target");
  await page.getByRole("button", { name: "Objects", exact: true }).click();
  await page.reload();
  await expect(panel).toBeVisible();
  await label.click();
  await expect(panel).toContainText("electrical connection unestablished");
  const labelBounds = await label.boundingBox();
  expect(labelBounds!.height).toBeLessThan(50);
  expect(labelBounds!.width).toBeGreaterThan(100);
  await page.screenshot({
    path: testInfo.outputPath("scene-inventory.png"),
    fullPage: true,
  });
});

test("disabled saved analysis offers discovery and displays returned object boxes without requiring selection", async ({
  page,
}) => {
  const job = sceneJob(1426, 1008),
    discovered = job.scene!;
  delete job.scene;
  job.settings.dynamicScene = false;
  job.sam.snapshotRef = {
    samSnapshotId: randomUUID(),
    samSnapshotHash: "2".repeat(64),
    imageHash: job.imageHash,
    model: "sam-test",
    processingVersion: "sam-checkpoint-v1",
    sourceAttemptId: job.sam.attempts[0]!.attemptId,
    createdAt: job.createdAt,
    origin: "recorded",
  };
  const baselineRevision = job.revision;
  const image = readFileSync(
    resolve(
      process.cwd(),
      "test/fixtures/exact-hole-v1/jumper_wires_breadboard.png",
    ),
  );
  let starts = 0,
    creates = 0;
  await page.route("**/api/analyses", (route) => {
    creates++;
    return route.fulfill({ status: 500 });
  });
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (route) =>
    route.fulfill({ contentType: "image/png", body: image }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/start-scene`, (route) => {
    starts++;
    job.scene = {
      ...discovered,
      enabledBy: "manual",
      settings: {
        timeoutMs: 45000,
        maxRequests: 0,
        maxPixels: 6000000,
        maxCropPixels: 2000000,
      },
    };
    return route.fulfill({ status: 202, json: job });
  });
  await page.goto(`/workspace?analysis=${job.analysisId}`);
  const panel = page.getByRole("region", { name: "Dynamic scene inventory" });
  await expect(panel).toContainText("Not run for this analysis");
  await expect(panel).toContainText(
    "disabled when this photograph was uploaded",
  );
  await panel.getByRole("button", { name: "Discover scene objects" }).click();
  await expect(
    page
      .getByLabel("Physical object hypotheses", { exact: true })
      .getByRole("button", { name: /9V battery snap connector/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Selected scene object locations")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("region", { name: "Reconciled scene objects" }),
  ).toBeVisible();
  await expect(
    page.getByText("Not run for this analysis.", { exact: true }),
  ).toHaveCount(0);
  expect(starts).toBe(1);
  expect(creates).toBe(0);
  expect(job.revision).toBe(baselineRevision);
});

test("terminal proposals preserve unresolved roles and attachments without changing the baseline revision", async ({
  page,
}) => {
  const job = sceneJob(1426, 1008),
    graph = job.scene!.graph!,
    object = graph.objects[0]!,
    ref = job.scene!.snapshotRef!;
  const revision = job.revision;
  let requests = 0;
  const image = readFileSync(
    resolve(
      process.cwd(),
      "test/fixtures/exact-hole-v1/jumper_wires_breadboard.png",
    ),
  );
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (route) =>
    route.fulfill({ contentType: "image/png", body: image }),
  );
  await page.route(
    `**/api/analyses/${job.analysisId}/discover-terminals`,
    async (route) => {
      requests++;
      expect(route.request().postDataJSON()).toEqual({
        snapshotId: ref.snapshotId,
        snapshotHash: ref.snapshotHash,
        objectIds: [object.id],
      });
      const attemptId = randomUUID(),
        requestId = randomUUID(),
        terminalId = randomUUID(),
        observationId = randomUUID();
      graph.version = "scene-v2";
      object.terminalIds.push(terminalId);
      graph.observations.push({
        id: observationId,
        kind: "keypoint",
        source: "muse",
        model: "muse-test",
        attemptId,
        requestId,
        bbox: [20, 30, 1, 1],
      });
      graph.terminals = [
        {
          id: terminalId,
          objectId: object.id,
          label: "A",
          physicalKind: "contact",
          location: [20, 30],
          locationStatus: "observed",
          locationEvidence: "visible_terminal",
          pinLabel: null,
          electricalRole: null,
          roleStatus: "unresolved",
          roleMarking: null,
          observationIds: [observationId],
          attemptId,
          requestId,
          model: "muse-test",
          promptVersion: "physical-terminals-v1",
        },
      ];
      job.scene!.budget.terminalRequests = 1;
      job.scene!.terminalWork = [
        {
          requestId,
          attemptId,
          objectId: object.id,
          inputSnapshotId: ref.snapshotId,
          inputSnapshotHash: ref.snapshotHash,
          crop: [0, 0, 50, 60],
          status: "succeeded",
          upstreamOutcome: "response_received",
          startedAt: job.createdAt,
          finishedAt: job.createdAt + 10,
        },
      ];
      return route.fulfill({ status: 202, json: job });
    },
  );
  await page.goto(`/workspace?analysis=${job.analysisId}`);
  const panel = page.getByRole("region", { name: "Reconciled scene objects" });
  await panel
    .getByRole("button", { name: /9V battery snap connector/ })
    .click();
  await panel
    .getByRole("button", {
      name: "Discover selected terminals (1)",
      exact: true,
    })
    .click();
  await expect(panel).toContainText("Terminal A");
  await expect(panel).toContainText("Role: unresolved");
  await expect(panel).toContainText("electrical connection unestablished");
  expect(requests).toBe(1);
  expect(job.revision).toBe(revision);
});

test("proposed identity groups are inspectable and separable and a review only changes identity", async ({
  page,
}) => {
  const { groupedSceneJob } = await import("../fixtures/scene");
  const { reconcileSceneGraph } =
    await import("../../lib/scene-reconciliation");
  const job = groupedSceneJob(1426, 1008),
    graph = job.scene!.graph!;
  const image = readFileSync(
    resolve(
      process.cwd(),
      "test/fixtures/exact-hole-v1/jumper_wires_breadboard.png",
    ),
  );
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (route) =>
    route.fulfill({ contentType: "image/png", body: image }),
  );
  let reviews = 0;
  await page.route(
    `**/api/analyses/${job.analysisId}/reconcile-scene`,
    (route) => {
      reviews++;
      const body = route.request().postDataJSON();
      expect(body.snapshotId).toBe(job.scene!.snapshotRef!.snapshotId);
      expect(body.snapshotHash).toBe(job.scene!.snapshotRef!.snapshotHash);
      expect(body.identityReview.decision).toBe("same_object");
      job.scene!.graph = reconcileSceneGraph(graph);
      job.scene!.graph.identityReviews = [
        {
          id: randomUUID(),
          ...body.identityReview,
          source: "human_review",
          inputSnapshotId: body.snapshotId,
          inputSnapshotHash: body.snapshotHash,
          reviewedAt: Date.now(),
        },
      ];
      job.scene!.snapshotRef!.snapshotId = randomUUID();
      job.scene!.snapshotRef!.snapshotHash = "a".repeat(64);
      return route.fulfill({ json: job });
    },
  );
  await page.goto(`/workspace?analysis=${job.analysisId}`);
  const panel = page.getByRole("region", { name: "Reconciled scene objects" });
  await expect(panel).toContainText("Grouped by proposal · 2 members");
  await panel
    .locator(".scene-inventory-list")
    .getByRole("button")
    .first()
    .click();
  await expect(panel).toContainText("Original members (2)");
  await expect(
    panel.getByRole("button", {
      name: "Discover selected terminals (0)",
      exact: true,
    }),
  ).toBeDisabled();
  await panel
    .getByRole("button", { name: /Muse inventory member/ })
    .first()
    .click();
  await expect(
    panel.getByRole("button", {
      name: "Discover selected terminals (1)",
      exact: true,
    }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "Show separately", exact: true })
    .click();
  await expect(
    page
      .getByLabel("Physical object hypotheses", { exact: true })
      .getByRole("button"),
  ).toHaveCount(2);
  await panel.getByRole("button", { name: "Objects", exact: true }).click();
  await panel
    .getByRole("button", { name: "Confirm same object", exact: true })
    .click();
  await expect(panel).toContainText("Confirmed same object · 2 members");
  await expect(panel).toContainText("electrical connection unestablished");
  expect(job.scene!.graph!.terminals ?? []).toEqual([]);
  expect(reviews).toBe(1);
  await page.reload();
  await expect(panel).toContainText("Confirmed same object · 2 members");
});

test("guided segmentation submits the bounded targets and exposes independent mask review", async ({
  page,
}) => {
  const job = sceneJob(1426, 1008),
    graph = job.scene!.graph!,
    object = graph.objects[0]!;
  const returnedMask = graph.observations.find((o) => o.source === "sam")!;
  const returnedAssociation = graph.associations.find(
    (a) => a.basis === "prompt_target",
  )!;
  graph.observations = graph.observations.filter(
    (o) => o.id !== returnedMask.id,
  );
  graph.associations = graph.associations.filter(
    (a) => a.id !== returnedAssociation.id,
  );
  object.segmentationStatus = "not_attempted";
  const image = readFileSync(
    resolve(
      process.cwd(),
      "test/fixtures/exact-hole-v1/jumper_wires_breadboard.png",
    ),
  );
  await page.route(`**/api/analyses/${job.analysisId}`, (r) =>
    r.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (r) =>
    r.fulfill({ contentType: "image/png", body: image }),
  );
  let guided = 0,
    reviews = 0;
  await page.route(`**/api/analyses/${job.analysisId}/guide-scene`, (r) => {
    guided++;
    const body = r.request().postDataJSON();
    expect(body.guidedBudget).toEqual({ maxRequests: 3, maxPixels: 6000000 });
    expect(body.objectIds).toEqual([object.id]);
    job.scene!.settings = {
      timeoutMs: 45000,
      maxRequests: 3,
      maxPixels: 6000000,
      maxCropPixels: 2000000,
    };
    graph.version = "scene-v2";
    graph.observations.push(returnedMask);
    graph.associations.push(returnedAssociation);
    object.segmentationStatus = "candidates_returned";
    job.scene!.budget.requests = 1;
    return r.fulfill({ status: 202, json: job });
  });
  await page.route(`**/api/analyses/${job.analysisId}/reconcile-scene`, (r) => {
    reviews++;
    const body = r.request().postDataJSON();
    expect(body.maskReview.decision).toBe("rejected");
    expect(body.maskReview.source).toBe("human_review");
    graph.maskIdentityReviews = [
      {
        id: randomUUID(),
        ...body.maskReview,
        inputSnapshotId: body.snapshotId,
        inputSnapshotHash: body.snapshotHash,
        reviewedAt: Date.now(),
      },
    ];
    return r.fulfill({ json: job });
  });
  await page.goto(`/workspace?analysis=${job.analysisId}`);
  const panel = page.getByRole("region", { name: "Reconciled scene objects" });
  await panel
    .getByRole("button", { name: "Segment scene targets (1)", exact: true })
    .click();
  await panel
    .locator(".scene-inventory-list")
    .getByRole("button")
    .first()
    .click();
  await expect(panel).toContainText("Mask identity: unreviewed");
  await expect(
    panel.getByRole("button", { name: "Accept object mask", exact: true }),
  ).toBeDisabled();
  await panel
    .getByLabel("Visible mask evidence")
    .fill("This mask follows the adjacent wire, not the connector housing.");
  await panel
    .getByRole("button", { name: "Reject object mask", exact: true })
    .click();
  await expect(panel).toContainText("rejected · human review");
  expect(guided).toBe(1);
  expect(reviews).toBe(1);
  expect(graph.electricalConnectionStatus).toBe("unestablished");
});

test("ambiguity clusters expose stable members and retain checkpoint-bound reviews without merging", async ({
  page,
}) => {
  const job = sceneJob(1426, 1008),
    graph = job.scene!.graph!;
  const original = graph.objects[0]!;
  const copy = { ...structuredClone(original), id: randomUUID() };
  graph.version = "scene-v2";
  graph.objects.push(copy);
  const observation = { ...graph.observations[0]!, id: randomUUID() };
  graph.observations.push(observation);
  graph.associations.push({
    id: randomUUID(),
    objectId: copy.id,
    observationId: observation.id,
    relation: "unknown",
    basis: "inventory",
    status: "proposed",
    attemptId: observation.attemptId,
  });
  const cluster = {
    id: randomUUID(),
    memberObjectIds: [original.id, copy.id],
    relatedClusterIds: [],
    evidence: [
      {
        proposalObjectId: copy.id,
        candidateObjectId: original.id,
        observationId: observation.id,
        attemptId: observation.attemptId,
        eligible: true,
        semanticOverlap: 1,
        iou: 1,
        containment: 1,
        ratio: 1,
        sharedBoardAnchor: null,
        sharedSegmentation: [],
        wireSafeguard: false,
      },
    ],
  };
  graph.ambiguityClusters = [cluster];
  const originalCount = graph.objects.length;
  const image = readFileSync(
    resolve(
      process.cwd(),
      "test/fixtures/exact-hole-v1/jumper_wires_breadboard.png",
    ),
  );
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (route) =>
    route.fulfill({ contentType: "image/png", body: image }),
  );
  let reviews = 0;
  await page.route(
    `**/api/analyses/${job.analysisId}/reconcile-scene`,
    (route) => {
      const body = route.request().postDataJSON();
      expect(body.snapshotId).toBe(job.scene!.snapshotRef!.snapshotId);
      expect(body.snapshotHash).toBe(job.scene!.snapshotRef!.snapshotHash);
      expect(body.ambiguityReview).toEqual({
        clusterId: cluster.id,
        memberObjectIds: cluster.memberObjectIds,
        decision: "uncertain",
      });
      graph.ambiguityReviews = [
        {
          id: randomUUID(),
          ...body.ambiguityReview,
          source: "human_review",
          inputSnapshotId: body.snapshotId,
          inputSnapshotHash: body.snapshotHash,
          reviewedAt: Date.now(),
        },
      ];
      job.scene!.snapshotRef!.snapshotId = randomUUID();
      job.scene!.snapshotRef!.snapshotHash = "b".repeat(64);
      reviews++;
      return route.fulfill({ json: job });
    },
  );
  await page.goto(`/workspace?analysis=${job.analysisId}`);
  const section = page.getByRole("region", {
    name: "Identity ambiguity clusters",
  });
  await section
    .getByText("2 competing identities · needs review", { exact: true })
    .click();
  await expect(section).toContainText(cluster.id);
  await expect(section.getByRole("button", { name: /Inspect / })).toHaveCount(
    2,
  );
  await section
    .getByRole("button", { name: /Inspect / })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "Show separately", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await section.getByRole("button", { name: "Keep cluster uncertain" }).click();
  await expect(section).toContainText("2 competing identities · uncertain");
  expect(reviews).toBe(1);
  expect(graph.objects.length).toBe(originalCount);
  await page.reload();
  await expect(section).toContainText("2 competing identities · uncertain");
});
