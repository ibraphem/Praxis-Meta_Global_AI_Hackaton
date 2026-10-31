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
  const panel = page.getByRole("region", { name: "Dynamic scene inventory" });
  await expect(panel).toBeVisible();
  const locations = page.getByLabel("Scene object locations", { exact: true });
  await expect(
    locations.getByRole("button", { name: /9V battery snap connector/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Selected scene object locations")).toHaveCount(
    0,
  );
  await locations
    .getByRole("button", { name: /9V battery snap connector/ })
    .click();
  await panel
    .getByRole("button", { name: /9V battery snap connector/ })
    .click();
  await expect(
    page.getByLabel("Selected scene object locations"),
  ).toBeVisible();
  await expect(panel.getByLabel("Selected scene evidence")).toContainText(
    "prompt target",
  );
  await expect(panel).toContainText(
    "electrical connections remain unestablished",
  );
  await page.reload();
  await expect(panel).toBeVisible();
  await panel
    .getByRole("button", { name: /9V battery snap connector/ })
    .click();
  await expect(
    page.getByLabel("Selected scene object locations"),
  ).toBeVisible();
  const label = page
    .getByLabel("Scene object locations", { exact: true })
    .getByRole("button", { name: /9V battery snap connector/ });
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
      .getByLabel("Scene object locations", { exact: true })
      .getByRole("button", { name: /9V battery snap connector/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Selected scene object locations")).toHaveCount(
    0,
  );
  await expect(panel).not.toContainText("Not run for this analysis");
  expect(starts).toBe(1);
  expect(creates).toBe(0);
  expect(job.revision).toBe(baselineRevision);
});
