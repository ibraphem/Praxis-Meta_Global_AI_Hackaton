import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EndpointRequestTiming } from "../components/endpoint-request-timing";
import {
  timingBreakdown,
  type EndpointRequestTiming as RequestTiming,
} from "../lib/wires/request-timing";

const timing: RequestTiming = {
  id: "request",
  wireCandidateId: "jumper_wire_1",
  analysisId: "analysis",
  imageId: "image",
  startedAtMs: 100,
  elapsedMs: 85000,
  status: "completed",
  server: {
    elapsedMs: 84000,
    timings: [
      {
        stage: "image.prepare",
        startedAtMs: 0,
        durationMs: 100,
        status: "completed",
        kind: "work",
      },
      {
        stage: "wire.grounding",
        startedAtMs: 100,
        durationMs: 400,
        status: "completed",
        kind: "work",
      },
      {
        stage: "muse.endpoints",
        startedAtMs: 500,
        durationMs: 83000,
        status: "completed",
        kind: "request",
      },
    ],
  },
};

test("endpoint timing separates client total, backend, image grounding and Muse latency", () => {
  assert.deepEqual(timingBreakdown(timing), {
    preparationMs: 100,
    groundingMs: 400,
    museMs: 83000,
    attempts: 1,
  });
  const html = renderToStaticMarkup(
    createElement(EndpointRequestTiming, { timing }),
  );
  assert.match(html, /85.0 s/);
  assert.match(html, /Backend: 84.0 s/);
  assert.match(html, /Visual grounding: 0.4 s/);
  assert.match(html, /Muse: 83.0 s/);
});

test("failed/cancelled timings remain inspectable and missing stages are not invented as zero latency", () => {
  for (const status of ["failed", "cancelled", "discarded"] as const) {
    const html = renderToStaticMarkup(
      createElement(EndpointRequestTiming, { timing: { ...timing, status } }),
    );
    assert.match(html, new RegExp(status));
    assert.match(html, /85.0 s/);
  }
  const without = { ...timing, server: undefined };
  assert.deepEqual(timingBreakdown(without), {
    preparationMs: null,
    groundingMs: null,
    museMs: null,
    attempts: 0,
  });
  assert.doesNotMatch(
    renderToStaticMarkup(
      createElement(EndpointRequestTiming, { timing: without }),
    ),
    /Muse:|Backend:/,
  );
});
