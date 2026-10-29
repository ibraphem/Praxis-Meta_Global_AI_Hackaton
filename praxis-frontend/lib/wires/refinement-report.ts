import type { compareRefinement } from "./refinement-evaluation";
export function refinementTerminalSummary(
  report: Awaited<ReturnType<typeof compareRefinement>>,
) {
  const px = (value: number | null) =>
    value === null ? "unavailable" : `${value.toFixed(3)} px`;
  const rows = [
    [
      "Correct endpoints",
      `${report.raw.correct}/${report.raw.endpoints}`,
      `${report.refined.correct}/${report.refined.endpoints}`,
    ],
    [
      "Wrong-hole assignments",
      `${report.raw.wrong}`,
      `${report.refined.wrong}`,
    ],
    [
      "Unresolved endpoints",
      `${report.raw.unresolved}`,
      `${report.refined.unresolved}`,
    ],
    [
      "Complete wires",
      `${report.raw.completeWires}/${report.raw.wires}`,
      `${report.refined.completeWires}/${report.refined.wires}`,
    ],
    ["Correct -> wrong", "—", `${report.transitions.correctToWrong}`],
    ["Correct -> unresolved", "—", `${report.transitions.correctToUnresolved}`],
    ["Unresolved -> correct", "—", `${report.transitions.unresolvedToCorrect}`],
    [
      "Mean error (available points)",
      `${px(report.localizationError.raw.meanPx)} (n=${report.localizationError.raw.count})`,
      `${px(report.localizationError.refined.meanPx)} (n=${report.localizationError.refined.count})`,
    ],
    [
      "Mean error (paired points)",
      `${px(report.localizationError.paired.rawMeanPx)} (n=${report.localizationError.paired.count})`,
      `${px(report.localizationError.paired.refinedMeanPx)} (n=${report.localizationError.paired.count})`,
    ],
  ];
  return [
    `Refinement experiment: ${report.mode} · ${report.experiments.length} attempted · ${report.skipped.length} skipped`,
    "Metric                           | Raw Muse                 | Refined",
    ...rows.map(
      ([name, raw, refined]) =>
        `${name.padEnd(32)} | ${raw.padEnd(24)} | ${refined}`,
    ),
    `Pixel references: ${report.localizationError.referenceCounts.independentlyMarked} independently marked; ${report.localizationError.referenceCounts.calibrationProjected} calibration-projected (not independently measured truth).`,
    `Acceptance: ${report.acceptance.passed ? "PASS for this dataset; held-out validation still required" : "NOT PASSED; keep refinement opt-in"}.`,
    "Original bundle and predictions are unchanged.",
  ].join("\n");
}
