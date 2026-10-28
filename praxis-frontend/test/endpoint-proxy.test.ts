import assert from "node:assert/strict";
import { test } from "node:test";
import { createVisionProxy } from "../lib/server/vision-proxy";

const result = {
  analysisId: "analysis-1",
  imageId: "image-1",
  wireCandidateId: "jumper_wire_1",
  model: "muse",
  endpoints: [
    {
      role: "A",
      proposedImagePosition: [50, 60],
      evidence: "visible_insertion",
    },
    { role: "B", proposedImagePosition: null, evidence: "occluded" },
  ],
};
const request = () =>
  new Request("http://localhost:3001/api/vision/endpoints", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=test",
      origin: "http://localhost:3001",
    },
    body: "image-and-context",
  });
test("endpoint proxy forwards only to the fixed endpoint using server authentication", async () => {
  const proxy = createVisionProxy({
    operation: "endpoints",
    logger: () => {},
    environment: { PRAXIS_API_TOKEN: "server-secret" },
    fetcher: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:3000/api/vision/endpoints");
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        "Bearer server-secret",
      );
      assert.equal(new Headers(options?.headers).get("origin"), null);
      assert.equal(
        new TextDecoder().decode(options?.body as Uint8Array),
        "image-and-context",
      );
      return Response.json(result);
    },
  });
  const response = await proxy(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), result);
});
test("endpoint proxy rejects authoritative invented holes, invalid role order and unexpected backend data", async () => {
  for (const body of [
    {
      ...result,
      endpoints: [
        { ...result.endpoints[0], holeId: "e14" },
        result.endpoints[1],
      ],
    },
    { ...result, endpoints: [result.endpoints[1], result.endpoints[0]] },
    { image: { width: 100, height: 80 }, objects: [] },
  ]) {
    const proxy = createVisionProxy({
      operation: "endpoints",
      logger: () => {},
      fetcher: async () => Response.json(body),
    });
    const response = await proxy(request());
    assert.equal(response.status, 502);
    assert.doesNotMatch(JSON.stringify(await response.json()), /e14/);
  }
});
