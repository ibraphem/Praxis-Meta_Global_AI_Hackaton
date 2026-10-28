import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { analysisSchema } from "../lib/vision";
import { ResultsPanel } from "../components/results-panel";
import { BreadboardRegionOverlays } from "../components/breadboard-regions";
import { createVisionProxy } from "../lib/server/vision-proxy";

function grouped() {
  return analysisSchema.parse({
    image: { width: 100, height: 80 },
    objects: [
      {
        id: "breadboard_1",
        type: "breadboard",
        bbox: [10, 10, 80, 52],
        interpretation: "confirmed",
        localizationSource: "derived",
        geometryStatus: "box_only",
        guidanceEligible: false,
        breadboardGrouping: {
          candidateIds: [
            "sam_breadboard_1",
            "sam_breadboard_2",
            "sam_breadboard_3",
            "sam_breadboard_4",
          ],
          geometrySource: "candidate_union",
          wholeCandidateId: null,
          reviewSource: "muse",
        },
      },
    ],
    breadboardAudit: {
      candidates: [
        [10, 10, 80, 6],
        [10, 16, 80, 20],
        [10, 36, 80, 20],
        [10, 56, 80, 6],
      ].map((bbox, i) => ({
        id: `sam_breadboard_${i + 1}`,
        bbox,
        confidence: 0.8,
        extent: "part",
        decision: "confirmed",
      })),
      unresolvedCandidateIds: [],
    },
    provenance: {
      mode: "combined",
      reasoningModel: "test",
      segmentationModel: "test",
    },
  });
}
function panel(result: ReturnType<typeof grouped>) {
  return renderToStaticMarkup(
    createElement(ResultsPanel, {
      result,
      loading: false,
      selectedId: "sam_breadboard_1",
      onSelect: () => {},
      elapsed: 1,
    }),
  );
}
function unresolved() {
  const value = grouped();
  value.objects = [];
  value.breadboardAudit!.unresolvedCandidateIds =
    value.breadboardAudit!.candidates.map((c) => c.id);
  return analysisSchema.parse(value);
}

test("four board regions produce one displayed board with explicit derived geometry and no combined SAM score", () => {
  const html = panel(grouped());
  assert.match(html, /Breadboard 1/);
  assert.doesNotMatch(html, /Breadboard 2|80%|Unresolved board regions/);
  assert.match(html, /Grouped SAM regions/);
  assert.match(html, /DERIVED BOX/);
  assert.match(html, /object-count">01/);
});
test("unresolved board regions are inspectable without becoming counted physical boards", () => {
  const value = unresolved(),
    html = panel(value);
  assert.match(html, /Unresolved board regions/);
  assert.match(html, /Board region 4/);
  assert.match(html, /not confidence in the board count/);
  assert.match(html, /Board regions need a closer look/);
  assert.match(html, /object-count">00/);
  assert.doesNotMatch(html, /Breadboard 1/);
  const overlay = renderToStaticMarkup(
    createElement(BreadboardRegionOverlays, {
      result: value,
      selectedId: "sam_breadboard_1",
      onSelect: () => {},
    }),
  );
  assert.equal((overlay.match(/<button/g) ?? []).length, 4);
  assert.match(overlay, /Inspect unresolved board region 1/);
});
test("the proxy preserves validated grouping evidence and rejects fabricated confidence or broken references", async () => {
  for (const bad of [false, true]) {
    const result = grouped();
    if (bad) result.objects[0]!.confidence = 0.99;
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
    assert.equal(response.status, bad ? 502 : 200);
    if (!bad) assert.deepEqual(await response.json(), result);
  }
});
test("the public contract rejects inconsistent board partitions, geometry, sources and unbounded audit data", () => {
  const mutations: ((v: ReturnType<typeof grouped>) => void)[] = [
    (v) => {
      v.objects[0]!.bbox[2] = 79;
    },
    (v) => {
      v.objects[0]!.localizationSource = "sam";
    },
    (v) => {
      v.objects[0]!.breadboardGrouping!.candidateIds.push("sam_breadboard_99");
    },
    (v) => {
      v.objects[0]!.breadboardGrouping!.candidateIds.push("sam_breadboard_1");
    },
    (v) => {
      v.breadboardAudit!.unresolvedCandidateIds.push("sam_breadboard_1");
    },
    (v) => {
      v.breadboardAudit!.candidates[0]!.decision = "rejected";
    },
    (v) => {
      v.breadboardAudit!.candidates[0]!.extent = "uncertain";
    },
    (v) => {
      v.breadboardAudit!.candidates[0]!.bbox[0] = 99;
    },
    (v) => {
      v.breadboardAudit!.candidates.push(v.breadboardAudit!.candidates[0]!);
    },
    (v) => {
      v.breadboardAudit!.candidates = Array(101).fill(
        v.breadboardAudit!.candidates[0],
      );
    },
    (v) => {
      v.objects[0]!.type = "led";
      v.objects[0]!.id = "led_1";
    },
    (v) => {
      delete v.breadboardAudit;
    },
    (v) => {
      v.provenance.mode = "reasoning-only";
    },
  ];
  for (const mutate of mutations) {
    const value = grouped();
    mutate(value);
    assert.equal(analysisSchema.safeParse(value).success, false);
  }
});
