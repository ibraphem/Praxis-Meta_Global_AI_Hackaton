import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { completedJob } from "../fixtures/analysis-job";
import { recoveryReport } from "../fixtures/wire-recovery";

const photograph = resolve(
  process.cwd(),
  "test/fixtures/exact-hole-v1/jumper_wires_breadboard.png",
);
const result = {
  image: { width: 1426, height: 1008 },
  objects: [
    {
      id: "breadboard_1",
      type: "breadboard",
      bbox: [100, 100, 1000, 700],
      interpretation: "uncertain",
      localizationSource: "sam",
      reviewStatus: "sam_unverified",
      geometryStatus: "box_only",
      guidanceEligible: false,
    },
  ],
  provenance: {
    mode: "sam-only",
    reasoningModel: "muse-test",
    segmentationModel: "sam-test",
  },
};
function partial() {
  const job = completedJob(result);
  job.status = "partial";
  job.revision = "sam";
  job.muse.status = "timed_out";
  Object.assign(job.muse.attempts[0]!, {
    status: "timed_out",
    upstreamOutcome: "unknown",
    retryPolicy: "manual_only",
    errorCode: "PROVIDER_TIMEOUT",
  });
  return job;
}

test("Muse timeout keeps reviewable SAM candidates; saved link reloads image and retry keeps the job identity", async ({
  page,
}) => {
  let job = partial(),
    creates = 0,
    retries = 0,
    images = 0;
  const id = job.analysisId;
  await page.route("**/api/analyses", async (route) => {
    creates++;
    await route.fulfill({ status: 202, json: job });
  });
  await page.route(`**/api/analyses/${id}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${id}/image`, (route) => {
    images++;
    return route.fulfill({
      contentType: "image/png",
      body: readFileSync(photograph),
    });
  });
  await page.route(`**/api/analyses/${id}/retry-muse`, (route) => {
    retries++;
    const completed = completedJob({
      ...result,
      objects: [],
      provenance: { ...result.provenance, mode: "combined" },
    });
    job = { ...completed, analysisId: id };
    return route.fulfill({ status: 202, json: job });
  });
  await page.goto("/");
  await page
    .getByLabel("Upload a workspace photograph")
    .setInputFiles(photograph);
  await page
    .getByRole("button", { name: "Analyze image", exact: true })
    .click();
  await expect(page.getByText(/Muse interpretation timed out/)).toBeVisible();
  await expect(
    page.getByText(/provider may still have processed/),
  ).toBeVisible();
  await expect(
    page.getByText("SAM board region 1", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Board regions — unverified")).toBeVisible();
  await page
    .getByRole("button", { name: "Continue with SAM candidates" })
    .click();
  await expect(
    page.getByRole("button", { name: "Calibrate a board", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Retry Muse interpretation" }),
  ).toBeVisible();
  await expect(
    page.getByText("SAM board region 1", { exact: true }).first(),
  ).toBeVisible();
  expect(creates).toBe(1);
  expect(images).toBe(1);
  await page.getByRole("button", { name: "Retry Muse interpretation" }).click();
  await expect(
    page.getByText("Analysis complete. Interpretation is saved."),
  ).toBeVisible();
  expect(retries).toBe(1);
  expect(creates).toBe(1);
  await expect(page).toHaveURL(new RegExp(`analysis=${id}`));
});

test("pausing observation leaves the saved job available for reconnection", async ({
  page,
}) => {
  const job = partial();
  job.muse.status = "running";
  job.status = "interpreting";
  Object.assign(job.muse.attempts[0]!, {
    status: "running",
    retryPolicy: "blocked",
  });
  await page.route("**/api/analyses", (route) =>
    route.fulfill({ status: 202, json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.goto("/");
  await page
    .getByLabel("Upload a workspace photograph")
    .setInputFiles(photograph);
  await page
    .getByRole("button", { name: "Analyze image", exact: true })
    .click();
  await expect(
    page.getByText("Segmentation saved. Muse interpretation is running."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause updates" }).click();
  await expect(
    page.getByRole("button", { name: "Reconnect to saved analysis" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry Muse interpretation" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Continue with SAM candidates" })
    .click();
  await expect(
    page.getByRole("button", { name: "Calibrate a board", exact: true }),
  ).toBeEnabled();
  job.status = "partial";
  job.muse.status = "interrupted";
  Object.assign(job.muse.attempts[0]!, {
    status: "interrupted",
    retryPolicy: "manual_only",
  });
  await page
    .getByRole("button", { name: "Reconnect to saved analysis" })
    .click();
  await expect(
    page.getByText(/Muse interpretation was interrupted/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry Muse interpretation" }),
  ).toBeEnabled();
});

test("experiment reservations leave SAM review available and suppress model retry and source deletion", async ({
  page,
}) => {
  const job = partial();
  job.experiment = {
    experimentId: job.sam.attempts[0]!.attemptId,
    analysisId: job.analysisId,
    status: "running",
    leaseUntil: Date.now() + 15000,
  };
  await page.route("**/api/analyses", (route) =>
    route.fulfill({ status: 202, json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.goto("/");
  await page
    .getByLabel("Upload a workspace photograph")
    .setInputFiles(photograph);
  await page
    .getByRole("button", { name: "Analyze image", exact: true })
    .click();
  await expect(
    page.getByText(/controlled Muse experiment is running/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Retry Muse interpretation",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Continue with SAM candidates", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Calibrate a board", exact: true }),
  ).toBeEnabled();
  job.experiment.status = "interrupted";
  await expect(
    page.getByText(/controlled Muse experiment was interrupted/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Retry Muse interpretation",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Delete saved analysis", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Calibrate a board", exact: true }),
  ).toBeEnabled();
});

test("wire identity verification and timed-out crop recovery preserve review and never create electrical connections", async ({
  page,
}) => {
  const job = partial(),
    id = job.analysisId,
    originalRevision = job.revision;
  job.recovery = {
    status: "succeeded",
    attempts: [],
    operation: "audit",
    budget: { requests: 0, pixels: 0, verificationRequests: 0, rounds: 0 },
    visited: [],
    report: recoveryReport(job.sam.attempts[0]!.attemptId),
  };
  let verifyCalls = 0,
    recoverCalls = 0,
    identityCalls = 0;
  await page.route("**/api/analyses", (route) =>
    route.fulfill({ status: 202, json: job }),
  );
  await page.route(`**/api/analyses/${id}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${id}/image`, (route) =>
    route.fulfill({ contentType: "image/png", body: readFileSync(photograph) }),
  );
  await page.route(`**/api/analyses/${id}/verify-wire`, (route) => {
    verifyCalls++;
    expect(route.request().postDataJSON()).toEqual({
      candidateId: "jumper_wire_1",
    });
    job.recovery!.operation = "verify";
    job.recovery!.budget.verificationRequests++;
    job.recovery!.report!.modelReviews = [
      {
        candidateId: "jumper_wire_1",
        decision: "uncertain",
        endpoints: [
          { role: "A", position: null, evidence: "occluded_insertion" },
          { role: "B", position: null, evidence: "insufficient" },
        ],
        elapsedMs: 120,
      },
    ];
    return route.fulfill({ status: 202, json: job });
  });
  await page.route(`**/api/analyses/${id}/wire-identities`, (route) => {
    identityCalls++;
    const body = route.request().postDataJSON();
    expect(body.state).toBe("uncertain");
    expect(body.candidateIds).toEqual(["jumper_wire_1"]);
    job.wireIdentities = [
      {
        ...body,
        reviewId: job.sam.attempts[0]!.attemptId,
        reviewSource: "human",
        reviewedAt: 1,
        electricalConnectionStatus: "unestablished",
      },
    ];
    return route.fulfill({ json: job });
  });
  await page.route(`**/api/analyses/${id}/recover-wires`, (route) => {
    recoverCalls++;
    job.recovery!.status = "timed_out";
    job.recovery!.operation = "recover";
    job.recovery!.budget.requests++;
    job.recovery!.budget.rounds++;
    job.recovery!.cropAttempts = [
      {
        attemptId: job.sam.attempts[0]!.attemptId,
        region: [50, 150, 400, 400],
        status: "timed_out",
        upstreamOutcome: "unknown",
        startedAt: 1,
        finishedAt: 2,
        errorCode: "PROVIDER_TIMEOUT",
      },
    ];
    job.recovery!.attempts = [
      {
        ...job.sam.attempts[0]!,
        status: "timed_out",
        retryPolicy: "manual_only",
        upstreamOutcome: "unknown",
        errorCode: "PROVIDER_TIMEOUT",
      },
    ];
    return route.fulfill({ status: 202, json: job });
  });
  await page.goto("/");
  await page
    .getByLabel("Upload a workspace photograph")
    .setInputFiles(photograph);
  await page
    .getByRole("button", { name: "Analyze image", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "Wire coverage and identity review",
  });
  await expect(panel.getByText(/branched_mask/).first()).toBeVisible();
  await panel
    .locator("label")
    .filter({ hasText: "jumper_wire_1" })
    .getByRole("checkbox")
    .check();
  await panel
    .getByRole("button", { name: "Ask Muse to verify candidate" })
    .click();
  await expect(panel.getByText(/Muse proposal: uncertain/)).toBeVisible();
  expect(identityCalls).toBe(0);
  await panel.getByRole("button", { name: "Keep identity uncertain" }).click();
  await expect(panel.getByText(/uncertain: jumper_wire_1/)).toBeVisible();
  await panel
    .getByRole("button", { name: "Recover prioritized regions" })
    .click();
  await expect(
    panel.getByText(/Latest recovery action: timed out/),
  ).toBeVisible();
  await expect(
    panel.getByText(
      /0 successful crop inspections · 1 attempts without a confirmed successful inspection/,
    ),
  ).toBeVisible();
  await expect(
    panel.getByText(/Region \[50, 150, 400, 400\]: timed out/),
  ).toBeVisible();
  expect(verifyCalls).toBe(1);
  expect(recoverCalls).toBe(1);
  expect(identityCalls).toBe(1);
  expect(job.revision).toBe(originalRevision);
  await page.reload();
  await expect(panel.getByText(/uncertain: jumper_wire_1/)).toBeVisible();
  await expect(
    panel.getByText(/Region \[50, 150, 400, 400\]: timed out/),
  ).toBeVisible();
  await expect(
    panel.getByText(/Electrical connections: unestablished/),
  ).toBeVisible();
  expect(recoverCalls).toBe(1);
});

test("reconciled reviews disclose provenance and pending re-review without promoting changed evidence", async ({
  page,
}) => {
  const job = partial(),
    id = job.analysisId,
    report = recoveryReport(job.sam.attempts[0]!.attemptId);
  const first = {
    reviewId: job.sam.attempts[0]!.attemptId,
    reportId: "3".repeat(64),
    candidateIds: ["jumper_wire_8"],
    state: "verified" as const,
    note: "prior physical inspection",
    reviewSource: "human" as const,
    reviewedAt: 1,
    electricalConnectionStatus: "unestablished" as const,
  };
  const second = {
    ...first,
    reviewId: job.muse.attempts[0]!.attemptId,
    candidateIds: ["jumper_wire_9"],
  };
  report.candidates.push({
    ...report.candidates[0]!,
    id: "jumper_wire_2",
    bbox: [400, 200, 200, 100],
  });
  report.reviewReconciliation = [
    {
      sourceReviewId: first.reviewId,
      sourceReportId: first.reportId,
      sourceCandidateIds: first.candidateIds,
      candidateIds: ["jumper_wire_1"],
      status: "carried",
      reason: "unchanged_evidence",
    },
    {
      sourceReviewId: second.reviewId,
      sourceReportId: second.reportId,
      sourceCandidateIds: second.candidateIds,
      candidateIds: ["jumper_wire_2"],
      status: "needs_review",
      reason: "changed_evidence",
    },
  ];
  job.recovery = {
    status: "succeeded",
    attempts: [],
    operation: "audit",
    budget: { requests: 0, pixels: 0, verificationRequests: 0, rounds: 0 },
    visited: [],
    cropAttempts: [],
    report,
  };
  job.wireIdentities = [first, second];
  await page.route(`**/api/analyses/${id}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${id}/image`, (route) =>
    route.fulfill({ contentType: "image/png", body: readFileSync(photograph) }),
  );
  await page.route(`**/api/analyses/${id}/wire-identities`, (route) => {
    const body = route.request().postDataJSON();
    job.wireIdentities!.push({
      ...body,
      reviewId: id,
      reviewSource: "human",
      reviewedAt: 2,
      electricalConnectionStatus: "unestablished",
    });
    return route.fulfill({ json: job });
  });
  await page.goto(`/?analysis=${id}`);
  const panel = page.getByRole("region", {
    name: "Wire coverage and identity review",
  });
  await expect(panel.getByText(/1 human-verified groups/)).toBeVisible();
  await expect(
    panel.getByText(/Carried from an unchanged prior review/),
  ).toBeVisible();
  await expect(panel.getByText(/Needs re-review: jumper_wire_9/)).toBeVisible();
  await panel
    .locator("label")
    .filter({ hasText: "jumper_wire_1" })
    .getByRole("checkbox")
    .check();
  await panel.getByRole("button", { name: "Keep identity uncertain" }).click();
  await expect(panel.getByText(/0 human-verified groups/)).toBeVisible();
  await page.reload();
  await expect(panel.getByText(/0 human-verified groups/)).toBeVisible();
  await expect(panel.getByText(/Needs re-review: jumper_wire_9/)).toBeVisible();
});
