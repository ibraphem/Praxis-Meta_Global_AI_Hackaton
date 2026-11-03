import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analysisJobSchema } from "../../lib/analysis-jobs";
test("junction markers support correction and unknown review while preserving original evidence and exporting without inference", async ({
  page,
}, testInfo) => {
  const job = analysisJobSchema.parse(
      JSON.parse(
        readFileSync(
          resolve(process.cwd(), "test/fixtures/connector-junctions.json"),
          "utf8",
        ),
      ).job,
    ),
    record = job.connectorJunctions![0]!,
    original = structuredClone(record.outcomes),
    first = record.outcomes[0]!,
    second = record.outcomes[1]!;
  let reviews = 0,
    providerRuns = 0;
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (route) =>
    route.fulfill({
      contentType: "image/jpeg",
      body: readFileSync(
        resolve(process.cwd(), "test/fixtures/connector-junctions.jpg"),
      ),
    }),
  );
  await page.route(
    `**/api/analyses/${job.analysisId}/run-connector-junctions`,
    (route) => {
      providerRuns++;
      return route.fulfill({ status: 409 });
    },
  );
  await page.route(
    `**/api/analyses/${job.analysisId}/review-connector-junction`,
    (route) => {
      const body = route.request().postDataJSON();
      expect(body.revision).toBe(record.revision);
      expect(body.originalImageOnly).toBe(true);
      expect(body.planId).toBe(record.plan.planId);
      const index = record.outcomes.findIndex((o) => o.id === body.outcomeId),
        o = record.outcomes[index]!;
      record.reviews.push({
        outcomeId: body.outcomeId,
        decision: body.decision,
        position: body.position,
        kind: body.kind,
        reason: body.reason,
        reviewer: body.reviewer,
        originalImageOnly: true,
        visibleEvidence: body.visibleEvidence,
        reviewId: `c0000000-0000-4000-a000-00000000000${reviews}`,
        source: "human_review",
        reviewedAt: Date.now(),
      });
      const review = record.reviews.at(-1)!;
      record.effectiveOutcomes[index] = {
        ...o,
        position: body.position,
        kind: body.kind,
        visibility: body.decision === "unknown" ? "uncertain" : "visible",
        associationStatus:
          body.decision === "unknown" ? "unresolved" : "confirmed",
        conductorObjectId:
          body.decision === "unknown" ? null : o.expectedConductorObjectId,
        contactPosition: null,
        contactVisibility: "uncertain",
        reason: body.reason,
        evidenceSource: "human_review",
        reviewId: review.reviewId,
      };
      record.revision++;
      reviews++;
      return route.fulfill({ json: job });
    },
  );
  await page.goto(`/workspace?analysis=${job.analysisId}`);
  const panel = page.getByRole("region", {
    name: "Connector junction discovery",
  });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("dispatched 1");
  const a = panel.getByRole("group", {
    name: `Review junction ${first.expectedConductorObjectId}`,
  });
  await a
    .getByRole("button", { name: "Correct this junction on image" })
    .click();
  const svg = page.getByLabel("Connector junction markers");
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  const position: [number, number] = [
    first.position![0] + 2,
    first.position![1] + 1,
  ];
  await svg.click({
    position: {
      x: (position[0] * box!.width) / job.image.width,
      y: (position[1] * box!.height) / job.image.height,
    },
  });
  await expect(
    a.getByLabel(`Junction X ${first.expectedConductorObjectId}`),
  ).toHaveValue(String(position[0]));
  await a
    .getByLabel(`Junction reviewer ${first.expectedConductorObjectId}`)
    .fill("Synthetic browser reviewer");
  await a
    .getByLabel(`Junction evidence note ${first.expectedConductorObjectId}`)
    .fill(
      "The visible fixture insulation enters the housing at this corrected position.",
    );
  await a
    .getByRole("checkbox", {
      name: "I reviewed the original photograph",
      exact: true,
    })
    .check();
  await a
    .getByRole("checkbox", {
      name: "This kind of junction is visibly supported",
      exact: true,
    })
    .check();
  await a.getByRole("button", { name: "Save junction correction" }).click();
  await expect(a).toContainText("confirmed");
  const b = panel.getByRole("group", {
    name: `Review junction ${second.expectedConductorObjectId}`,
  });
  await b
    .getByLabel(`Junction reviewer ${second.expectedConductorObjectId}`)
    .fill("Synthetic browser reviewer");
  await b
    .getByLabel(`Junction evidence note ${second.expectedConductorObjectId}`)
    .fill(
      "Attachment is obscured in this fixture; do not invent a hidden contact.",
    );
  await b
    .getByRole("checkbox", {
      name: "I reviewed the original photograph",
      exact: true,
    })
    .check();
  await b.getByRole("button", { name: "Mark junction unknown" }).click();
  await expect(b).toContainText("unresolved");
  await expect(
    page.getByRole("button", { name: /Inspect junction/ }),
  ).toHaveCount(1);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export evaluation bundle", exact: true })
    .click();
  const file = await downloaded,
    bundle = JSON.parse(readFileSync((await file.path())!, "utf8")),
    exported = bundle.sceneEvaluation.connectorJunctions[0];
  expect(exported.outcomes).toEqual(original);
  expect(exported.effectiveOutcomes[0].position).toEqual(position);
  expect(exported.effectiveOutcomes[1].position).toBeNull();
  expect(exported.accounting.dispatchAttempts).toBe(1);
  expect(reviews).toBe(2);
  expect(providerRuns).toBe(0);
  await a.screenshot({
    path: testInfo.outputPath("connector-junction-review.png"),
  });
});
