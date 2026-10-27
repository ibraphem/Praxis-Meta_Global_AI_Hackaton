import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AnalysisError } from "../components/analysis-error";
import { createVisionProxy as createProxy } from "../lib/server/vision-proxy";
import { failureSchema } from "../lib/diagnostics";

const createVisionProxy = (options: Parameters<typeof createProxy>[0] = {}) =>
  createProxy({ logger: () => undefined, ...options });
const request = (signal?: AbortSignal) =>
  new Request("http://localhost:3001/api/vision/analyze", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=test" },
    body: "photograph",
    ...(signal ? { signal } : {}),
  });
const waitForAbort: typeof fetch = async (_url, options) =>
  new Promise((_resolve, reject) => {
    if (options!.signal!.aborted) {
      reject(options!.signal!.reason);
      return;
    }
    options!.signal!.addEventListener(
      "abort",
      () => reject(options!.signal!.reason),
      { once: true },
    );
  });

test("every backend timeout retains its code and validated source, stage, model, and timeline", async () => {
  for (const [code, source] of [
    ["PROVIDER_TIMEOUT", "backend_provider"],
    ["ANALYSIS_TIMEOUT", "backend_analysis"],
    ["META_API_TIMEOUT", "meta_api"],
  ] as const) {
    let forwardedId: string | null = null;
    const events: Record<string, unknown>[] = [];
    const details = {
      source,
      stage: "sam.led",
      model: "sam-3.1",
      attempt: 2,
      elapsedMs: 45001,
      totalElapsedMs: 91000,
      timeoutMs: 45000,
      activeStages: ["sam.led"],
      timings: [
        {
          stage: "sam.led",
          kind: "request",
          startedAtMs: 46000,
          durationMs: 45001,
          status: "timed_out",
          attempt: 2,
          timeoutMs: 45000,
          code,
        },
      ],
    };
    const proxy = createVisionProxy({
      logger: (event) => events.push(event),
      fetcher: async (_url, options) => {
        forwardedId = new Headers(options?.headers).get("x-request-id");
        return Response.json(
          {
            error: {
              code,
              message: "private-provider-prompt-and-key",
              requestId: forwardedId,
              details,
            },
          },
          { status: 504 },
        );
      },
    });
    const response = await proxy(request());
    const payload = await response.json();
    assert.equal(response.status, 504);
    assert.equal(payload.error.code, code);
    assert.equal(payload.error.requestId, forwardedId);
    assert.equal(response.headers.get("x-request-id"), forwardedId);
    assert.deepEqual(payload.error.details, details);
    assert.ok(failureSchema.safeParse(payload).success);
    assert.doesNotMatch(
      JSON.stringify({ payload, events }),
      /private-provider-prompt-and-key/,
    );
    assert.ok(events.every((event) => event.requestId === forwardedId));
  }
});

test("a frontend deadline is PROXY_TIMEOUT, not a backend or model timeout", async () => {
  const proxy = createVisionProxy({
    environment: { PRAXIS_PROXY_TIMEOUT_MS: "15" },
    fetcher: waitForAbort,
  });
  const response = await proxy(request());
  const payload = await response.json();
  assert.equal(response.status, 504);
  assert.equal(payload.error.code, "PROXY_TIMEOUT");
  assert.equal(payload.error.details.source, "frontend_proxy");
  assert.equal(payload.error.details.stage, "backend.wait");
  assert.equal(payload.error.details.timeoutMs, 15);
});

test("cancellation is 499 with client provenance, never an analysis timeout", async () => {
  const controller = new AbortController();
  const proxy = createVisionProxy({
    fetcher: async (_url, options) => {
      controller.abort();
      options!.signal!.throwIfAborted();
      return Response.json({});
    },
  });
  const response = await proxy(request(controller.signal));
  const payload = await response.json();
  assert.equal(response.status, 499);
  assert.equal(payload.error.code, "REQUEST_CANCELLED");
  assert.equal(payload.error.details.source, "client");
});

test("a proxy deadline while reading backend output identifies the response-reading stage", async () => {
  const proxy = createVisionProxy({
    environment: { PRAXIS_PROXY_TIMEOUT_MS: "15" },
    fetcher: async () => new Response(new ReadableStream()),
  });
  const response = await proxy(request());
  const payload = await response.json();
  assert.equal(payload.error.code, "PROXY_TIMEOUT");
  assert.equal(payload.error.details.stage, "proxy.response");
});

test("legacy or untrusted backend timeout envelopes remain unattributed and sanitized", async () => {
  for (const error of [
    { code: "ANALYSIS_TIMEOUT", message: "secret" },
    {
      code: "PROVIDER_TIMEOUT",
      message: "secret",
      details: {
        source: "backend_provider",
        elapsedMs: 1,
        unexpected: "secret",
      },
    },
    {
      code: "SECRET_PROVIDER_CODE",
      details: { source: "backend_provider", elapsedMs: 1 },
    },
  ]) {
    const proxy = createVisionProxy({
      fetcher: async () => Response.json({ error }, { status: 504 }),
    });
    const response = await proxy(request());
    const payload = await response.json();
    assert.equal(payload.error.code, "BACKEND_TIMEOUT");
    assert.equal(payload.error.details.source, "backend");
    assert.doesNotMatch(JSON.stringify(payload), /secret|SECRET_PROVIDER_CODE/);
  }
});

test("invalid proxy budgets fail before forwarding an image", async () => {
  let calls = 0;
  const proxy = createVisionProxy({
    environment: { PRAXIS_PROXY_TIMEOUT_MS: "invalid" },
    fetcher: async () => {
      calls++;
      return Response.json({});
    },
  });
  assert.equal((await proxy(request())).status, 503);
  assert.equal(calls, 0);
});

test("the UI renders actionable timeout details and a request ID instead of dropping them", () => {
  const html = renderToStaticMarkup(
    createElement(AnalysisError, {
      failure: {
        code: "PROVIDER_TIMEOUT",
        message: "The model request timed out.",
        requestId: "de07b66f-f185-4dbc-80eb-e20c5c343f14",
        details: {
          source: "backend_provider",
          stage: "sam.led",
          model: "sam-3.1",
          attempt: 2,
          timeoutMs: 45000,
          elapsedMs: 45001,
          timings: [
            {
              stage: "sam.led",
              kind: "request",
              startedAtMs: 0,
              durationMs: 45001,
              status: "timed_out",
              attempt: 2,
            },
          ],
        },
      },
      onDismiss: () => undefined,
    }),
  );
  for (const expected of [
    "sam.led",
    "sam-3.1",
    "PROVIDER_TIMEOUT",
    "45.00 seconds",
    "de07b66f-f185-4dbc-80eb-e20c5c343f14",
    "timed_out",
  ])
    assert.ok(html.includes(expected));
});
