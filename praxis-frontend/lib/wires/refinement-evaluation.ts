import { replayEvaluation, type EvaluationWire } from "./evaluation";
import { endpointResolutionDiagnostics } from "./proposals";
import type { CalibratedBoard } from "./assignments";
import type { RefinementResult } from "./refinement";
import type { Point } from "../breadboard/calibration";

/** Ground truth is used only by the scorer, never passed to the refinement callback. */
export async function compareRefinement(
  wires: EvaluationWire[],
  boards: CalibratedBoard[],
  refine: (
    wireId: string,
    index: 0 | 1,
    original: Point,
  ) => Promise<RefinementResult | null>,
) {
  const raw = replayEvaluation(wires, boards),
    experiments: {
      wireId: string;
      index: number;
      result: RefinementResult | null;
    }[] = [];
  const refinedWires: EvaluationWire[] = [];
  for (const wire of wires) {
    const proposals: EvaluationWire["proposals"] = [...wire.proposals];
    for (const index of [0, 1] as const) {
      const original = wire.proposals[index];
      if (
        !original ||
        endpointResolutionDiagnostics(
          [original.x, original.y],
          "visible_insertion",
          boards,
        ).decision === "accepted"
      )
        continue;
      const result = await refine(wire.id, index, { ...original });
      experiments.push({ wireId: wire.id, index, result });
      if (result?.status === "supported_tip" && result.refinedPosition)
        proposals[index] = { ...result.refinedPosition };
    }
    refinedWires.push({ ...wire, proposals });
  }
  return {
    raw,
    refined: replayEvaluation(refinedWires, boards),
    experiments,
    adoption: "experimental_only_not_evidence_of_electrical_contact",
  };
}
