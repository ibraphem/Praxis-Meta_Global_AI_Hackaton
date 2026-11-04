import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { calibrateBoard } from "../../../praxis-backend/server/src/shared/calibration";
import { buildConnectivity } from "../../../praxis-backend/server/src/services/connectivity";
import { connectionProjection } from "../../../praxis-backend/server/src/services/connection-projection";
import type { CircuitInspection } from "../../lib/automatic-circuit";

const id = "11111111-1111-4111-8111-111111111111";
const image = readFileSync(
  resolve(process.cwd(), "test/fixtures/connectivity.jpg"),
);
function fixture(): CircuitInspection {
  const calibration = calibrateBoard(
    "board_1",
    30,
    { width: 640, height: 960 },
    [
      { x: 100, y: 100 },
      { x: 430, y: 100 },
      { x: 430, y: 900 },
      { x: 100, y: 900 },
    ],
  );
  return {
    id,
    imageHash: "a".repeat(64),
    image: { width: 640, height: 960 },
    createdAt: 1,
    revision: 0,
    status: "needs_review",
    stage: "Confirm the grid and proposed connections",
    model: "mock vision model",
    requestCount: 3,
    warnings: [
      "Synthetic software validation. Hidden module contacts are unresolved.",
    ],
    error: null,
    observations: { boards: [], components: [], warnings: [] },
    reviewedAt: null,
    reviewer: null,
    graph: null,
    input: {
      schemaVersion: "praxis-connectivity-input-v1",
      analysisId: id,
      imageHash: "a".repeat(64),
      revision: 0,
      validationScope: "photograph",
      coverage: { state: "unresolved", evidence: [] },
      boards: [
        {
          id: "board_1",
          revision: 1,
          calibration,
          rails: [],
          topologyState: "unresolved",
          evidence: [],
        },
      ],
      components: [
        {
          id: "wire",
          label: "Observed wire",
          type: "jumper_wire",
          objectRef: { kind: "manual", id: "wire" },
          bbox: [100, 180, 250, 100],
          terminalIds: ["wire_a", "wire_b"],
          state: "unresolved",
          continuity: "unresolved",
          evidence: [],
        },
        {
          id: "module",
          label: "Observed module",
          type: "power_module",
          objectRef: { kind: "manual", id: "module" },
          bbox: [100, 30, 300, 70],
          terminalIds: ["module_a"],
          state: "unresolved",
          continuity: "unresolved",
          evidence: [],
        },
      ],
      terminals: [
        {
          id: "wire_a",
          componentId: "wire",
          label: "End A",
          role: null,
          roleState: "unresolved",
          position: { x: 100, y: 210 },
          evidence: [],
        },
        {
          id: "wire_b",
          componentId: "wire",
          label: "End B",
          role: null,
          roleState: "unresolved",
          position: { x: 310, y: 210 },
          evidence: [],
        },
        {
          id: "module_a",
          componentId: "module",
          label: "Covered contact",
          role: null,
          roleState: "unresolved",
          position: null,
          evidence: [],
        },
      ],
      associations: [
        {
          id: "a",
          terminalId: "wire_a",
          type: "insertion",
          target: {
            kind: "hole",
            boardId: "board_1",
            holeId: "a5",
            calibrationRevision: 1,
          },
          state: "unresolved",
          evidence: [],
          originalProposalRef: "a",
        },
        {
          id: "b",
          terminalId: "wire_b",
          type: "insertion",
          target: {
            kind: "hole",
            boardId: "board_1",
            holeId: "f5",
            calibrationRevision: 1,
          },
          state: "unresolved",
          evidence: [],
          originalProposalRef: "b",
        },
        {
          id: "m",
          terminalId: "module_a",
          type: "proximity",
          target: null,
          state: "unresolved",
          evidence: [],
          originalProposalRef: "m",
        },
      ],
    },
  };
}
async function mock(page: Page, restore = false) {
  let v = fixture(),
    uploads = 0,
    reviews = 0;
  await page.addInitScript(
    ({ id, restore }) => {
      localStorage.clear();
      if (restore) localStorage.setItem("praxis-automatic-inspection", id);
    },
    { id, restore },
  );
  await page.route("**/api/circuit-inspections", async (route) => {
    uploads++;
    await route.fulfill({ status: 202, json: { ...v, status: "queued" } });
  });
  await page.route(`**/api/circuit-inspections/${id}`, (route) =>
    route.fulfill({ json: v }),
  );
  await page.route(`**/api/circuit-inspections/${id}/image`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="960"><rect width="640" height="960" fill="#e7ebe0"/><rect x="80" y="80" width="380" height="840" rx="12" fill="white"/><path d="M100 210C200 90 300 330 310 210" fill="none" stroke="#364e48" stroke-width="12"/><text x="100" y="60" font-size="15">Synthetic circuit for software tests</text></svg>',
    }),
  );
  await page.route(`**/api/circuit-inspections/${id}/review`, async (route) => {
    reviews++;
    const body = route.request().postDataJSON();
    const proof = {
      id: "review_1",
      source: "human_review" as const,
      reviewer: body.reviewer,
      note: "Synthetic review",
      timestamp: 1,
    };
    const input = body.input as NonNullable<CircuitInspection["input"]>;
    input.boards.forEach((b) => (b.evidence = [proof]));
    input.components.forEach((c) => (c.evidence = [proof]));
    input.associations.forEach((a) => (a.evidence = [proof]));
    v = {
      ...v,
      input,
      revision: v.revision + 1,
      status: "reviewed",
      reviewedAt: 1,
      reviewer: body.reviewer,
      graph: connectionProjection(buildConnectivity(input)),
    };
    await route.fulfill({ json: v });
  });
  return { counts: () => ({ uploads, reviews }), get: () => v };
}
test("default camera has a general inspection flow and no fixed reference circuit", async ({
  page,
}, info) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your circuit, mapped from the photo." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start camera", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Two-LED indicator", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Expected circuit", { exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: info.outputPath("automatic-circuit-empty.png"),
    fullPage: true,
  });
});
test("upload leads to individual confirmation, unresolved hidden contacts and a saved graph", async ({
  page,
}, info) => {
  const fake = await mock(page);
  await page.goto("/camera");
  await page
    .getByLabel("Upload circuit photo")
    .setInputFiles({
      name: "circuit.jpg",
      mimeType: "image/jpeg",
      buffer: image,
    });
  await page
    .getByRole("button", { name: "Analyze circuit", exact: true })
    .dblclick();
  await expect(
    page.getByRole("heading", { name: "1. Check the board grid" }),
  ).toBeVisible();
  expect(fake.counts().uploads).toBe(1);
  const wire = page.locator("#review-wire");
  await wire.locator("summary").click();
  await expect(
    wire
      .getByLabel("I confirm this physical connection", { exact: true })
      .first(),
  ).toBeDisabled();
  await page
    .getByLabel("Grid and terminal-strip layout checked", { exact: false })
    .check();
  await wire.getByLabel("I confirm this component’s identity").check();
  await wire.getByLabel("Both ends belong to this single intact wire").check();
  for (const checkbox of await wire
    .getByLabel("I confirm this physical connection", { exact: true })
    .all())
    await checkbox.check();
  await page.locator("#review-module summary").click();
  await expect(
    page.getByText("Unresolved · position hidden", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("#review-module")
      .getByLabel("I confirm this physical connection", { exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Reviewer name").fill("Human reviewer");
  await page
    .getByRole("button", { name: "Save review and build graph" })
    .click();
  await expect(
    page.getByRole("img", { name: "Observed circuit connection graph" }),
  ).toBeVisible();
  expect(fake.counts()).toEqual({ uploads: 1, reviews: 1 });
  expect(fake.get().input!.associations[2].state).toBe("unresolved");
  await page.screenshot({
    path: info.outputPath("automatic-circuit-reviewed.png"),
    fullPage: true,
  });
});
test("reopening a saved inspection does not submit another model request", async ({
  page,
}) => {
  const fake = await mock(page, true);
  await page.goto("/camera");
  await expect(
    page.getByRole("heading", { name: "1. Check the board grid" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "1. Check the board grid" }),
  ).toBeVisible();
  expect(fake.counts().uploads).toBe(0);
});
test("permission denial displays a recoverable error and leaves photo upload available", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: async () => {
          throw new DOMException(
            "Camera permission denied.",
            "NotAllowedError",
          );
        },
      },
    }),
  );
  await page.goto("/camera");
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Camera permission denied" }),
  ).toContainText("Camera permission denied");
  await expect(page.getByLabel("Upload circuit photo")).toBeEnabled();
});
