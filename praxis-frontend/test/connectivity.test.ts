import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analysisJobSchema } from "../lib/analysis-jobs";
import {
  parseConnectivityView,
  parseConnectivityEvidence,
} from "../lib/connectivity";
import { createAnalysisJobProxy } from "../lib/server/analysis-job-proxy";
const fixture = () =>
  JSON.parse(
    readFileSync(
      resolve(process.cwd(), "test/fixtures/connectivity.json"),
      "utf8",
    ),
  );

test("synthetic backend contract preserves topology, diagnosed fault, correction and evidence without claiming physical acceptance", () => {
  const f = fixture(),
    job = analysisJobSchema.parse(f.job),
    v = parseConnectivityView(f.view, job.analysisId, job.imageHash);
  assert.equal(v.source!.input.validationScope, "synthetic_fixture");
  assert.equal(
    v.comparisons[0]!.comparison.findings[0]!.status,
    "confirmed_fault",
  );
  assert.equal(
    v.comparisons[0]!.comparison.findings[0]!.scope,
    "synthetic_fixture",
  );
  const after = parseConnectivityView(
    f.compared,
    job.analysisId,
    job.imageHash,
  );
  assert.equal(after.history.length, 1);
  assert.equal(
    after.comparisons.at(-1)!.comparison.findings[0]!.status,
    "no_fault",
  );
  assert.equal(after.additionalInferenceRequests, 0);
  const archive = parseConnectivityEvidence(f.evidence, job.analysisId);
  assert.equal(archive.graphHistory.length, 2);
  assert.ok(
    archive.graphHistory.some(
      (g) => g.graph.graphHash === v.graph!.graph.graphHash,
    ),
  );
  assert.notEqual(after.graph!.graph.graphHash, v.graph!.graph.graphHash);
  assert.throws(
    () =>
      parseConnectivityView(
        { ...f.view, imageHash: "b".repeat(64) },
        job.analysisId,
        job.imageHash,
      ),
    /match/,
  );
});
test("connectivity proxy uses fixed read/review endpoints, server authentication and response identity checks", async () => {
  const f = fixture();
  let calls = 0;
  const proxy = createAnalysisJobProxy({
    environment: {
      PRAXIS_BACKEND_URL: "http://127.0.0.1:3000",
      PRAXIS_API_TOKEN: "server-only-secret",
    },
    logger: () => {},
    fetcher: async (url, init) => {
      calls++;
      const u = new URL(String(url));
      assert.ok(
        u.pathname.endsWith(
          calls === 1 ? "/connectivity" : "/review-connectivity",
        ),
      );
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer server-only-secret",
      );
      assert.equal(init?.method, calls === 1 ? "GET" : "POST");
      return Response.json(calls === 1 ? f.view : f.corrected);
    },
  });
  const root = `http://localhost/api/analyses/${f.job.analysisId}`;
  assert.equal(
    (
      await proxy(
        new Request(root + "/connectivity"),
        "connectivity",
        f.job.analysisId,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await proxy(
        new Request(root + "/review-connectivity", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            origin: "http://localhost",
          },
          body: JSON.stringify({ expectedRevision: 1 }),
        }),
        "review-connectivity",
        f.job.analysisId,
      )
    ).status,
    200,
  );
  assert.equal(calls, 2);
  const wrong = createAnalysisJobProxy({
    environment: {},
    logger: () => {},
    fetcher: async () =>
      Response.json({
        ...f.view,
        analysisId: "f7000000-0000-4000-a000-000000000002",
      }),
  });
  assert.equal(
    (
      await wrong(
        new Request(root + "/connectivity"),
        "connectivity",
        f.job.analysisId,
      )
    ).status,
    502,
  );
});
