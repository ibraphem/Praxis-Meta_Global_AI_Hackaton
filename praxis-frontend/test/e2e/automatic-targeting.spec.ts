import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { automaticWorkflowJob } from "../fixtures/automatic-targeting";

test("workspace prepares, explicitly authorizes, reviews and exports the shared automatic experiment", async ({
  page,
}, testInfo) => {
  const job = automaticWorkflowJob(),
    finished = structuredClone(job.automaticTargeting![0]!);
  job.automaticTargeting = [];
  const image = readFileSync(
    resolve(process.cwd(), "test/fixtures/automatic-targeting.jpg"),
  );
  let prepares = 0,
    runs = 0,
    evaluations = 0;
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (route) =>
    route.fulfill({ contentType: "image/jpeg", body: image }),
  );
  await page.route(
    `**/api/analyses/${job.analysisId}/prepare-automatic-targeting`,
    (route) => {
      const body = route.request().postDataJSON();
      expect(body.objectId).toBe(finished.objectId);
      expect(body.snapshotHash).toBe(job.scene!.snapshotRef!.snapshotHash);
      const prepared = structuredClone(finished);
      prepared.status = "prepared";
      prepared.phase = "prepared";
      prepared.experimentId = null;
      prepared.measurements = [];
      prepared.evaluation = null;
      prepared.accounting = {
        ...prepared.accounting,
        reservedRequests: 0,
        reservedPixels: 0,
        dispatchAttempts: 0,
        dispatchedPixels: 0,
        responsesRecorded: 0,
        unknownUsageRequests: 0,
        unknownUsagePixels: 0,
      };
      prepared.arms.forEach((a) => (a.status = "planned"));
      job.automaticTargeting = [prepared];
      prepares++;
      return route.fulfill({ json: job });
    },
  );
  await page.route(
    `**/api/analyses/${job.analysisId}/run-automatic-targeting`,
    (route) => {
      const body = route.request().postDataJSON();
      expect(body).toEqual({
        workflowId: finished.workflowId,
        authorizeInference: true,
        providerBaseUrl: finished.providerBaseUrl,
        requests: 2,
        pixels: finished.budget.plannedPixels,
      });
      job.automaticTargeting = [
        {
          ...structuredClone(finished),
          phase: "response_recorded",
          evaluation: null,
        },
      ];
      runs++;
      return route.fulfill({ status: 202, json: job });
    },
  );
  await page.route(
    `**/api/analyses/${job.analysisId}/evaluate-automatic-targeting`,
    (route) => {
      const body = route.request().postDataJSON();
      expect(body.reviews).toHaveLength(2);
      expect(
        body.reviews.every(
          (r: { decision: string; source: string }) =>
            r.decision === "correct" && r.source === "human_review",
        ),
      ).toBe(true);
      job.automaticTargeting = [finished];
      evaluations++;
      return route.fulfill({ json: job });
    },
  );
  await page.goto(`/?analysis=${job.analysisId}`);
  const panel = page.getByRole("region", {
    name: "Automatic connector targeting",
  });
  await expect(panel).toBeVisible();
  await panel
    .getByRole("button", {
      name: "Prepare automatic connector test",
      exact: true,
    })
    .click();
  await expect(panel).toContainText("2 planned SAM request(s)");
  const run = panel.getByRole("button", {
    name: "Run prepared connector test",
    exact: true,
  });
  await expect(run).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await run.click();
  await expect(panel).toContainText("responses recorded 2");
  await expect(panel.getByRole("img", { name: /candidate mask/ })).toHaveCount(
    2,
  );
  for (const select of await panel
    .getByRole("combobox", { name: /Mask identity/ })
    .all())
    await select.selectOption("correct");
  await panel
    .getByRole("button", { name: "Record offline mask evaluation" })
    .click();
  await expect(panel).toContainText("Evaluation: synthetic_pass");
  await expect(panel).toContainText(
    "No independently validated photographic result",
  );
  expect(prepares).toBe(1);
  expect(runs).toBe(1);
  expect(evaluations).toBe(1);
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export evaluation bundle", exact: true })
    .click();
  const download = await downloadEvent,
    bundle = JSON.parse(readFileSync((await download.path())!, "utf8"));
  expect(bundle.sceneEvaluation.automaticTargeting.experiments[0]).toEqual(
    finished,
  );
  expect(bundle.sceneEvaluation.source.sceneSettings.maxRequests).toBe(0);
  expect(
    bundle.sceneEvaluation.automaticTargeting.experiments[0].accounting
      .dispatchAttempts,
  ).toBe(2);
  await page.reload();
  await expect(panel).toContainText("Evaluation: synthetic_pass");
  await expect(panel).toContainText("Recorded identity: correct");
  await page.screenshot({
    path: testInfo.outputPath("automatic-targeting-workflow.png"),
    fullPage: true,
  });
});
