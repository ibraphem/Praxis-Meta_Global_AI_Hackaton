import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultsPanel } from "../components/results-panel";
import { WireOverlays } from "../components/wire-overlays";
import { analysisSchema } from "../lib/vision";
import { createVisionProxy } from "../lib/server/vision-proxy";

const wire = {
  id: "jumper_wire_1",
  type: "jumper_wire",
  bbox: [10, 20, 20, 20],
  color: "green",
  localizationSource: "sam",
  detectionSource: "muse",
  interpretation: "uncertain",
  geometryStatus: "segmented",
  guidanceEligible: false,
  identityStatus: "unverified",
  mask: {
    format: "svg_path",
    width: 20,
    height: 20,
    path: "M2 1L4 1L4 18L2 18Z",
  },
};
const region = {
  id: "wire_region_1",
  type: "jumper_wire",
  bbox: [30, 10, 60, 60],
  color: "yellow",
  refinementStatus: "ambiguous",
  reason: "ambiguous_mask",
  guidanceEligible: false,
};
const result = {
  image: { width: 100, height: 80 },
  objects: [wire],
  proposals: [region],
  provenance: {
    mode: "combined",
    segmentationModel: "sam-3.1",
    reasoningModel: "muse-spark-1.3",
    wireAudit: {
      samCandidates: 0,
      acceptedSam: 0,
      recoveredByMuse: 1,
      regionsProposedByMuse: 2,
      refinementAttempts: 2,
      unresolvedRegions: 1,
    },
  },
};

test("the proxy preserves segmented geometry and separately unresolved regions", async () => {
  const proxy = createVisionProxy({
    logger: () => undefined,
    fetcher: async () => Response.json(result),
  });
  const response = await proxy(
    new Request("http://localhost:3001/api/vision/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: "photo",
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
});

test("wire overlays use paths for hit testing and distinct non-wire region labels", () => {
  const html = renderToStaticMarkup(
    createElement(WireOverlays, {
      result: analysisSchema.parse(result),
      selectedId: "jumper_wire_1",
      onSelect: () => undefined,
    }),
  );
  assert.ok(html.includes("<path"));
  assert.ok(html.includes("translate(10 20) scale(1 1)"));
  assert.ok(html.includes("Inspect Jumper wire 1 mask"));
  assert.ok(html.includes("Wire region A"));
  assert.ok(!html.includes("bounding-box"));
});

test("the results separate search regions from individual wire candidates and disclose identity limits", () => {
  const html = renderToStaticMarkup(
    createElement(ResultsPanel, {
      result: analysisSchema.parse(result),
      loading: false,
      selectedId: "wire_region_1",
      onSelect: () => undefined,
      elapsed: 1,
    }),
  );
  for (const text of [
    "Wire candidates",
    "Unresolved regions",
    "Wire region A",
    "not counted as individual components",
    "Numbers reset with each analysis",
  ])
    assert.ok(html.includes(text));
  assert.ok(!html.includes("Jumper wire 2"));
});

test("ambiguous regions alone do not generate a numbered individual wire", () => {
  const parsed = analysisSchema.parse({ ...result, objects: [] });
  const html = renderToStaticMarkup(
    createElement(ResultsPanel, {
      result: parsed,
      loading: false,
      selectedId: null,
      onSelect: () => undefined,
      elapsed: 1,
    }),
  );
  assert.ok(html.includes("Wire regions need a closer look"));
  assert.ok(!html.includes("Jumper wire 1"));
});

test("the frontend rejects unsafe mask content, broad wire objects and guidance eligibility", () => {
  for (const invalid of [
    { ...wire, mask: undefined },
    { ...wire, guidanceEligible: true },
    { ...wire, localizationSource: "muse", confidence: 0.99 },
    { ...wire, mask: { ...wire.mask, path: '<svg onload="alert(1)">' } },
  ])
    assert.equal(
      analysisSchema.safeParse({ ...result, objects: [invalid] }).success,
      false,
    );
  assert.equal(
    analysisSchema.safeParse({
      ...result,
      proposals: [{ ...region, bbox: [90, 0, 20, 20] }],
    }).success,
    false,
  );
});
