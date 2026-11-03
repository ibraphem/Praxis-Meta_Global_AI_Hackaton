import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "test/fixtures/camera-demo.json"),
    "utf8",
  ),
);
const image = readFileSync(
  resolve(process.cwd(), "test/fixtures/connectivity.jpg"),
);
async function fakeCamera(page: Page, denied = false) {
  await page.addInitScript(
    ({ denied }) => {
      let stopped = 0;
      Object.defineProperty(window, "cameraTracksStopped", {
        get: () => stopped,
      });
      Object.defineProperty(navigator, "mediaDevices", {
        value: {
          async getUserMedia() {
            if (denied)
              throw new DOMException(
                "Camera permission denied.",
                "NotAllowedError",
              );
            const canvas = document.createElement("canvas");
            canvas.width = 640;
            canvas.height = 900;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "#e8ebde";
            ctx.fillRect(0, 0, 640, 900);
            ctx.fillStyle = "#467758";
            ctx.fillRect(100, 100, 320, 600);
            ctx.fillStyle = "#242c26";
            ctx.fillText("SYNTHETIC CAMERA — not a real circuit", 100, 50);
            const stream = canvas.captureStream(5);
            for (const track of stream.getTracks()) {
              const stop = track.stop.bind(track);
              track.stop = () => {
                stopped++;
                stop();
              };
            }
            return stream;
          },
          async enumerateDevices() {
            return [
              {
                deviceId: "synthetic",
                kind: "videoinput",
                label: "Synthetic fixture camera",
              },
            ];
          },
        },
      });
    },
    { denied },
  );
}
async function jobRoutes(page: Page) {
  await page.route("**/api/analyses/*/image", (r) =>
    r.fulfill({ contentType: "image/jpeg", body: image }),
  );
  await page.route("**/api/analyses/*/connectivity", (r) =>
    r.fulfill({
      json: JSON.parse(
        readFileSync(
          resolve(process.cwd(), "test/fixtures/connectivity.json"),
          "utf8",
        ),
      ).view,
    }),
  );
  await page.route(`**/api/analyses/${fixture.job.analysisId}`, (r) =>
    r.fulfill({ json: fixture.job }),
  );
  await page.route(`**/api/analyses/${fixture.secondJob.analysisId}`, (r) =>
    r.fulfill({ json: fixture.secondJob }),
  );
}
test("home starts at the camera; saved IDs and processing logs stay out of the main flow", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your circuit. In focus." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start camera", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Request accounting", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Inspection ID", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Choose a photograph", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("camera-first-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Open workbench settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Workbench settings" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Export inspection" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open workbench settings" }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Start camera", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("camera-first-mobile.png"),
    fullPage: true,
  });
});
test("camera capture is frozen before explicit four-SAM approval, double clicks do not duplicate uploads, and stop releases tracks", async ({
  page,
}) => {
  await fakeCamera(page);
  let view = structuredClone(fixture.empty),
    uploads = 0,
    prepared = 0,
    created = 0;
  await page.route("**/api/circuit-sessions", (r) => {
    created++;
    return r.fulfill({ json: view });
  });
  await page.route(`**/api/circuit-sessions/${view.session.sessionId}`, (r) =>
    r.fulfill({ json: view }),
  );
  await page.route("**/api/circuit-sessions/*/prepare-capture", (r) => {
    const body = r.request().postDataJSON();
    prepared++;
    expect(body.purpose).toBe("setup");
    expect(body.width * body.height * 4).toBeLessThanOrEqual(6000000);
    view = {
      ...view,
      session: {
        ...view.session,
        revision: 1,
        activeCaptureId: fixture.initial.captures[0].plan.captureId,
      },
      captures: [
        {
          ...fixture.initial.captures[0],
          plan: {
            ...fixture.initial.captures[0].plan,
            ...body,
            purpose: "setup",
          },
          analysisId: null,
          freshReview: null,
        },
      ],
    };
    return r.fulfill({ json: view });
  });
  await page.route("**/api/analyses", async (r) => {
    uploads++;
    expect(r.request().headers()["x-praxis-capture-plan"]).toBe("e".repeat(64));
    await new Promise((r) => setTimeout(r, 150));
    view.captures[0].analysisId = fixture.job.analysisId;
    return r.fulfill({ json: fixture.job, status: 202 });
  });
  await jobRoutes(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await page
    .getByRole("button", { name: "Capture setup", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ready to inspect?" }),
  ).toBeVisible();
  expect(uploads).toBe(0);
  expect(prepared).toBe(1);
  expect(created).toBe(1);
  await expect(page.getByText(/Up to 4 detection requests/)).toBeVisible();
  await page
    .getByRole("button", { name: "Analyze frame", exact: true })
    .dblclick();
  await expect(
    page.getByRole("heading", { name: "Give your circuit a reference." }),
  ).toBeVisible();
  expect(uploads).toBe(1);
  await page
    .getByRole("button", { name: "Set up circuit", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Set up your circuit" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Evaluation export" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Close Set up your circuit" }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { cameraTracksStopped: number })
            .cameraTracksStopped,
      ),
    )
    .toBe(1);
});
test("HTTP on a LAN address explains HTTPS setup before requesting the camera or creating a session", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "isSecureContext", { value: false });
    Object.defineProperty(navigator, "mediaDevices", { value: undefined });
  });
  let requests = 0;
  await page.route("**/api/**", (r) => {
    requests++;
    return r.abort();
  });
  await page.goto("/camera");
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  const alert = page.locator(".bench-alert[role=alert]");
  await expect(alert).toContainText("Your browser blocks the camera over HTTP");
  await expect(alert).toContainText("https://127.0.0.1:3001");
  await expect(alert).toContainText("certificate trusted by your phone");
  await expect(
    page.getByRole("button", { name: "Start camera", exact: true }),
  ).toBeEnabled();
  expect(requests).toBe(0);
});
test("camera permission denial is recoverable and dispatches no inference", async ({
  page,
}) => {
  await fakeCamera(page, true);
  let requests = 0;
  await page.route("**/api/**", (r) => {
    requests++;
    return r.abort();
  });
  await page.goto("/camera");
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(page.locator(".bench-alert[role=alert]")).toContainText(
    "Camera access is blocked",
  );
  await expect(
    page.getByRole("button", { name: "Start camera", exact: true }),
  ).toBeEnabled();
  expect(requests).toBe(0);
});
test("synthetic camera review links wire and graph, validates guidance, verifies a fresh capture and exports privately", async ({
  page,
}, testInfo) => {
  let view = structuredClone(fixture.initial),
    modelCalls = 0,
    reviews = 0;
  await fakeCamera(page);
  await jobRoutes(page);
  await page.route("**/api/vision/**", (r) => {
    modelCalls++;
    return r.abort();
  });
  await page.route("**/api/analyses", (r) => {
    modelCalls++;
    return r.abort();
  });
  await page.route(`**/api/circuit-sessions/${view.session.sessionId}`, (r) =>
    r.fulfill({ json: view }),
  );
  await page.route("**/api/circuit-sessions/*/review-capture", (r) => {
    const b = r.request().postDataJSON();
    expect(b.wireCandidateId).toBe(fixture.selected);
    expect(b.moving.holeId).toBe("a7");
    expect(b.staticContactsUnchanged).toBe(true);
    expect(b.expectedInputHash).toBe(
      fixture.fault.captures[0].freshReview.inputHash,
    );
    expect(b.reason).toContain("visible insertions");
    reviews++;
    view = structuredClone(fixture.fault);
    return r.fulfill({ json: view });
  });
  await page.route("**/api/circuit-sessions/*/plan-repair", (r) => {
    const b = r.request().postDataJSON();
    expect(b.target.holeId).toBe("c6");
    expect(b.destinationVisibleAndEmpty).toBe(true);
    view = structuredClone(fixture.guidance);
    return r.fulfill({ json: view });
  });
  await page.route("**/api/circuit-sessions/*/verify-repair", (r) => {
    expect(r.request().postDataJSON().captureId).toBe(
      fixture.verifying.session.activeCaptureId,
    );
    view = structuredClone(fixture.resolved);
    return r.fulfill({ json: view });
  });
  await page.route("**/api/circuit-sessions/*/evidence", (r) =>
    r.fulfill({ json: { ...view, scope: fixture.scope } }),
  );
  await page.goto("/");
  await page.evaluate(
    (id) => localStorage.setItem("praxis-camera-session", id),
    view.session.sessionId,
  );
  await page
    .getByRole("button", { name: "Continue previous inspection" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Follow the jumper." }),
  ).toBeVisible();
  await page.getByLabel("Your name", { exact: true }).fill("synthetic_browser");
  await page
    .getByLabel("Observed J1 wire", { exact: true })
    .selectOption(fixture.selected);
  await page
    .getByLabel("R2-side end", { exact: true })
    .selectOption("board_1/b5");
  await page
    .getByLabel("LED-side end", { exact: true })
    .selectOption("board_1/a7");
  await page.getByRole("checkbox", { name: /I checked J1/ }).check();
  await page
    .getByRole("button", { name: "Confirm contacts & inspect" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Found the break." }),
  ).toBeVisible();
  expect(reviews).toBe(1);
  await page
    .getByLabel("Observed circuit connection graph")
    .getByRole("button", { name: "Inspect graph wire J1" })
    .hover();
  await expect(
    page.getByLabel("Segmented wire candidates").locator("path.selected"),
  ).toHaveCount(1);
  const target = page.getByLabel("Available hole on the LED anode strip", {
    exact: true,
  });
  await expect(target.locator('option[value="board_1/a7"]')).toHaveCount(0);
  await target.selectOption("board_1/c6");
  await page
    .getByRole("checkbox", {
      name: "This destination hole is visibly empty and accessible.",
    })
    .check();
  await page.getByRole("button", { name: "Show repair", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "One end. One move." }),
  ).toBeVisible();
  await expect(page.getByLabel("Move a7 to c6")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("camera-synthetic-guidance.png"),
    fullPage: true,
  });
  view = structuredClone(fixture.verifying);
  await page.getByRole("button", { name: "Open workbench settings" }).click();
  await page
    .getByRole("button", { name: "Resume previous inspection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Verify connection", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Connection restored." }),
  ).toBeVisible();
  await expect(
    page.getByText(/LED operation is checked physically/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open workbench settings" }).click();
  const [artifact] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Export inspection", exact: true })
      .click(),
  ]);
  const exported = JSON.parse(readFileSync((await artifact.path())!, "utf8"));
  expect(exported.verifications[0].electricalOperationVerified).toBe(false);
  expect(modelCalls).toBe(0);
});
