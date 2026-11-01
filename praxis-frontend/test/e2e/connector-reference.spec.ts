import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connectorAnnotationViewSchema } from "../../lib/connector-validation";
import { automaticWorkflowJob } from "../fixtures/automatic-targeting";

test("reference workspace draws original-image labels, freezes a non-blinded version and never fetches predictions", async ({
  page,
}, testInfo) => {
  const job = automaticWorkflowJob(),
    r = job.automaticTargeting![0]!,
    id = job.analysisId;
  const imageUrl = `/api/analyses/${id}/connector-annotation-image?workflowId=${r.workflowId}`;
  let view = connectorAnnotationViewSchema.parse({
    schemaVersion: "praxis-connector-annotation-view-v1",
    analysisId: id,
    workflowId: r.workflowId,
    imageHash: job.imageHash,
    imageUrl,
    draft: {
      draftId: job.scene!.attempts[0]!.attemptId,
      workflowId: r.workflowId,
      imageHash: job.imageHash,
      objectId: r.objectId,
      image: job.image,
      revision: 0,
      updatedAt: 0,
      content: {
        version: "connector-annotation-v1",
        regions: { connector: [], redWire: [], blackWire: [], uncertain: [] },
        reviewer: "Unassigned",
        source: "human_review",
        predictionExposure: "unknown",
        originalImageOnly: false,
        independentAttestation: false,
        boundaryDefinition:
          "Visible connector body; insulated red and black wires are excluded.",
      },
    },
    references: [],
    note: "Original photograph and reviewer labels only.",
  });
  let predictionReads = 0,
    modelWrites = 0,
    saves = 0,
    freezes = 0;
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (
      url.endsWith(`/api/analyses/${id}`) ||
      url.includes("automatic-targeting-evidence")
    ) {
      predictionReads++;
      return route.fulfill({ status: 503 });
    }
    if (
      route.request().method() === "POST" &&
      !url.includes("connector-reference")
    ) {
      modelWrites++;
      return route.fulfill({ status: 503 });
    }
    return route.fallback();
  });
  await page.route(`**/api/analyses/${id}/connector-annotation?*`, (route) =>
    route.fulfill({ json: view }),
  );
  await page.route(
    `**/api/analyses/${id}/connector-annotation-image?*`,
    (route) =>
      route.fulfill({
        contentType: "image/jpeg",
        body: readFileSync(
          resolve(process.cwd(), "test/fixtures/automatic-targeting.jpg"),
        ),
      }),
  );
  await page.route(
    `**/api/analyses/${id}/save-connector-reference`,
    (route) => {
      const body = route.request().postDataJSON();
      expect(body.revision).toBe(0);
      expect(body.content.predictionExposure).toBe("seen_before");
      expect(body.content.regions.connector.length).toBeGreaterThan(0);
      expect(body.content.regions.redWire.length).toBeGreaterThan(0);
      expect(body.content.regions.blackWire.length).toBeGreaterThan(0);
      view = {
        ...view,
        draft: {
          ...view.draft,
          revision: 1,
          updatedAt: Date.now(),
          content: body.content,
        },
      };
      saves++;
      return route.fulfill({ json: view });
    },
  );
  await page.route(
    `**/api/analyses/${id}/freeze-connector-reference`,
    (route) => {
      const body = route.request().postDataJSON();
      expect(body.revision).toBe(1);
      view = {
        ...view,
        references: [
          {
            referenceHash: "f".repeat(64),
            annotationVersion: 1,
            frozenAt: Date.now(),
            independent: false,
            source: "human_review",
            predictionExposure: "seen_before",
            workflowId: r.workflowId,
            objectId: r.objectId,
            reviewer: view.draft.content.reviewer,
            pixelCounts: {
              connector: 20,
              redWire: 20,
              blackWire: 20,
              uncertain: 0,
            },
          },
        ],
      };
      freezes++;
      return route.fulfill({ json: view });
    },
  );
  await page.goto(`/reference/${id}/${r.workflowId}`);
  const canvas = page
    .getByRole("img", { name: "Original photograph annotation canvas" })
    .or(page.getByLabel("Original photograph annotation canvas"));
  await expect(canvas).toBeVisible();
  await page
    .getByLabel("Reference reviewer")
    .fill("Reviewer who saw prediction");
  await page.getByLabel("Prediction exposure").selectOption("seen_before");
  await page
    .getByText(
      "I annotated from the original photograph without tracing a prediction.",
      { exact: true },
    )
    .click();
  await page
    .getByText(
      "I attest that this is my independently authored human pixel reference.",
      { exact: true },
    )
    .click();
  await canvas.click({ position: { x: 80, y: 40 } });
  await page.getByLabel("Annotation region").selectOption("2");
  await canvas.click({ position: { x: 120, y: 80 } });
  await page.getByLabel("Annotation region").selectOption("3");
  await canvas.click({ position: { x: 140, y: 100 } });
  await page.getByRole("button", { name: "Save annotation draft" }).click();
  await expect(page.getByRole("status")).toContainText("Draft saved");
  await page.getByRole("button", { name: "Freeze reference version" }).click();
  await expect(page.getByRole("status")).toContainText("Reference frozen");
  await expect(
    page.getByText(/Version 1: non-blinded human reference/),
  ).toBeVisible();
  expect(saves).toBe(1);
  expect(freezes).toBe(1);
  expect(predictionReads).toBe(0);
  expect(modelWrites).toBe(0);
  await page.reload();
  await expect(
    page.getByText(/Version 1: non-blinded human reference/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save annotation draft" }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("connector-reference-editor.png"),
    fullPage: true,
  });
});
