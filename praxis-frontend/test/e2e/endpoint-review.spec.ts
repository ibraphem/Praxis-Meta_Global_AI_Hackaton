import { expect, test, type Page, type Route } from "@playwright/test";
import { resolve } from "node:path";
import {
  calibrateBoard,
  project,
  terminalHoles,
} from "../../lib/breadboard/calibration";

// Real photograph, deterministic mocked perception. This verifies review mechanics,
// not model accuracy or a user-confirmed electrical ground truth.
const photograph = resolve(process.cwd(), "../Complete-Circuit-5.jpg");
const image = { width: 2500, height: 1406 };
const anchors = [
  { x: 510, y: 617 },
  { x: 497, y: 934 },
  { x: 2368, y: 987 },
  { x: 2370, y: 659 },
];
const calibration = calibrateBoard("board_1", 63, image, anchors);
const point = (holeId: string) =>
  project(
    calibration,
    terminalHoles(calibration).find((hole) => hole.id === holeId)!.grid,
  );
const analysis = {
  image,
  objects: [1, 2].map((index) => ({
    id: `jumper_wire_${index}`,
    type: "jumper_wire",
    bbox: [950 + index * 20, 260, 650, 820],
    localizationSource: "sam",
    geometryStatus: "segmented",
    interpretation: "uncertain",
    guidanceEligible: false,
    identityStatus: "unverified",
    mask: {
      format: "svg_path",
      width: 650,
      height: 820,
      path: "M0 0L8 0L8 810L0 810Z",
    },
  })),
  provenance: {
    mode: "combined",
    reasoningModel: "muse-test",
    segmentationModel: "sam-test",
  },
};
async function reply(route: Route) {
  const raw = route.request().postDataBuffer()!.toString();
  const metadata = JSON.parse(raw.match(/name="context"\r\n\r\n([^\r]+)/)![1]);
  const a = point("e17"),
    b = point("a22");
  await route.fulfill({
    json: {
      analysisId: metadata.analysisId,
      imageId: metadata.imageId,
      wireCandidateId: metadata.wire.id,
      model: "muse-test",
      endpoints: [
        {
          role: "A",
          proposedImagePosition: [a.x, a.y],
          evidence: "visible_connector",
        },
        {
          role: "B",
          proposedImagePosition: [b.x, b.y],
          evidence: "visible_insertion",
        },
      ],
    },
  });
}
async function enterCalibrationPoint(page: Page, p: { x: number; y: number }) {
  await page
    .getByRole("spinbutton", { name: "X", exact: true })
    .fill(String(p.x));
  await page
    .getByRole("spinbutton", { name: "Y", exact: true })
    .fill(String(p.y));
  await page.getByRole("button", { name: /^Set [aj]\d+$/ }).click();
}
async function setup(page: Page, withRail = false) {
  await page.route("**/api/vision/analyze", (route) =>
    route.fulfill({ json: analysis }),
  );
  await page.route("**/api/vision/endpoints", reply);
  await page.goto("/");
  await page
    .getByLabel("Upload a workspace photograph")
    .setInputFiles(photograph);
  await page
    .getByRole("button", { name: "Analyze image", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Calibrate a board", exact: true })
    .click();
  await page.getByLabel("Terminal rows").selectOption("63");
  for (const p of anchors) await enterCalibrationPoint(page, p);
  await page.getByRole("button", { name: "Grid aligns — confirm" }).click();
  if (withRail) {
    await page.getByRole("button", { name: "Register rail lane" }).click();
    await page
      .getByRole("combobox", { name: "Hole count", exact: true })
      .selectOption("50");
    for (const grid of [
      { x: -3, y: 0 },
      { x: -3, y: 58 },
    ]) {
      const p = project(calibration, grid);
      await page
        .getByRole("spinbutton", { name: "X", exact: true })
        .fill(String(p.x));
      await page
        .getByRole("spinbutton", { name: "Y", exact: true })
        .fill(String(p.y));
      await page
        .getByRole("button", { name: "Add rail reference", exact: true })
        .click();
    }
    await page.getByRole("button", { name: "Rail aligns — save" }).click();
  }
  await page
    .getByRole("button", { name: "Inspect components", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Propose endpoints with Muse" })
    .click();
  await expect(page.getByLabel("AI endpoint review")).toBeVisible();
}
async function saveBoth(page: Page) {
  await page
    .getByRole("button", { name: "Confirm endpoint A", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm endpoint B", exact: true })
    .click();
  await page.getByRole("button", { name: "Save reviewed assignment" }).click();
}
async function savedJSON(page: Page) {
  const record = page.locator(".assignment-record").last();
  await record.getByText("Inspect assignment JSON", { exact: true }).click();
  return JSON.parse(await record.locator("pre").innerText());
}

test("accept A and B, save, switch wires, reopen and mark one unknown", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".endpoint-proposed circle")).toHaveCount(2);
  await saveBoth(page);
  const record = await savedJSON(page);
  expect(
    record.endpointReview.endpoints.map(
      (endpoint: { reviewStatus: string }) => endpoint.reviewStatus,
    ),
  ).toEqual(["confirmed", "confirmed"]);
  expect(record.wireIdentity.status).toBe("unverified");
  expect(
    record.endpoints.every(
      (endpoint: { electricalContact: string }) =>
        endpoint.electricalContact === "unknown",
    ),
  ).toBe(true);
  await page
    .locator(".detection-item")
    .filter({ hasText: "Jumper wire 2" })
    .click();
  await expect(page.getByLabel("AI endpoint review")).toHaveCount(0);
  await page
    .locator(".detection-item")
    .filter({ hasText: "Jumper wire 1" })
    .click();
  await expect(page.getByLabel("AI endpoint review")).toContainText(
    "Endpoint A · confirmed",
  );
  await page.getByRole("button", { name: "Reopen endpoint review" }).click();
  await page.getByRole("button", { name: "Mark endpoint A unknown" }).click();
  await page.getByRole("button", { name: "Save reviewed assignment" }).click();
  await expect(page.locator(".assignment-record")).toHaveCount(1);
  const updated = JSON.parse(
    await page.locator(".assignment-record pre").innerText(),
  );
  expect(updated.endpoints[0]).toBeNull();
  expect(updated.validity.status).toBe("draft");
  expect(updated.endpointReview.endpoints[0].originalProposal).toEqual(
    record.endpointReview.endpoints[0].originalProposal,
  );
});

test("correction uses the existing image picker, commits explicitly, and preserves A", async ({
  page,
}) => {
  await setup(page);
  await page
    .getByRole("button", { name: "Confirm endpoint A", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Correct endpoint B", exact: true })
    .click();
  const p = point("d18");
  const surface = page.locator(".hole-hit-surface");
  const rect = (await surface.boundingBox())!;
  await surface.click({
    position: {
      x: (p.x / image.width) * rect.width,
      y: (p.y / image.height) * rect.height,
    },
  });
  await expect(page.getByLabel("AI endpoint review")).toContainText(
    "Correction preview: board_1:d18",
  );
  await expect(
    page.getByRole("button", { name: "Save reviewed assignment" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Confirm correction B", exact: true })
    .click();
  await page.getByRole("button", { name: "Save reviewed assignment" }).click();
  const record = await savedJSON(page);
  expect(record.endpointReview.endpoints[0].reviewStatus).toBe("confirmed");
  expect(record.endpointReview.endpoints[1].reviewStatus).toBe("corrected");
  expect(record.endpointReview.endpoints[1].finalHole.holeId).toBe("d18");
  expect(
    record.endpointReview.endpoints[1].originalProposal.proposedHole.holeId,
  ).toBe("a22");
  await page.screenshot({
    path: "test-results/endpoint-review-real-photo.png",
    fullPage: true,
  });
});

test("recalibration makes saved reviews stale and blocks saving", async ({
  page,
}) => {
  await setup(page);
  await saveBoth(page);
  await page
    .getByRole("button", { name: "Inspect holes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Recalibrate grid", exact: true })
    .click();
  for (const p of anchors) await enterCalibrationPoint(page, p);
  await page.getByRole("button", { name: "Grid aligns — confirm" }).click();
  await expect(page.getByLabel("AI endpoint review")).toContainText(
    "Stale — analysis or calibration changed",
  );
  await expect(
    page.getByRole("button", { name: "Save reviewed assignment" }),
  ).toBeDisabled();
  await expect(page.locator(".assignment-record")).toContainText(
    "Stale — invalid",
  );
  await expect(page.locator(".endpoint-overlay")).toHaveCount(0);
});

test("a late AI reply after switching wires cannot populate the new selection", async ({
  page,
}) => {
  await setup(page);
  await page
    .locator(".detection-item")
    .filter({ hasText: "Jumper wire 2" })
    .click();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route("**/api/vision/endpoints", async (route) => {
    arrived();
    await hold;
    await reply(route).catch(() => undefined);
  });
  await page
    .getByRole("button", { name: "Propose endpoints with Muse" })
    .click();
  await started;
  await page
    .locator(".detection-item")
    .filter({ hasText: "Jumper wire 1" })
    .click();
  release();
  await expect(page.getByLabel("AI endpoint review")).toContainText(
    "Jumper wire 1",
  );
  await expect(page.getByLabel("AI endpoint review")).toContainText(
    "Endpoint A · proposed",
  );
  await page
    .locator(".detection-item")
    .filter({ hasText: "Jumper wire 2" })
    .click();
  await expect(page.getByLabel("AI endpoint review")).toHaveCount(0);
});

test("correct B to a registered power rail while preserving A and the AI proposal", async ({
  page,
}) => {
  await setup(page, true);
  await page
    .getByRole("button", { name: "Confirm endpoint A", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Correct endpoint B", exact: true })
    .click();
  const p = project(calibration, { x: -3, y: 12 });
  await page
    .getByRole("spinbutton", { name: "Endpoint X", exact: true })
    .fill(String(p.x));
  await page
    .getByRole("spinbutton", { name: "Endpoint Y", exact: true })
    .fill(String(p.y));
  await page
    .getByRole("button", { name: "Set endpoint 2", exact: true })
    .click();
  await expect(page.getByLabel("AI endpoint review")).toContainText(
    "Correction preview: board_1:R1:11",
  );
  await page
    .getByRole("button", { name: "Confirm correction B", exact: true })
    .click();
  await page.getByRole("button", { name: "Save reviewed assignment" }).click();
  const record = await savedJSON(page);
  expect(record.endpointReview.endpoints[1].finalHole.holeId).toBe("R1:11");
  expect(
    record.endpointReview.endpoints[1].originalProposal.proposedHole.holeId,
  ).toBe("a22");
  expect(record.endpointReview.endpoints[0].reviewStatus).toBe("confirmed");
  expect(record.endpoints[1].electricalContact).toBe("unknown");
});

test("manual endpoint edits made during an AI request are never overwritten", async ({
  page,
}) => {
  await setup(page);
  await page
    .locator(".detection-item")
    .filter({ hasText: "Jumper wire 2" })
    .click();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route("**/api/vision/endpoints", async (route) => {
    arrived();
    await hold;
    await reply(route).catch(() => undefined);
  });
  const returned = page.waitForResponse("**/api/vision/endpoints");
  try {
    await page
      .getByRole("button", { name: "Propose endpoints with Muse" })
      .click();
    await started;
    await page.getByRole("button", { name: "Assign wire endpoints" }).click();
    for (const [index, id] of ["d18", "f19"].entries()) {
      const p = point(id);
      await page
        .getByRole("spinbutton", { name: "Endpoint X", exact: true })
        .fill(String(p.x));
      await page
        .getByRole("spinbutton", { name: "Endpoint Y", exact: true })
        .fill(String(p.y));
      await page
        .getByRole("button", { name: `Set endpoint ${index + 1}`, exact: true })
        .click();
    }
  } finally {
    release();
  }
  await (await returned).finished();
  await expect(
    page.getByRole("button", { name: "Locating endpoints…" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("AI endpoint review")).toHaveCount(0);
  await expect(page.locator(".assignment-record")).toContainText(
    "board_1:d18 → board_1:f19",
  );
  expect((await savedJSON(page)).endpointReview).toBeUndefined();
});
