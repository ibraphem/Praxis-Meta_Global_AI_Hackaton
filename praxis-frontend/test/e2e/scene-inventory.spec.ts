import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sceneJob } from "../fixtures/scene";

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
    .getByLabel("Selected scene object locations")
    .getByText("9V battery snap connector", { exact: true });
  const labelBounds = await label.boundingBox();
  expect(labelBounds!.height).toBeLessThan(50);
  expect(labelBounds!.width).toBeGreaterThan(100);
  await page.screenshot({
    path: testInfo.outputPath("scene-inventory.png"),
    fullPage: true,
  });
});
