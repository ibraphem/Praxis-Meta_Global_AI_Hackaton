import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { scoreGrounding } from "../lib/wires/grounding-evaluation";
const usage =
  "Usage: npm run benchmark:grounding -- BUNDLE.json TRUTH.json EXPERIMENT_REPORT.json NEW_SCORE.json\nOffline only. Original predictions remain unchanged; refuses to overwrite output.";
try {
  const args = process.argv.slice(2);
  if (args.includes("--help")) console.log(usage);
  else {
    if (args.length !== 4) throw new Error(usage);
    const bytes = args.slice(0, 3).map((p) => readFileSync(p)),
      [bundle, truth, experiment] = bytes.map((b) =>
        JSON.parse(b.toString("utf8")),
      ),
      sha = (b: Buffer | string) =>
        createHash("sha256").update(b).digest("hex");
    if (
      experiment.bundleHash !== sha(bytes[0]) ||
      experiment.calibrationHash !== sha(JSON.stringify(bundle.boards))
    )
      throw new Error(
        "Frozen bundle or calibration hash differs from the experiment.",
      );
    const report = scoreGrounding(bundle, truth, experiment);
    writeFileSync(
      args[3],
      JSON.stringify({ ...report, inputHashes: bytes.map(sha) }, null, 2) +
        "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.table(
      report.experiments.map((e) => ({
        variant: e.variant,
        run: e.run,
        correct: e.correct,
        wrong: e.wrong,
        unresolved: e.unresolved,
        completeWires: e.completeWires,
        correctToWrong: e.transitions.correctToWrong,
        correctToUnresolved: e.transitions.correctToUnresolved,
        wallSeconds: e.batch ? e.batch.wallMs / 1000 : null,
        nextTargetsMet: e.nextTargetsMet,
      })),
    );
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Grounding comparison failed.",
  );
  process.exitCode = 1;
}
