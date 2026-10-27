import assert from "node:assert/strict";
import { test } from "node:test";
import { createVisionProxy as createProxy } from "../lib/server/vision-proxy";
import { analysisSchema, MAX_FILE_BYTES } from "../lib/vision";

const createVisionProxy = (options: Parameters<typeof createProxy>[0] = {}) =>
  createProxy({ logger: () => undefined, ...options });

const fixture = {
  image: { width: 640, height: 480 },
  objects: [
    {
      id: "led_1",
      type: "led",
      bbox: [120, 85, 35, 60],
      color: "green",
      confidence: 0.91,
      interpretation: "confirmed",
    },
  ],
  provenance: {
    mode: "combined",
    segmentationModel: "sam-3.1",
    reasoningModel: "muse-spark-1.3",
  },
};

function request(headers: HeadersInit = {}, body = "photograph") {
  const merged = new Headers({
    "content-type": "multipart/form-data; boundary=test-boundary",
    origin: "http://localhost:3001",
  });
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  return new Request("http://localhost:3001/api/vision/analyze", {
    method: "POST",
    headers: merged,
    body,
  });
}

test("proxy forwards the bounded upload using server credentials and returns validated detections", async () => {
  let calls = 0;
  const proxy = createVisionProxy({
    environment: {
      PRAXIS_BACKEND_URL: "http://127.0.0.1:3000",
      PRAXIS_API_TOKEN: "server-secret",
    },
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, "http://127.0.0.1:3000/api/vision/analyze");
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("authorization"), "Bearer server-secret");
      assert.equal(headers.get("cookie"), null);
      assert.equal(headers.get("origin"), null);
      assert.equal(options?.redirect, "error");
      assert.equal(
        new TextDecoder().decode(options?.body as Uint8Array),
        "photograph",
      );
      return Response.json(fixture);
    },
  });
  const response = await proxy(
    request({ authorization: "Bearer client-value", cookie: "private=1" }),
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(await response.json(), fixture);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
});

test("cross-origin, wrong content type, and declared oversized uploads never reach the backend", async () => {
  let calls = 0;
  const proxy = createVisionProxy({
    fetcher: async () => {
      calls++;
      return Response.json(fixture);
    },
  });
  for (const [headers, status] of [
    [{ origin: "https://untrusted.example" }, 403],
    [{ "content-type": "application/json" }, 415],
    [{ "content-length": String(MAX_FILE_BYTES + 100_000) }, 413],
  ] as const)
    assert.equal((await proxy(request(headers))).status, status);
  assert.equal(calls, 0);
});

test("origin checks use the incoming Host when Next reconstructs a localhost URL", async () => {
  const proxy = createVisionProxy({
    fetcher: async () => Response.json(fixture),
  });
  assert.equal(
    (
      await proxy(
        request({ host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await proxy(
        request({ host: "127.0.0.1:3001", origin: "http://untrusted.example" }),
      )
    ).status,
    403,
  );
});

test("chunked uploads are bounded even without Content-Length", async () => {
  let calls = 0;
  let cancelled = false;
  const proxy = createVisionProxy({
    fetcher: async () => {
      calls++;
      return Response.json(fixture);
    },
  });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_FILE_BYTES + 100_000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const streamed = new Request(request(), {
    body: stream,
    duplex: "half",
  } as RequestInit);
  const response = await proxy(streamed);
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
  assert.equal(cancelled, true);
});

test("unsafe administrator-configured backend URLs cannot receive photographs or credentials", async () => {
  for (const url of [
    "http://remote.example",
    "https://user:secret@remote.example",
    "https://remote.example?token=secret",
    "file:///etc/passwd",
  ]) {
    let calls = 0;
    const proxy = createVisionProxy({
      environment: { PRAXIS_BACKEND_URL: url },
      fetcher: async () => {
        calls++;
        return Response.json(fixture);
      },
    });
    assert.equal((await proxy(request())).status, 503);
    assert.equal(calls, 0);
  }
});

test("backend errors are sanitized instead of leaking raw provider output", async () => {
  for (const status of [400, 401, 413, 415, 422, 429, 500, 503, 504]) {
    const proxy = createVisionProxy({
      fetcher: async () =>
        Response.json(
          { error: { message: "private-token-and-file.jpg" } },
          { status },
        ),
    });
    const response = await proxy(request());
    assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /private-token|file\.jpg/);
  }
});

test("malformed, unsupported, duplicated, and out-of-bounds detections are rejected", async () => {
  const object = fixture.objects[0];
  for (const raw of [
    { ...fixture, objects: [{ ...object, type: "capacitor" }] },
    { ...fixture, objects: [{ ...object, bbox: [630, 0, 100, 100] }] },
    { ...fixture, objects: [object, object] },
    { ...fixture, objects: [{ ...object, id: "resistor_1" }] },
    { ...fixture, objects: [{ ...object, confidence: 1.5 }] },
  ]) {
    assert.equal(analysisSchema.safeParse(raw).success, false);
    const proxy = createVisionProxy({
      fetcher: async () => Response.json(raw),
    });
    assert.equal((await proxy(request())).status, 502);
  }
  const proxy = createVisionProxy({
    fetcher: async () => new Response("not JSON"),
  });
  assert.equal((await proxy(request())).status, 502);
});

test("oversized backend responses and connection failures become safe errors", async () => {
  const oversized = createVisionProxy({
    fetcher: async () => new Response("x".repeat(300_000)),
  });
  assert.equal((await oversized(request())).status, 502);
  const disconnected = createVisionProxy({
    fetcher: async () => {
      throw new Error("server-secret");
    },
  });
  const response = await disconnected(request());
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /server-secret/);
});

test("empty scenes and missing confidence remain valid", async () => {
  for (const raw of [
    { ...fixture, objects: [] },
    {
      ...fixture,
      objects: [
        {
          id: "led_1",
          type: "led",
          bbox: [1, 1, 10, 10],
          interpretation: "uncertain",
        },
      ],
      provenance: { mode: "reasoning-only", reasoningModel: "muse-spark-1.3" },
    },
  ]) {
    const proxy = createVisionProxy({
      fetcher: async () => Response.json(raw),
    });
    const response = await proxy(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), raw);
  }
});

test("admission is bounded and slots are released after a cancelled upload", async () => {
  const proxy = createVisionProxy({
    fetcher: async () => Response.json(fixture),
  });
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map((controller) =>
    proxy(
      new Request(request(), {
        signal: controller.signal,
        body: new ReadableStream(),
        duplex: "half",
      } as RequestInit),
    ),
  );
  assert.equal((await proxy(request())).status, 503);
  for (const controller of controllers) controller.abort();
  assert.deepEqual(
    (await Promise.all(pending)).map((response) => response.status),
    [499, 499],
  );
  assert.equal((await proxy(request())).status, 200);
});
