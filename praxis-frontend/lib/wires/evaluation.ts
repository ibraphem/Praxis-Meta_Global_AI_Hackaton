import {
  diagnoseHole,
  type Calibration,
  type Rail,
  type Point,
} from "../breadboard/calibration";

export interface EvaluationWire {
  id: string;
  boardId: string;
  holes: [string, string];
  proposals: [Point | null, Point | null];
}
/** Match A/B in either order; an unmatched endpoint never makes a complete wire. */
export function scoreHolePairs(
  truth: [string, string],
  resolved: [string | null, string | null],
) {
  const match = (order: [string, string]) =>
    resolved.reduce(
      (sum, hole, index) =>
        sum + Number(hole !== null && hole === order[index]),
      0,
    );
  const correct = Math.max(match(truth), match([truth[1], truth[0]]));
  const accepted = resolved.filter((hole) => hole !== null).length;
  return {
    correct,
    accepted,
    wrong: accepted - correct,
    unresolved: 2 - accepted,
    complete: correct === 2,
  };
}
export function replayEvaluation(
  wires: EvaluationWire[],
  boards: { calibration: Calibration; rails: Rail[] }[],
) {
  const results = wires.map((wire) => {
    if (
      !boards.some((board) => board.calibration.breadboardId === wire.boardId)
    )
      throw new Error("Evaluation board is missing.");
    const endpoints = wire.proposals.map((point) =>
      point
        ? boards.map((board) => ({
            boardId: board.calibration.breadboardId,
            diagnosis: diagnoseHole(board.calibration, board.rails, point),
          }))
        : [],
    );
    const resolved = endpoints.map((endpoint) => {
      const matches = endpoint.filter(
        (board) => board.diagnosis.reason === "accepted",
      );
      return matches.length === 1
        ? `${matches[0].boardId}:${matches[0].diagnosis.candidates[0].holeId}`
        : null;
    }) as [string | null, string | null];
    return {
      id: wire.id,
      boardId: wire.boardId,
      endpoints,
      resolved,
      ...scoreHolePairs(
        wire.holes.map((hole) => `${wire.boardId}:${hole}`) as [string, string],
        resolved,
      ),
    };
  });
  const totals = results.reduce(
    (sum, row) => ({
      correct: sum.correct + row.correct,
      accepted: sum.accepted + row.accepted,
      wrong: sum.wrong + row.wrong,
      unresolved: sum.unresolved + row.unresolved,
      completeWires: sum.completeWires + Number(row.complete),
    }),
    { correct: 0, accepted: 0, wrong: 0, unresolved: 0, completeWires: 0 },
  );
  return {
    ...totals,
    endpoints: wires.length * 2,
    wires: wires.length,
    endpointYield: wires.length ? totals.correct / (wires.length * 2) : null,
    resolvedPrecision: totals.accepted
      ? totals.correct / totals.accepted
      : null,
    completeWireYield: wires.length
      ? totals.completeWires / wires.length
      : null,
    results,
  };
}
