import { test } from "node:test";
import assert from "node:assert/strict";
import { createAutomaticCircuitProxy } from "../lib/server/automatic-circuit-proxy";
const id = "11111111-1111-4111-8111-111111111111";
const inspection = {
  id,
  imageHash: "a".repeat(64),
  image: { width: 640, height: 960 },
  createdAt: 1,
  revision: 0,
  status: "queued",
  stage: "Finding grid",
  model: "test-model",
  requestCount: 0,
  warnings: [],
  error: null,
  observations: null,
  input: null,
  graph: null,
  reviewedAt: null,
  reviewer: null,
};
test("inspection proxy validates IDs and origins before dispatch", async () => {
  let calls = 0;
  const proxy = createAutomaticCircuitProxy({
    fetcher: async () => {
      calls++;
      return Response.json(inspection);
    },
  });
  assert.equal(
    (
      await proxy(
        new Request("http://localhost:3001/api/circuit-inspections/bad"),
        "get",
        "bad",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await proxy(
        new Request(`http://localhost:3001/api/circuit-inspections/${id}`, {
          headers: { origin: "https://unrelated.test" },
        }),
        "get",
        id,
      )
    ).status,
    403,
  );
  assert.equal(calls, 0);
});
test("inspection upload forwards the photograph and private bearer token once", async () => {
  let calls = 0;
  const proxy = createAutomaticCircuitProxy({
    environment: {
      PRAXIS_BACKEND_URL: "http://127.0.0.1:3000",
      PRAXIS_API_TOKEN: "private-test-token",
    },
    fetcher: async (input, init) => {
      calls++;
      assert.equal(
        String(input),
        "http://127.0.0.1:3000/api/circuit-inspections",
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer private-test-token",
      );
      assert.equal(init?.method, "POST");
      assert.ok(init?.body);
      return Response.json(inspection, { status: 202 });
    },
  });
  const form = new FormData();
  form.append(
    "image",
    new Blob(["synthetic pixels"], { type: "image/jpeg" }),
    "test.jpg",
  );
  const response = await proxy(
    new Request("http://localhost:3001/api/circuit-inspections", {
      method: "POST",
      body: form,
    }),
    "create",
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).id, id);
  assert.equal(calls, 1);
});
test("diagnosis is forwarded as bounded JSON through the private backend", async () => {
  let calls = 0;
  const proxy = createAutomaticCircuitProxy({
    fetcher: async (input, init) => {
      calls++;
      assert.equal(
        String(input),
        `http://127.0.0.1:3000/api/circuit-inspections/${id}/diagnose`,
      );
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)),
        { expectedRevision: 1, goal: "Light one LED", verificationOf: null },
      );
      return Response.json(inspection);
    },
  });
  const response = await proxy(
    new Request(
      `http://localhost:3001/api/circuit-inspections/${id}/diagnose`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 1,
          goal: "Light one LED",
          verificationOf: null,
        }),
      },
    ),
    "diagnose",
    id,
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});
test("inspection proxy rejects mismatched responses and unsafe backend configuration", async () => {
  const proxy = createAutomaticCircuitProxy({
    fetcher: async () =>
      Response.json({
        ...inspection,
        id: "22222222-2222-4222-8222-222222222222",
      }),
  });
  assert.equal(
    (
      await proxy(
        new Request(`http://localhost:3001/api/circuit-inspections/${id}`),
        "get",
        id,
      )
    ).status,
    502,
  );
  let called = false;
  const unsafe = createAutomaticCircuitProxy({
    environment: { PRAXIS_BACKEND_URL: "http://external.test" },
    fetcher: async () => {
      called = true;
      return Response.json(inspection);
    },
  });
  assert.equal(
    (
      await unsafe(
        new Request(`http://localhost:3001/api/circuit-inspections/${id}`),
        "get",
        id,
      )
    ).status,
    503,
  );
  assert.equal(called, false);
});
