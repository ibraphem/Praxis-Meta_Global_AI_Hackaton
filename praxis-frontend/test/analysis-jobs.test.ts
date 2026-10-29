import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisJobSchema,
  jobMessage,
  retryStage,
  jobIsActive,
} from "../lib/analysis-jobs";
import { analysisSchema } from "../lib/vision";
import { createAnalysisJobProxy } from "../lib/server/analysis-job-proxy";
import { completedJob } from "./fixtures/analysis-job";

const result = {
  image: { width: 100, height: 80 },
  objects: [],
  provenance: {
    mode: "combined",
    reasoningModel: "muse",
    segmentationModel: "sam",
  },
};
function partialJob() {
  const j = completedJob(result);
  j.status = "partial";
  j.revision = "sam";
  j.muse.status = "timed_out";
  Object.assign(j.muse.attempts[0]!, {
    status: "timed_out",
    retryPolicy: "manual_only",
    upstreamOutcome: "unknown",
    errorCode: "PROVIDER_TIMEOUT",
  });
  j.result!.provenance.mode = "sam-only";
  return j;
}
const req = (method = "GET", body?: FormData) =>
  new Request("http://localhost/api/analyses", {
    method,
    ...(body ? { body } : {}),
  });

test("partial jobs disclose uncertain upstream execution and offer only an eligible manual stage retry", () => {
  const j = partialJob();
  assert.ok(analysisJobSchema.safeParse(j).success);
  assert.equal(retryStage(j), "muse");
  assert.equal(jobIsActive(j), false);
  assert.match(jobMessage(j), /timed out/);
  assert.match(jobMessage(j), /may still have processed/);
  j.muse.status = "queued";
  j.muse.attempts[0]!.status = "queued";
  j.muse.attempts[0]!.retryPolicy = "dispatch_existing";
  assert.equal(retryStage(j), null);
  assert.equal(jobIsActive(j), true);
  j.muse.status = "interrupted";
  Object.assign(j.muse.attempts[0]!, {
    status: "interrupted",
    retryPolicy: "manual_only",
  });
  assert.equal(retryStage(j), "muse");
  assert.match(jobMessage(j), /was interrupted/);
});

test("saved-job responses preserve current provider diagnostics in completed and partial states", async () => {
  for (const job of [completedJob(result), partialJob()]) {
    job.sam.attempts[0]!.diagnostics = {
      requestId: job.sam.attempts[0]!.attemptId,
      elapsedMs: 25,
      timings: [
        {
          stage: "sam.jumper_wire",
          startedAtMs: 0,
          durationMs: 25,
          status: "completed",
          kind: "request",
          model: "sam-test",
          attempt: 1,
          timeoutMs: 45000,
          upstreamStatus: 200,
          payloadBytes: 2048,
          encodedImageBytes: 1024,
          promptChars: 4,
          outputTokenBudget: null,
          imageDimensions: [{ width: 100, height: 80 }],
          headersMs: 12,
          providerRequestId: "provider-test-123",
        },
      ],
    };
    job.muse.attempts[0]!.diagnostics = {
      requestId: job.muse.attempts[0]!.attemptId,
      elapsedMs: 45000,
      timings: [
        {
          stage: "muse.interpret",
          startedAtMs: 0,
          durationMs: 45000,
          status: job.status === "partial" ? "timed_out" : "completed",
          kind: "request",
          model: "muse-test",
          payloadBytes: 3000,
          encodedImageBytes: 1024,
          promptChars: 400,
          outputTokenBudget: null,
          imageDimensions: [{ width: 100, height: 80 }],
          ...(job.status === "partial"
            ? {
                code: "PROVIDER_TIMEOUT",
                timeoutType: "local_deadline" as const,
              }
            : { headersMs: 50 }),
        },
      ],
    };
    const proxy = createAnalysisJobProxy({
      fetcher: async () => Response.json(job),
    });
    const response = await proxy(req(), "get", job.analysisId);
    assert.equal(response.status, 200);
    const parsed = analysisJobSchema.parse(await response.json());
    assert.deepEqual(
      parsed.sam.attempts[0]!.diagnostics,
      job.sam.attempts[0]!.diagnostics,
    );
    assert.deepEqual(
      parsed.muse.attempts[0]!.diagnostics,
      job.muse.attempts[0]!.diagnostics,
    );
    assert.equal(parsed.result!.provenance.mode, job.result!.provenance.mode);
  }
});

test("SAM-only contract rejects promoted identities and board groupings", () => {
  const partial = {
    image: { width: 100, height: 80 },
    objects: [
      {
        id: "breadboard_1",
        type: "breadboard",
        bbox: [0, 0, 50, 50],
        interpretation: "uncertain",
        localizationSource: "sam",
        reviewStatus: "sam_unverified",
      },
    ],
    provenance: {
      mode: "sam-only",
      reasoningModel: "muse",
      segmentationModel: "sam",
    },
  };
  assert.ok(analysisSchema.safeParse(partial).success);
  assert.equal(
    analysisSchema.safeParse({
      ...partial,
      objects: [{ ...partial.objects[0], interpretation: "confirmed" }],
    }).success,
    false,
  );
  assert.equal(
    analysisSchema.safeParse({
      ...partial,
      objects: [{ ...partial.objects[0], reviewStatus: undefined }],
    }).success,
    false,
  );
});

test("job proxy validates statuses, strips browser credentials, and sends fixed create/retry paths", async () => {
  const j = partialJob();
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const proxy = createAnalysisJobProxy({
    environment: {
      PRAXIS_BACKEND_URL: "http://127.0.0.1:3000",
      PRAXIS_API_TOKEN: "server-secret",
    },
    fetcher: async (url, init) => {
      seen.push({ url: String(url), init });
      return Response.json(j);
    },
  });
  const body = new FormData();
  body.set("image", new Blob(["photo"], { type: "image/jpeg" }), "photo.jpg");
  const request = new Request("http://localhost/api/analyses", {
    method: "POST",
    body,
    headers: {
      cookie: "private-cookie",
      authorization: "Bearer client-secret",
      origin: "http://localhost",
    },
  });
  const response = await proxy(request, "create");
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(seen[0]!.url, "http://127.0.0.1:3000/api/analyses");
  const h = seen[0]!.init!.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer server-secret");
  assert.equal(h.cookie, undefined);
  assert.equal(h.origin, undefined);
  assert.equal(seen[0]!.init!.redirect, "error");
  assert.equal(
    (await proxy(req("POST"), "retry-muse", j.analysisId)).status,
    202,
  );
  assert.equal(
    seen[1]!.url,
    `http://127.0.0.1:3000/api/analyses/${j.analysisId}/retry-muse`,
  );
  assert.equal((await proxy(req(), "get", j.analysisId)).status, 200);
});

test("job proxy rejects untrusted origins, IDs, unsafe backends and internal mask leakage", async () => {
  const j = partialJob();
  let calls = 0;
  const proxy = createAnalysisJobProxy({
    fetcher: async () => {
      calls++;
      return Response.json(j);
    },
  });
  assert.equal(
    (
      await proxy(
        new Request("http://localhost/api/analyses", {
          headers: { origin: "https://evil.invalid" },
        }),
        "get",
        j.analysisId,
      )
    ).status,
    403,
  );
  assert.equal((await proxy(req(), "get", "../../private")).status, 404);
  assert.equal(calls, 0);
  const unsafe = createAnalysisJobProxy({
    environment: { PRAXIS_BACKEND_URL: "http://example.invalid" },
    fetcher: async () => {
      throw new Error("must not fetch");
    },
  });
  assert.equal((await unsafe(req(), "get", j.analysisId)).status, 503);
  const leaked = createAnalysisJobProxy({
    fetcher: async () =>
      Response.json({
        ...j,
        sam: { ...j.sam, snapshot: { image: "sensitive" } },
      }),
  });
  const response = await leaked(req(), "get", j.analysisId);
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /sensitive/);
});

test("job proxy bounds uploads, sanitizes errors, and separately serves original image bytes", async () => {
  const j = partialJob();
  const denied = createAnalysisJobProxy({
    fetcher: async () => new Response("secret provider body", { status: 409 }),
  });
  const response = await denied(req("POST"), "retry-muse", j.analysisId);
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), /secret/);
  const image = createAnalysisJobProxy({
    fetcher: async () =>
      new Response(new Uint8Array([255, 216, 255]), {
        headers: { "content-type": "image/jpeg" },
      }),
  });
  const photo = await image(req(), "image", j.analysisId);
  assert.equal(photo.headers.get("content-type"), "image/jpeg");
  assert.equal((await photo.arrayBuffer()).byteLength, 3);
  const request = new Request("http://localhost/api/analyses", {
    method: "POST",
    body: "x",
    headers: {
      "content-type": "multipart/form-data; boundary=x",
      "content-length": "999999999",
    },
  });
  assert.equal((await image(request, "create")).status, 413);
});

test("unreadable and oversized uploads fail before fetch without reporting a backend outage", async () => {
  let calls = 0;
  const events: Record<string, unknown>[] = [];
  const proxy = createAnalysisJobProxy({
    logger: (event) => events.push(event),
    fetcher: async () => {
      calls++;
      throw new Error("must not fetch");
    },
  });
  const body = new FormData();
  body.set("image", new Blob(["photo"]), "photo.jpg");
  const request = req("POST", body);
  const reader = request.body!.getReader();
  try {
    const response = await proxy(request, "create");
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "UPLOAD_READ_FAILED");
  } finally {
    reader.releaseLock();
  }
  assert.equal(calls, 0);
  assert.equal(events[0]!.phase, "upload");
  const oversized = new Request("http://localhost/api/analyses", {
    method: "POST",
    body: new Uint8Array(8 * 1024 * 1024 + 65537),
    headers: { "content-type": "multipart/form-data; boundary=x" },
  });
  const response = await proxy(oversized, "create");
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "UPLOAD_TOO_LARGE");
  assert.equal(calls, 0);
});

test("unreadable or oversized backend responses are distinguished from connection failures", async () => {
  const j = partialJob();
  for (const raw of [
    "<html>not JSON</html>",
    "x".repeat(2 * 1024 * 1024 + 1),
  ]) {
    const events: Record<string, unknown>[] = [];
    const proxy = createAnalysisJobProxy({
      logger: (event) => events.push(event),
      fetcher: async () => new Response(raw),
    });
    const response = await proxy(req(), "get", j.analysisId);
    assert.equal(response.status, 502);
    assert.equal(
      (await response.json()).error.code,
      "INVALID_BACKEND_RESPONSE",
    );
    assert.equal(events[0]!.phase, "backend.response");
    assert.doesNotMatch(JSON.stringify(events), /not JSON/);
  }
});

test("connection diagnostics retain safe transport codes without exposing exception messages", async () => {
  const j = partialJob(),
    events: Record<string, unknown>[] = [];
  const proxy = createAnalysisJobProxy({
    logger: (event) => events.push(event),
    fetcher: async () => {
      throw new TypeError("private URL and credential", {
        cause: Object.assign(new Error("secret"), { code: "ECONNREFUSED" }),
      });
    },
  });
  const response = await proxy(req(), "get", j.analysisId);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "BACKEND_UNREACHABLE");
  assert.equal(events[0]!.phase, "backend.connect");
  assert.deepEqual(events[0]!.transportCodes, ["ECONNREFUSED"]);
  assert.doesNotMatch(JSON.stringify(events), /private URL|credential|secret/);
});

test("invalid configuration and client cancellation are not backend connection errors", async () => {
  const j = partialJob();
  const invalid = createAnalysisJobProxy({
    environment: { PRAXIS_BACKEND_URL: "invalid URL" },
    logger: () => undefined,
  });
  const bad = await invalid(req(), "get", j.analysisId);
  assert.equal(bad.status, 503);
  assert.equal((await bad.json()).error.code, "INVALID_PROXY_CONFIG");
  const controller = new AbortController();
  const proxy = createAnalysisJobProxy({
    logger: () => undefined,
    fetcher: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        );
      }),
  });
  const pending = proxy(
    new Request("http://localhost/api/analyses", { signal: controller.signal }),
    "get",
    j.analysisId,
  );
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.status, 499);
  assert.equal((await cancelled.json()).error.code, "REQUEST_CANCELLED");
});

test("snapshot provenance and experiment reservations survive job validation and block manual retries", () => {
  const job = partialJob(),
    sourceAttemptId = job.sam.attempts[0]!.attemptId;
  job.sam.snapshotRef = {
    samSnapshotId: sourceAttemptId,
    samSnapshotHash: "2".repeat(64),
    imageHash: job.imageHash,
    model: "sam-test",
    processingVersion: "sam-checkpoint-v1",
    sourceAttemptId,
    createdAt: job.createdAt,
    origin: "recorded",
  };
  Object.assign(job.muse.attempts[0]!, {
    samSnapshotId: sourceAttemptId,
    samSnapshotHash: "2".repeat(64),
    snapshotBinding: "recorded",
  });
  job.result!.provenance.samSnapshotId = sourceAttemptId;
  job.result!.provenance.samSnapshotHash = "2".repeat(64);
  job.result!.provenance.jobAnalysisId = job.analysisId;
  job.result!.provenance.snapshotProcessingVersion = "sam-checkpoint-v1";
  job.experiment = {
    experimentId: sourceAttemptId,
    analysisId: job.analysisId,
    status: "running",
    leaseUntil: Date.now() + 15000,
  };
  assert.ok(analysisJobSchema.safeParse(job).success);
  assert.equal(retryStage(job), null);
  assert.equal(jobIsActive(job), true);
  assert.match(jobMessage(job), /experiment is running/);
  job.experiment.status = "interrupted";
  assert.equal(retryStage(job), null);
  assert.equal(jobIsActive(job), false);
  assert.match(jobMessage(job), /Release its reservation explicitly/);
});
