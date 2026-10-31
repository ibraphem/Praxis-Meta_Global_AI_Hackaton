import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { sceneEvaluationJob } from "../fixtures/scene-evaluation";

const image = readFileSync(
  resolve(
    process.cwd(),
    "test/fixtures/exact-hole-v1/jumper_wires_breadboard.png",
  ),
);
function fixture() {
  const job = sceneEvaluationJob(1426, 1008);
  const hash = createHash("sha256").update(image).digest("hex");
  job.imageHash = hash;
  job.scene!.graph!.imageHash = hash;
  job.scene!.snapshotRef!.imageHash = hash;
  return job;
}

test("download includes complete scene evidence and latency before calibration, without inference", async ({
  page,
}) => {
  const job = fixture();
  let modelWrites = 0;
  await page.route("**/api/**", (route) => {
    if (route.request().method() === "POST") {
      modelWrites++;
      return route.fulfill({ status: 503 });
    }
    return route.fallback();
  });
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (route) =>
    route.fulfill({ contentType: "image/png", body: image }),
  );
  await page.goto(`/?analysis=${job.analysisId}`);
  const exportButton = page.getByRole("button", {
    name: "Export evaluation bundle",
    exact: true,
  });
  await expect(exportButton).toBeEnabled();
  const downloadEvent = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadEvent;
  const bundle = JSON.parse(readFileSync((await download.path())!, "utf8"));
  expect(bundle.schemaVersion).toBe("praxis-evaluation-v1");
  expect(bundle.boards).toEqual([]);
  expect(bundle.reviews).toEqual([]);
  expect(bundle.imageHash).toBe(bundle.image.sha256);
  expect(bundle.imageHash).toBe(job.imageHash);
  const evidence = bundle.sceneEvaluation;
  expect(evidence.schemaVersion).toBe("praxis-scene-evaluation-v1");
  expect(evidence.graph).toEqual(job.scene!.graph);
  expect(evidence.source.sceneSnapshot).toEqual(job.scene!.snapshotRef);
  expect(evidence.inventory.attempts).toEqual([job.scene!.attempts[0]]);
  expect(evidence.segmentation.observations[0].mask.path).toBeDefined();
  expect(evidence.reconciliation.decisions).toEqual(
    job.scene!.graph!.identityReviews,
  );
  expect(evidence.terminalDiscovery.proposals).toEqual(
    job.scene!.graph!.terminals,
  );
  expect(evidence.attachmentEvidence).toEqual(job.scene!.graph!.attachments);
  expect(evidence.verificationStatus.objectIdentity[0].status).toBe(
    "human_confirmed_same_object",
  );
  expect(evidence.verificationStatus.terminals[0].verification).toBe(
    "unverified",
  );
  expect(evidence.verificationStatus.electricalConnectionStatus).toBe(
    "unestablished",
  );
  const latency = evidence.latency.stages.find(
    (s: { stage: string }) => s.stage === "scene",
  );
  expect(latency.attempts[3].status).toBe("timed_out");
  expect(latency.attempts[3].timings[0].stage).toBe("muse.terminals");
  expect(latency.attempts[3].wallMs).toBe(800);
  expect(evidence.latency.terminalRequests[0].upstreamOutcome).toBe("unknown");
  expect(modelWrites).toBe(0);
});

test("mismatched photo blocks the download and explains the evidence mismatch", async ({
  page,
}) => {
  const job = fixture();
  job.imageHash = "f".repeat(64);
  job.scene!.graph!.imageHash = job.imageHash;
  job.scene!.snapshotRef!.imageHash = job.imageHash;
  await page.route(`**/api/analyses/${job.analysisId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/analyses/${job.analysisId}/image`, (route) =>
    route.fulfill({ contentType: "image/png", body: image }),
  );
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.goto(`/?analysis=${job.analysisId}`);
  await page
    .getByRole("button", { name: "Export evaluation bundle", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Evaluation export" }).getByRole("alert"),
  ).toContainText("does not match this photograph");
  expect(downloads).toBe(0);
});
