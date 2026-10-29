import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import baseline from "../test/fixtures/exact-hole-v1/baseline.json";
import { replayEvaluation, type EvaluationWire } from "../lib/wires/evaluation";
import type { Calibration } from "../lib/breadboard/calibration";

const wires: EvaluationWire[] = baseline.expected.map((row) => ({
  id: row.wireCandidateId,
  boardId: "board_1",
  holes: row.truth as [string, string],
  proposals: baseline.evidence.proposals
    .find((proposal) => proposal.wireCandidateId === row.wireCandidateId)!
    .endpoints.map((endpoint) => ({
      x: endpoint.proposedImagePosition[0],
      y: endpoint.proposedImagePosition[1],
    })) as EvaluationWire["proposals"],
}));
const photo = readFileSync(
  resolve(
    import.meta.dirname,
    "../test/fixtures/exact-hole-v1/",
    baseline.inputs.photograph,
  ),
);
if (
  createHash("sha256").update(photo).digest("hex") !==
  baseline.inputs.photographSha256
)
  throw new Error("Frozen photograph bytes changed.");
const replay = replayEvaluation(wires, [
  { calibration: baseline.inputs.calibration as Calibration, rails: [] },
]);
for (const [key, value] of Object.entries(baseline.expectedMetrics))
  if (replay[key as keyof typeof replay] !== value)
    throw new Error(`Frozen baseline mismatch: ${key}`);
console.log(
  JSON.stringify(
    {
      baseline: baseline.id,
      policy: baseline.policy,
      ...replay,
      refinementEvaluation:
        "Unavailable until the original SAM masks are archived; never inferred from truth.",
    },
    null,
    2,
  ),
);
