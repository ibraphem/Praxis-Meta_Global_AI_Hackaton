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
  await page.goto(`/?analysis=${job.analysisId}`);
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
  await page.goto(`/?analysis=${job.analysisId}`);
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
  await page.goto(`/?analysis=${job.analysisId}`);
  const panel = page.getByRole("region", { name: "Reconciled scene objects" });
  await panel
    .getByRole("button", { name: /9V battery snap connector/ })
    .click();
  await panel
    .getByRole("button", { name: "Discover terminals (1)", exact: true })
    .click();
  await expect(panel).toContainText("Terminal A");
  await expect(panel).toContainText("Role: unresolved");
  await expect(panel).toContainText("electrical connection unestablished");
  expect(requests).toBe(1);
  expect(job.revision).toBe(revision);
});
