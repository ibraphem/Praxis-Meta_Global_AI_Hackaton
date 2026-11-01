import { test } from "node:test";
import assert from "node:assert/strict";
import { automaticV2PreparedJob } from "./fixtures/automatic-targeting";
import { automaticTargetingRecordSchema } from "../lib/connector-workflow";
import { buildSceneEvaluationEvidence } from "../lib/scene-evaluation-bundle";
test("v2 public contracts export the declared comparison and abstention provenance without accepting an incomplete protocol", () => {
  const job = automaticV2PreparedJob(),
    record = job.automaticTargeting![0]!;
  assert.equal(record.arms.length, 3);
  assert.equal(
    automaticTargetingRecordSchema.safeParse({
      ...record,
      targetingDiagnostics: undefined,
    }).success,
    false,
  );
  assert.equal(
    automaticTargetingRecordSchema.safeParse({
      ...record,
      algorithmVersion: undefined,
    }).success,
    false,
  );
  assert.equal(
    automaticTargetingRecordSchema.safeParse({
      ...record,
      evaluationProtocol: {
        ...record.evaluationProtocol,
        requiredComparisons: ["C-body-aware-v2"],
      },
    }).success,
    false,
  );
  const evidence = buildSceneEvaluationEvidence({
    job,
    imageHash: job.imageHash,
    image: job.image,
    analysis: job.result!,
    analysisRunId: job.revision,
    endpointRequests: [],
    capturedAt: 1,
  });
  assert.deepEqual(evidence.automaticTargeting.experiments[0], record);
  assert.equal(evidence.connectorValidation!.gates[0]!.status, "blocked");
});
