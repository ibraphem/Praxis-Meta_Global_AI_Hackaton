import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { calibrateBoard } from "../lib/breadboard/calibration";
const sharp = createRequire(
  new URL("../../praxis-backend/server/package.json", import.meta.url),
)(
  "sharp",
) as typeof import("../../praxis-backend/server/node_modules/sharp").default;

test("offline refinement runner reads archived masks, keeps original evidence frozen, and reports both scores", async () => {
  const directory = mkdtempSync(join(tmpdir(), "praxis-offline-"));
  try {
    const width = 200,
      height = 160,
      rgba = Buffer.alloc(width * height * 4, 255);
    for (let y = 62; y <= 66; y++)
      for (let x = 30; x <= 60; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = 180;
        rgba[i + 1] = 30;
        rgba[i + 2] = 20;
      }
    const image = await sharp(rgba, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
    const hash = createHash("sha256").update(image).digest("hex");
    const calibration = calibrateBoard("board_1", 30, { width, height }, [
      { x: 20, y: 20 },
      { x: 130, y: 20 },
      { x: 130, y: 136 },
      { x: 20, y: 136 },
    ]);
    const analysis = {
      image: { width, height },
      provenance: {
        mode: "combined",
        reasoningModel: "fixture",
        segmentationModel: "fixture",
      },
      objects: [
        {
          id: "jumper_wire_1",
          type: "jumper_wire",
          bbox: [30, 62, 31, 5],
          geometryStatus: "segmented",
          localizationSource: "sam",
          interpretation: "uncertain",
          guidanceEligible: false,
          identityStatus: "unverified",
          mask: {
            format: "svg_path",
            width: 31,
            height: 5,
            path: "M0 0L31 0L31 5L0 5Z",
          },
        },
      ],
    };
    const bundle = {
      schemaVersion: "praxis-evaluation-v1",
      image: { id: "photo", sha256: hash },
      analysisRunId: "run",
      analysis,
      boards: [{ calibration, revision: 1, rails: [] }],
      reviews: [
        {
          proposal: {
            analysisId: "run",
            imageId: "photo",
            wireCandidateId: "jumper_wire_1",
            calibrationRevisions: { board_1: 1 },
            endpoints: [
              {
                proposedImagePosition: [25, 64],
                evidence: "visible_insertion",
              },
              {
                proposedImagePosition: [60, 64],
                evidence: "visible_insertion",
              },
            ],
          },
        },
      ],
    };
    // Fixed synthetic truth, declared independently of the refinement output.
    const truth = {
      imageSha256: hash,
      analysisRunId: "run",
      recordedBeforeInference: true,
      wires: [
        {
          id: "jumper_wire_1",
          boardId: "board_1",
          holes: ["b12", "e12"],
          positions: [
            { x: 30, y: 64 },
            { x: 60, y: 64 },
          ],
        },
      ],
    };
    const bundlePath = join(directory, "bundle.json"),
      truthPath = join(directory, "truth.json"),
      imagePath = join(directory, "photo.png");
    writeFileSync(bundlePath, JSON.stringify(bundle));
    writeFileSync(truthPath, JSON.stringify(truth));
    writeFileSync(imagePath, image);
    const before = readFileSync(bundlePath, "utf8"),
      truthBefore = readFileSync(truthPath, "utf8"),
      imageBefore = readFileSync(imagePath);
    const run = (extra: string[] = []) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/evaluate-refinement.mts"),
          bundlePath,
          truthPath,
          imagePath,
          ...extra,
        ],
        { encoding: "utf8" },
      );
    const execution = run();
    assert.equal(execution.status, 0, execution.stderr);
    const result = JSON.parse(execution.stdout);
    assert.equal(result.raw.correct, 1);
    assert.equal(result.refined.correct, 2);
    assert.equal(result.refined.wrong, 0);
    assert.equal(result.raw.completeWires, 0);
    assert.equal(result.refined.completeWires, 1);
    assert.equal(result.mode, "unresolved_only");
    assert.match(execution.stderr, /Correct -> wrong/);
    assert.equal(result.experiments.length, 1);
    const all = run(["--all-endpoints"]);
    assert.equal(all.status, 0, all.stderr);
    const report = JSON.parse(all.stdout);
    assert.equal(report.mode, "all_endpoints");
    assert.equal(report.experiments.length, 2);
    assert.equal(report.skipped.length, 0);
    assert.equal(report.transitions.unresolvedToCorrect, 1);
    assert.equal(report.transitions.correctToWrong, 0);
    assert.equal(report.transitions.correctToUnresolved, 0);
    assert.equal(report.acceptance.passed, true);
    assert.equal(
      report.localizationError.referenceCounts.independentlyMarked,
      2,
    );
    assert.match(all.stderr, /Complete wires/);
    const reportPath = join(directory, "report.json");
    const saved = run(["--all-endpoints", "--output", reportPath]);
    assert.equal(saved.status, 0, saved.stderr);
    assert.match(saved.stdout, /Refinement experiment: all_endpoints/);
    assert.match(saved.stdout, /JSON report:/);
    assert.equal(
      JSON.parse(readFileSync(reportPath, "utf8")).experiments.length,
      2,
    );
    const savedBefore = readFileSync(reportPath, "utf8");
    assert.notEqual(run(["--all-endpoints", "--output", bundlePath]).status, 0);
    assert.notEqual(run(["--all-endpoints", "--output", truthPath]).status, 0);
    assert.notEqual(run(["--all-endpoints", "--output", imagePath]).status, 0);
    assert.notEqual(run(["--all-endpoints", "--output", reportPath]).status, 0);
    assert.notEqual(run(["--unknown-option"]).status, 0);
    const missing = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("scripts/evaluate-refinement.mts"),
        join(directory, "missing-bundle.json"),
        join(directory, "missing-truth.json"),
        join(directory, "missing-photo.png"),
        "--all-endpoints",
      ],
      { encoding: "utf8" },
    );
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /evaluation bundle: .*missing-bundle.json/);
    assert.match(
      missing.stderr,
      /pre-recorded ground truth: .*missing-truth.json/,
    );
    assert.match(missing.stderr, /original photograph: .*missing-photo.png/);
    assert.match(missing.stderr, /Relative paths are resolved from:/);
    assert.match(missing.stderr, /example filenames, not generated files/);
    assert.doesNotMatch(
      missing.stderr,
      /at Object.openSync|at ModuleJob|node:fs:/,
    );
    assert.equal(missing.stdout, "");
    assert.equal(readFileSync(reportPath, "utf8"), savedBefore);
    assert.equal(readFileSync(bundlePath, "utf8"), before);
    assert.equal(readFileSync(truthPath, "utf8"), truthBefore);
    assert.deepEqual(readFileSync(imagePath), imageBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
