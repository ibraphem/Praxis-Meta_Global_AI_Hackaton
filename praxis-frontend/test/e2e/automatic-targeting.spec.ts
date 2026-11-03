import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  automaticWorkflowJob,
  automaticV2PreparedJob,
} from "../fixtures/automatic-targeting";

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
  await page.goto(`/workspace?analysis=${job.analysisId}`);
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
test("v2 preparation exposes missing evidence and exports its frozen three-strategy protocol without running inference", async ({
  page,
}, testInfo) => {
  const prepared = automaticV2PreparedJob(),
    job = structuredClone(prepared),
    record = prepared.automaticTargeting![0]!;
  job.automaticTargeting = [];
  let preparations = 0,
    runs = 0;
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (route) =>
    route.fulfill({
      contentType: "image/jpeg",
      body: readFileSync(
        resolve(process.cwd(), "test/fixtures/automatic-targeting.jpg"),
      ),
    }),
  );
  await page.route(
    `**/api/analyses/${job.analysisId}/prepare-automatic-targeting`,
    (route) => {
      expect(route.request().postDataJSON().targetingVersion).toBe("v2");
      preparations++;
      job.automaticTargeting = prepared.automaticTargeting;
      return route.fulfill({ json: job });
    },
  );
  await page.route(
    `**/api/analyses/${job.analysisId}/run-automatic-targeting`,
    (route) => {
      runs++;
      return route.fulfill({ status: 409 });
    },
  );
  await page.goto(`/workspace?analysis=${job.analysisId}`);
  const panel = page.getByRole("region", {
    name: "Automatic connector targeting",
  });
  await panel.getByLabel("Targeting protocol").selectOption("v2");
  await panel
    .getByRole("button", {
      name: "Prepare automatic connector test",
      exact: true,
    })
    .click();
  await expect(panel).toContainText("1 planned SAM request(s)");
  await panel
    .getByText("V2 automatic cue diagnostics", { exact: true })
    .click();
  await expect(panel).toContainText("no target baseline association");
  await expect(panel).toContainText("no supported dark body core");
  await expect(panel).toContainText("Connector boundary gate: blocked");
  await expect(
    panel.getByRole("button", {
      name: "Run prepared connector test",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(panel.getByRole("checkbox")).toBeDisabled();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export evaluation bundle", exact: true })
    .click();
  const file = await downloaded,
    bundle = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(bundle.sceneEvaluation.automaticTargeting.experiments[0]).toEqual(
    record,
  );
  expect(preparations).toBe(1);
  expect(runs).toBe(0);
  await panel.screenshot({
    path: testInfo.outputPath("automatic-targeting-v2.png"),
  });
});
