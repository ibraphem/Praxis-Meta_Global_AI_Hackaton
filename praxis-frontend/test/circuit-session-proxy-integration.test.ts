import { test } from "node:test";
import assert from "node:assert/strict";
import { createCircuitSessionProxy } from "../lib/server/circuit-session-proxy";

test("session proxy creates a real backend session and prepares a capture without inference", async () => {
  // Load the backend at runtime: it uses newer Node/SQLite types than the frontend.
  const { buildApp } = await import(
    new URL("../../praxis-backend/server/src/app.ts", import.meta.url).href
  );
  const { loadConfig } = await import(
    new URL("../../praxis-backend/server/src/config.ts", import.meta.url).href
  );
  const { JobStore } = await import(
    new URL("../../praxis-backend/server/src/jobs/store.ts", import.meta.url).href
  );
  const config = loadConfig({
    NODE_ENV: "test",
    META_API_KEY: "unused-test-provider-key",
  });
  const store = new JobStore(config, ":memory:");
  let providerCalls = 0;
  const app = await buildApp(config, undefined, () => {}, undefined, {
    store,
    experimentClient: {
      async post() {
        providerCalls++;
        throw Error("Capture preparation must not call an AI provider.");
      },
    },
  });
  const proxy = createCircuitSessionProxy({
    environment: { PRAXIS_BACKEND_URL: "http://127.0.0.1:3000" },
    fetcher: async (url, init) => {
      const result = await app.inject({
        method: init?.method as "GET" | "POST",
        url: new URL(String(url)).pathname,
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(init?.body
          ? { payload: Buffer.from(init.body as Uint8Array) }
          : {}),
      });
      return new Response(result.body, {
        status: result.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  try {
    const created = await proxy(
      new Request("http://localhost/api/circuit-sessions", { method: "POST" }),
      "create",
    );
    assert.equal(created.status, 200, await created.clone().text());
    const initial = await created.json();
    const id = initial.session.sessionId;
    // The real worker polls while a person positions the circuit before capture.
    assert.equal(store.claim("idle-worker-before-capture"), undefined);
    const prepared = await proxy(
      new Request(`http://localhost/api/circuit-sessions/${id}/prepare-capture`, {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: initial.session.revision,
          purpose: "setup",
          frameHash: "a".repeat(64),
          width: 640,
          height: 480,
          capturedAt: Date.now(),
          cameraFrame: { width: 640, height: 480 },
        }),
      }),
      "prepare-capture",
      id,
    );
    assert.equal(prepared.status, 200, await prepared.clone().text());
    const view = await prepared.json();
    assert.equal(view.captures.length, 1);
    assert.equal(view.captures[0].plan.purpose, "setup");
    assert.equal(view.captures[0].analysisId, null);
    assert.equal(store.claim("idle-worker-before-approval"), undefined);
    const restored = await proxy(
      new Request(`http://localhost/api/circuit-sessions/${id}`),
      "get",
      id,
    );
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.equal((await restored.json()).captures.length, 1);
    assert.equal(providerCalls, 0);
  } finally {
    await app.close();
    store.close();
  }
});
