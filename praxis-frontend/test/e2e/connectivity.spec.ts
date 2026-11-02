import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("synthetic connectivity fault is inspectable, correctable through the existing hole picker, persistent and exportable without inference", async ({
  page,
}, testInfo) => {
  const fixture = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "test/fixtures/connectivity.json"),
      "utf8",
    ),
  );
  const { job } = fixture;
  let view = fixture.view,
    operations = 0,
    inference = 0;
  await page.route(`**/api/analyses/${job.analysisId}`, (r) =>
    r.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (r) =>
    r.fulfill({
      contentType: "image/jpeg",
      body: readFileSync(
        resolve(process.cwd(), "test/fixtures/connectivity.jpg"),
      ),
    }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/connectivity`, (r) =>
    r.fulfill({ json: view }),
  );
  await page.route(
    `**/api/analyses/${job.analysisId}/connectivity-evidence`,
    (r) => r.fulfill({ json: fixture.evidence }),
  );
  await page.route("**/api/vision/**", (r) => {
    inference++;
    return r.abort();
  });
  await page.route(
    `**/api/analyses/${job.analysisId}/review-connectivity`,
    (r) => {
      const body = r.request().postDataJSON();
      expect(body.expectedRevision).toBe(1);
      expect(body.action).toBe("association");
      expect(body.targetId).toBe("insert:jumper:b");
      expect(body.value.target.holeId).toBe("j12");
      expect(body.value.decision).toBe("confirmed_manual");
      view = fixture.corrected;
      operations++;
      return r.fulfill({ json: view });
    },
  );
  await page.route(
    `**/api/analyses/${job.analysisId}/build-connectivity`,
    (r) => {
      expect(r.request().postDataJSON().expectedRevision).toBe(2);
      view = fixture.rebuilt;
      operations++;
      return r.fulfill({ json: view });
    },
  );
  await page.route(
    `**/api/analyses/${job.analysisId}/compare-connectivity`,
    (r) => {
      expect(r.request().postDataJSON().expectedRevision).toBe(2);
      view = fixture.compared;
      operations++;
      return r.fulfill({ json: view });
    },
  );
  await page.goto(`/?analysis=${job.analysisId}`);
  const panel = page.getByRole("region", { name: "Connectivity", exact: true });
  await expect(panel).toBeVisible();
  await panel
    .getByText("Reference circuit and fault diagnosis", { exact: true })
    .click();
  await expect(panel).toContainText("confirmed_fault · synthetic_fixture");
  await panel
    .getByRole("button", {
      name: "Highlight finding and supported destination",
    })
    .click();
  await expect(
    page.getByLabel("Connectivity highlights").locator("circle"),
  ).not.toHaveCount(0);
  await panel.getByLabel("Connectivity reviewer").fill("synthetic_browser");
  await panel
    .getByLabel("Connectivity evidence note")
    .fill(
      "Synthetic correction to an equivalent hole on the required collector strip.",
    );
  await panel
    .getByLabel("Connectivity terminal", { exact: true })
    .selectOption("jumper:b");
  await page
    .getByRole("button", { name: "Inspect holes", exact: true })
    .click();
  await page.getByLabel("Hole coordinate", { exact: true }).fill("j12");
  await page
    .getByRole("button", { name: "Show coordinate", exact: true })
    .click();
  await panel
    .getByRole("checkbox", {
      name: "I confirm this exact lead makes conductive contact at the selected hole or terminal",
    })
    .check();
  await panel
    .getByRole("button", { name: "Confirm terminal at selected hole" })
    .click();
  await expect(panel).toContainText("Evidence revision 2");
  await expect(panel).not.toContainText("confirmed_fault · synthetic_fixture");
  await panel
    .getByRole("button", { name: "Build connectivity graph", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Compare connectivity with reference" })
    .click();
  await expect(panel).toContainText("no_fault · synthetic_fixture");
  await page.reload();
  const reloaded = page.getByRole("region", {
    name: "Connectivity",
    exact: true,
  });
  await reloaded
    .getByText("Reference circuit and fault diagnosis", { exact: true })
    .click();
  await expect(reloaded).toContainText("no_fault · synthetic_fixture");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    reloaded
      .getByRole("button", {
        name: "Export connectivity evidence",
        exact: true,
      })
      .click(),
  ]);
  const exported = JSON.parse(readFileSync((await download.path())!, "utf8"));
  expect(exported.history).toHaveLength(1);
  expect(exported.graphHistory).toHaveLength(2);
  expect(exported.comparisons[0].comparison.findings[0].status).toBe(
    "confirmed_fault",
  );
  expect(exported.comparisons.at(-1).comparison.findings[0].status).toBe(
    "no_fault",
  );
  expect(exported.additionalInferenceRequests).toBe(0);
  expect(operations).toBe(3);
  expect(inference).toBe(0);
  await reloaded.screenshot({
    path: testInfo.outputPath("connectivity-review.png"),
  });
});
