import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { sceneJob } from "./fixtures/scene";
import { sceneEvaluationJob } from "./fixtures/scene-evaluation";
import { buildSceneEvaluationEvidence } from "../lib/scene-evaluation-bundle";
import type { EndpointRequestTiming } from "../lib/wires/request-timing";

const endpointRequests: EndpointRequestTiming[] = [
  {
    id: randomUUID(),
    wireCandidateId: "jumper_wire_1",
    analysisId: randomUUID(),
    imageId: "photo",
    startedAtMs: 3.5,
    elapsedMs: null,
    status: "discarded",
  },
];

test("bundle preserves the entire scene, every attempt, masks, decisions, reference points and attachment uncertainty", () => {
  const job = sceneEvaluationJob(),
    before = JSON.stringify(job);
  const evidence = buildSceneEvaluationEvidence({
    job,
    imageHash: job.imageHash,
    image: job.image,
    analysis: job.result!,
    analysisRunId: job.revision,
    endpointRequests,
    capturedAt: 1234,
  });
  assert.equal(evidence.schemaVersion, "praxis-scene-evaluation-v1");
  assert.deepEqual(evidence.graph, job.scene!.graph);
  assert.deepEqual(evidence.inventory.attempts, [job.scene!.attempts[0]]);
  assert.deepEqual(
    evidence.segmentation.publishedCandidates,
    job.result!.objects,
  );
  assert.deepEqual(
    evidence.segmentation.observations,
    job.scene!.graph!.observations.filter((o) => o.source === "sam"),
  );
  assert.ok(evidence.segmentation.observations![0]!.mask!.path);
  assert.deepEqual(
    evidence.reconciliation.decisions,
    job.scene!.graph!.identityReviews,
  );
  assert.equal(
    evidence.reconciliation.displayProjection!.derivedAtExport,
    true,
  );
  assert.equal(
    evidence.verificationStatus.objectIdentity!.find(
      (o) => o.memberObjectIds.length === 2,
    )!.status,
    "human_confirmed_same_object",
  );
  assert.equal(
    evidence.verificationStatus.terminals![0]!.verification,
    "unverified",
  );
  assert.equal(evidence.terminalDiscovery.proposals![0]!.location, null);
  assert.deepEqual(
    evidence.terminalDiscovery.proposals![0]!.reference,
    job.scene!.graph!.terminals![0]!.reference,
  );
  assert.equal(evidence.attachmentEvidence![0]!.evidence, "occluded_path");
  assert.equal(
    evidence.verificationStatus.electricalConnectionStatus,
    "unestablished",
  );
  assert.equal(
    evidence.terminalDiscovery.coverage!.find(
      (o) => o.objectId === job.scene!.graph!.objects[0]!.id,
    )!.status,
    "examined_but_unresolved",
  );
  assert.equal(
    evidence.terminalDiscovery.coverage!.at(-1)!.status,
    "not_attempted",
  );
  assert.equal(JSON.stringify(job), before);
  evidence.graph!.objects[0]!.proposedType = "changed export copy";
  assert.equal(JSON.stringify(job), before);
});

test("latency retains stage attribution, failure outcomes and original trace spans without inventing missing durations", () => {
  const job = sceneEvaluationJob();
  job.sam.attempts[0]!.finishedAt = undefined;
  const evidence = buildSceneEvaluationEvidence({
    job,
    imageHash: job.imageHash,
    image: job.image,
    analysis: job.result!,
    analysisRunId: job.revision,
    endpointRequests,
    capturedAt: 1234,
  });
  const stages = evidence.latency.stages;
  assert.equal(
    stages.find((s) => s.stage === "sam")!.attempts[0]!.wallMs,
    null,
  );
  const attempts = stages.find((s) => s.stage === "scene")!.attempts;
  assert.equal(attempts.length, 4);
  assert.equal(attempts[0]!.queueMs, 10);
  assert.equal(attempts[0]!.wallMs, 800);
  assert.deepEqual(
    attempts[0]!.timings,
    job.scene!.attempts[0]!.diagnostics!.timings,
  );
  assert.equal(attempts[2]!.upstreamOutcome, "not_sent");
  assert.equal(attempts[2]!.timings, null);
  assert.equal(attempts[3]!.status, "timed_out");
  assert.equal(attempts[3]!.timings![0]!.stage, "muse.terminals");
  assert.equal(
    evidence.latency.terminalRequests![0]!.upstreamOutcome,
    "unknown",
  );
  assert.equal(evidence.latency.terminalRequests![0]!.wallMs, 800);
  assert.deepEqual(evidence.latency.endpointRequests, endpointRequests);
});

test("legacy and missing scene evidence remain explicit and mismatched photograph bindings refuse export", () => {
  const job = sceneJob();
  delete job.scene;
  const input = {
    job,
    imageHash: job.imageHash,
    image: job.image,
    analysis: job.result!,
    analysisRunId: job.revision,
    endpointRequests: [],
    capturedAt: 1234,
  };
  const legacy = buildSceneEvaluationEvidence(input);
  assert.equal(legacy.availability, "not_run");
  assert.equal(legacy.graph, null);
  assert.equal(legacy.segmentation.observations, null);
  assert.equal(
    buildSceneEvaluationEvidence({ ...input, job: null }).availability,
    "not_recorded",
  );
  assert.throws(
    () => buildSceneEvaluationEvidence({ ...input, imageHash: "2".repeat(64) }),
    /does not match/,
  );
  assert.throws(
    () =>
      buildSceneEvaluationEvidence({
        ...input,
        image: { ...job.image, width: 101 },
      }),
    /does not match/,
  );
});
