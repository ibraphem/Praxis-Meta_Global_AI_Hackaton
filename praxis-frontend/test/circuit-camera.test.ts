import { test } from "node:test";
import assert from "node:assert/strict";
import { frameSize } from "../lib/camera";
import { hashBytes, parseCircuitSession } from "../lib/circuit-session";
import { createCircuitSessionProxy } from "../lib/server/circuit-session-proxy";
import { createAnalysisJobProxy } from "../lib/server/analysis-job-proxy";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const id = "f7000000-0000-4000-a000-000000000001";
const empty = {
  schemaVersion: "praxis-circuit-session-view-v1",
  session: {
    sessionId: id,
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
    setupAnalysisId: null,
    profileHash: null,
    activeCaptureId: null,
    activeRepairId: null,
    state: "setup",
  },
  profile: null,
  captures: [],
  graph: null,
  comparison: null,
  input: null,
  repairs: [],
  verifications: [],
  requests: [],
  guidanceCurrent: false,
  physicalValidation: "pending_real_rig_rehearsal",
  additionalInferenceRequests: 0,
};
test("camera resize preserves the complete unmirrored source aspect within four-SAM pixel budget", () => {
  for (const [w, h] of [
    [1920, 1080],
    [3840, 2160],
    [900, 1200],
    [640, 480],
  ]) {
    const size = frameSize(w, h);
    assert.ok(size.width * size.height * 4 <= 6000000);
    assert.ok(Math.abs(size.width / size.height - w / h) < 0.005);
    assert.ok(size.width <= w && size.height <= h);
  }
  assert.throws(() => frameSize(0, 10));
});
test("browser SHA-256 agrees with server frame binding and session response IDs are checked", async () => {
  const bytes = new TextEncoder().encode("captured pixels");
  assert.equal(
    await hashBytes(bytes.buffer),
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(parseCircuitSession(empty, id).session.state, "setup");
  assert.throws(() => parseCircuitSession(empty, "different"));
});
test("session proxy restricts actions/origin/path, keeps auth private and forwards exact bounded authorization", async () => {
  let calls = 0;
  const proxy = createCircuitSessionProxy({
    environment: {
      PRAXIS_BACKEND_URL: "https://backend.example/",
      PRAXIS_API_TOKEN: "private-test-key",
    },
    fetcher: async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        `https://backend.example/api/circuit-sessions/${id}/run-endpoints`,
      );
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer private-test-key",
      );
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)),
        { authorize: true },
      );
      return Response.json(empty, { status: 202 });
    },
  });
  assert.equal(
    (
      await proxy(
        new Request("http://localhost/session", {
          method: "POST",
          headers: { origin: "https://evil.example" },
        }),
        "run-endpoints",
        id,
      )
    ).status,
    403,
  );
  assert.equal(
    (await proxy(new Request("http://localhost/session"), "arbitrary", id))
      .status,
    404,
  );
  const response = await proxy(
    new Request("http://localhost/session", {
      method: "POST",
      body: JSON.stringify({ authorize: true }),
    }),
    "run-endpoints",
    id,
  );
  assert.equal(response.status, 202);
  assert.equal(calls, 1);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(
    JSON.stringify(await response.json()).includes("private-test-key"),
    false,
  );
});
test("capture plan header survives existing multipart analysis proxy; invalid header is rejected before network", async () => {
  let calls = 0;
  const job = JSON.parse(
    readFileSync(
      new URL("./fixtures/connectivity.json", import.meta.url),
      "utf8",
    ),
  ).job;
  const proxy = createAnalysisJobProxy({
    environment: { PRAXIS_BACKEND_URL: "https://backend.example" },
    logger: () => {},
    fetcher: async (_url, init) => {
      calls++;
      assert.equal(
        new Headers(init?.headers).get("X-Praxis-Capture-Plan"),
        "a".repeat(64),
      );
      return Response.json(job, { status: 202 });
    },
  });
  const request = (plan: string) =>
    new Request("http://localhost/api/analyses", {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=test",
        "X-Praxis-Capture-Plan": plan,
      },
      body: "--test--\r\n",
    });
  assert.equal((await proxy(request("bad"), "create")).status, 400);
  assert.equal(calls, 0);
  assert.equal((await proxy(request("a".repeat(64)), "create")).status, 202);
  assert.equal(calls, 1);
});

test("all frozen synthetic camera UI responses satisfy the public protocol", () => {
  const f = JSON.parse(
    readFileSync(
      new URL("./fixtures/camera-demo.json", import.meta.url),
      "utf8",
    ),
  );
  for (const key of [
    "empty",
    "initial",
    "fault",
    "guidance",
    "verifying",
    "resolved",
  ])
    assert.equal(
      parseCircuitSession(f[key]).session.sessionId,
      f.initial.session.sessionId,
    );
  assert.throws(() =>
    parseCircuitSession({
      ...f.initial,
      graph: { ...f.initial.graph, wires: [{ id: "invalid" }] },
    }),
  );
});
