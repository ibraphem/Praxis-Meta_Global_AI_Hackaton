import { replayEvaluation, type EvaluationWire } from "./evaluation";
import { endpointResolutionDiagnostics } from "./proposals";
import type { CalibratedBoard } from "./assignments";
import type { RefinementResult } from "./refinement";
import { allHoles, project, type Point } from "../breadboard/calibration";

export interface RefinementEvaluationOptions {
  allEndpoints?: boolean;
}
type Outcome = "correct" | "wrong" | "unresolved";
export const LOCALIZATION_ERROR_EPSILON_PX = 1e-6;
const errorPx = (position: Point | null, reference: Point) =>
  position
    ? Math.hypot(position.x - reference.x, position.y - reference.y)
    : null;
function errorStatistics(values: (number | null)[]) {
  const errors = values
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b),
    count = errors.length;
  return {
    count,
    meanPx: count ? errors.reduce((a, b) => a + b, 0) / count : null,
    rmsPx: count
      ? Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / count)
      : null,
    medianPx: count
      ? count % 2
        ? errors[Math.floor(count / 2)]
        : (errors[count / 2 - 1] + errors[count / 2]) / 2
      : null,
    p95Px: count ? errors[Math.ceil(count * 0.95) - 1] : null,
    maxPx: count ? errors[count - 1] : null,
  };
}

/** A/B may reverse, but choose the correspondence ONCE from raw observations, before refinement. */
export function alignTruth(
  wire: EvaluationWire,
  resolved: [string | null, string | null],
  boards: CalibratedBoard[],
) {
  const board = boards.find(
    (board) => board.calibration.breadboardId === wire.boardId,
  )!;
  const reference =
    wire.groundTruthPositions ??
    (wire.holes.map((id) => {
      const hole = allHoles(board.calibration, board.rails).find(
        (hole) => hole.id === id,
      );
      if (!hole) throw new Error(`Unknown truth hole: ${wire.boardId}:${id}`);
      return project(board.calibration, hole.grid);
    }) as [Point, Point]);
  const score = (order: [number, number]) => ({
    exact: order.reduce(
      (sum, j, i) =>
        sum + Number(resolved[i] === `${wire.boardId}:${wire.holes[j]}`),
      0,
    ),
    distance: order.reduce(
      (sum, j, i) => sum + (errorPx(wire.proposals[i], reference[j]) ?? 0),
      0,
    ),
  });
  const forward = score([0, 1]),
    reverse = score([1, 0]);
  const reversed =
    reverse.exact > forward.exact ||
    (reverse.exact === forward.exact && reverse.distance < forward.distance);
  const order = reversed ? [1, 0] : [0, 1];
  return {
    wire: {
      ...wire,
      holes: order.map((i) => wire.holes[i]) as [string, string],
    },
    reference: order.map((i) => ({ ...reference[i] })) as [Point, Point],
    reversed,
    basis: wire.groundTruthPositions
      ? ("independently_marked_centers" as const)
      : ("calibration_projected_centers" as const),
  };
}

/** Ground truth is used only by scoring/alignment, never passed to refinement. Inputs are not mutated. */
export async function compareRefinement(
  wires: EvaluationWire[],
  boards: CalibratedBoard[],
  refine: (
    wireId: string,
    index: 0 | 1,
    original: Point,
  ) => Promise<RefinementResult | null>,
  options: RefinementEvaluationOptions = {},
) {
  const initial = replayEvaluation(wires, boards);
  const aligned = wires.map((wire, i) =>
    alignTruth(wire, initial.results[i].resolved, boards),
  );
  const raw = replayEvaluation(
    aligned.map((row) => row.wire),
    boards,
    { orderedRoles: true },
  );
  const experiments: {
    wireId: string;
    index: number;
    result: RefinementResult | null;
  }[] = [];
  const skipped: {
    wireId: string;
    index: number;
    reason: "no_original_visible_insertion" | "already_strictly_resolved";
  }[] = [];
  const refinedWires: EvaluationWire[] = [];
  for (const { wire } of aligned) {
    const proposals: EvaluationWire["proposals"] = wire.proposals.map(
      (point) => (point ? { ...point } : null),
    ) as EvaluationWire["proposals"];
    for (const index of [0, 1] as const) {
      const original = wire.proposals[index];
      if (!original) {
        skipped.push({
          wireId: wire.id,
          index,
          reason: "no_original_visible_insertion",
        });
        continue;
      }
      if (
        !options.allEndpoints &&
        endpointResolutionDiagnostics(
          [original.x, original.y],
          "visible_insertion",
          boards,
        ).decision === "accepted"
      ) {
        skipped.push({
          wireId: wire.id,
          index,
          reason: "already_strictly_resolved",
        });
        continue;
      }
      const result = await refine(wire.id, index, { ...original });
      experiments.push({ wireId: wire.id, index, result });
      if (result?.status === "supported_tip" && result.refinedPosition)
        proposals[index] = { ...result.refinedPosition };
      // In the controlled all-endpoint experiment, rejection must reveal lost correct points.
      else if (options.allEndpoints) proposals[index] = null;
    }
    refinedWires.push({ ...wire, proposals });
  }
  const refined = replayEvaluation(refinedWires, boards, {
    orderedRoles: true,
  });
  const endpoints = aligned.flatMap((row, wireIndex) =>
    ([0, 1] as const).map((index) => {
      const truth = `${row.wire.boardId}:${row.wire.holes[index]}`;
      const assess = (position: Point | null, resolved: string | null) => ({
        position,
        resolved,
        outcome: (resolved === null
          ? "unresolved"
          : resolved === truth
            ? "correct"
            : "wrong") as Outcome,
        errorPx: errorPx(position, row.reference[index]),
      });
      const original = assess(
        row.wire.proposals[index],
        raw.results[wireIndex].resolved[index],
      );
      const after = assess(
        refinedWires[wireIndex].proposals[index],
        refined.results[wireIndex].resolved[index],
      );
      return {
        wireId: row.wire.id,
        role: index === 0 ? ("A" as const) : ("B" as const),
        truth,
        truthPosition: row.reference[index],
        referenceBasis: row.basis,
        truthOrderReversed: row.reversed,
        raw: original,
        refined: after,
        transition: `${original.outcome}_to_${after.outcome}`,
      };
    }),
  );
  const count = (from: Outcome, to: Outcome) =>
    endpoints.filter(
      (endpoint) =>
        endpoint.raw.outcome === from && endpoint.refined.outcome === to,
    ).length;
  const transitions = {
    correctToWrong: count("correct", "wrong"),
    correctToUnresolved: count("correct", "unresolved"),
    unresolvedToCorrect: count("unresolved", "correct"),
    unresolvedToWrong: count("unresolved", "wrong"),
    wrongToCorrect: count("wrong", "correct"),
    wrongToUnresolved: count("wrong", "unresolved"),
    correctToCorrect: count("correct", "correct"),
  };
  const rawErrors = errorStatistics(
      endpoints.map((endpoint) => endpoint.raw.errorPx),
    ),
    refinedErrors = errorStatistics(
      endpoints.map((endpoint) => endpoint.refined.errorPx),
    );
  const paired = endpoints.filter(
    (endpoint) =>
      endpoint.raw.errorPx !== null && endpoint.refined.errorPx !== null,
  );
  const rawPaired = errorStatistics(
      paired.map((endpoint) => endpoint.raw.errorPx),
    ),
    refinedPaired = errorStatistics(
      paired.map((endpoint) => endpoint.refined.errorPx),
    );
  const meanImprovementPx = paired.length
    ? rawPaired.meanPx! - refinedPaired.meanPx!
    : null;
  const localizationError = {
    raw: rawErrors,
    refined: refinedErrors,
    referenceCounts: {
      independentlyMarked: endpoints.filter(
        (endpoint) =>
          endpoint.referenceBasis === "independently_marked_centers",
      ).length,
      calibrationProjected: endpoints.filter(
        (endpoint) =>
          endpoint.referenceBasis === "calibration_projected_centers",
      ).length,
    },
    paired: {
      count: paired.length,
      rawMeanPx: rawPaired.meanPx,
      refinedMeanPx: refinedPaired.meanPx,
      meanImprovementPx,
      improved: paired.filter(
        (endpoint) =>
          endpoint.raw.errorPx! - endpoint.refined.errorPx! >
          LOCALIZATION_ERROR_EPSILON_PX,
      ).length,
      worsened: paired.filter(
        (endpoint) =>
          endpoint.refined.errorPx! - endpoint.raw.errorPx! >
          LOCALIZATION_ERROR_EPSILON_PX,
      ).length,
      unchanged: paired.filter(
        (endpoint) =>
          Math.abs(endpoint.refined.errorPx! - endpoint.raw.errorPx!) <=
          LOCALIZATION_ERROR_EPSILON_PX,
      ).length,
    },
  };
  const allEndpointsTested =
    !!options.allEndpoints &&
    experiments.length ===
      wires.reduce(
        (sum, wire) => sum + wire.proposals.filter(Boolean).length,
        0,
      );
  const zeroWrongHoleAssignments = refined.wrong === 0;
  const noCorrectEndpointRegressions =
    transitions.correctToWrong === 0 && transitions.correctToUnresolved === 0;
  const resolvedEndpointImprovement = refined.correct > raw.correct;
  // Dropping hard/failed points must not manufacture lower mean error by changing the population.
  const completePairedErrorCoverage =
    paired.length > 0 && paired.length === rawErrors.count;
  const localizationImprovement =
    completePairedErrorCoverage &&
    meanImprovementPx !== null &&
    meanImprovementPx > LOCALIZATION_ERROR_EPSILON_PX;
  const passed =
    allEndpointsTested &&
    zeroWrongHoleAssignments &&
    noCorrectEndpointRegressions &&
    (resolvedEndpointImprovement || localizationImprovement);
  return {
    mode: options.allEndpoints
      ? ("all_endpoints" as const)
      : ("unresolved_only" as const),
    raw,
    refined,
    experiments,
    skipped,
    endpoints,
    transitions,
    localizationError,
    acceptance: {
      allEndpointsTested,
      zeroWrongHoleAssignments,
      noCorrectEndpointRegressions,
      resolvedEndpointImprovement,
      completePairedErrorCoverage,
      localizationImprovement,
      localizationErrorEpsilonPx: LOCALIZATION_ERROR_EPSILON_PX,
      passed,
      recommendation: passed
        ? "eligible_for_held_out_validation_not_global_enablement"
        : "keep_opt_in",
    },
    adoption: "experimental_only_not_evidence_of_electrical_contact",
  };
}
