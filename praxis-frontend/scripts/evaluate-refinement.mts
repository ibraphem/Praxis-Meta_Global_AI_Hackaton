import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { z } from "zod";
import { analysisSchema, type Component } from "../lib/vision";
import {
  calibrateBoard,
  allHoles,
  HOLE_RESOLVER_POLICY,
  type Rail,
} from "../lib/breadboard/calibration";
import { boardPitchPx } from "../lib/wires/proposals";
import type { CalibratedBoard } from "../lib/wires/assignments";
import { compareRefinement } from "../lib/wires/refinement-evaluation";
import { refineWireTip, REFINEMENT_POLICY } from "../lib/wires/refinement";
import { type EvaluationWire } from "../lib/wires/evaluation";
import { refinementTerminalSummary } from "../lib/wires/refinement-report";

// Reuse the project's installed image decoder; no inference/network dependency.
const sharp = createRequire(
  new URL("../../praxis-backend/server/package.json", import.meta.url),
)(
  "sharp",
) as typeof import("../../praxis-backend/server/node_modules/sharp").default;
const args = process.argv.slice(2);
const positional: string[] = [];
let allEndpoints = false,
  outputPath: string | undefined;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--all-endpoints" && !allEndpoints) allEndpoints = true;
  else if (
    arg === "--output" &&
    !outputPath &&
    args[i + 1] &&
    !args[i + 1].startsWith("--")
  )
    outputPath = args[++i];
  else if (arg.startsWith("--"))
    throw new Error(`Unknown, duplicate or incomplete option: ${arg}`);
  else positional.push(arg);
}
if (positional.length !== 3)
  throw new Error(
    "Usage: npm run benchmark:refine -- bundle.json truth.json original-photo.png [--all-endpoints] [--output new-report.json]. Original SAM masks are required; the frozen baseline report alone is insufficient.",
  );
const [bundlePath, truthPath, imagePath] = positional;
if (
  outputPath &&
  positional.some((path) => resolve(path) === resolve(outputPath!))
)
  throw new Error("The report path must not replace an input file.");
const truthBytes = readFileSync(truthPath),
  bundleBytes = readFileSync(bundlePath);
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const truth = z
  .object({
    imageSha256: z.string().length(64),
    analysisRunId: z.string(),
    recordedBeforeInference: z.literal(true),
    wires: z
      .array(
        z.object({
          id: z.string(),
          boardId: z.string(),
          holes: z.tuple([z.string(), z.string()]),
          positions: z.tuple([point, point]).optional(),
        }),
      )
      .min(1),
  })
  .parse(JSON.parse(truthBytes.toString("utf8")));
const bundle = JSON.parse(bundleBytes.toString("utf8"));
if (
  bundle.schemaVersion !== "praxis-evaluation-v1" ||
  bundle.analysisRunId !== truth.analysisRunId
)
  throw new Error(
    "Evaluation bundle and blinded truth refer to different analyses.",
  );
const bytes = readFileSync(imagePath),
  sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
if (
  sha(bytes) !== truth.imageSha256 ||
  bundle.image.sha256 !== truth.imageSha256
)
  throw new Error("Photograph hash does not match the recorded inputs.");
const analysis = analysisSchema.parse(bundle.analysis);
const boardSchema = z.object({
  revision: z.number().int().positive(),
  calibration: z.object({
    breadboardId: z.string(),
    rows: z.union([z.literal(30), z.literal(63)]),
    image: z.object({ width: z.number(), height: z.number() }),
    anchors: z.tuple([point, point, point, point]),
  }),
  rails: z.array(z.unknown()),
});
const boards: CalibratedBoard[] = z
  .array(boardSchema)
  .parse(bundle.boards)
  .map((board) => ({
    revision: board.revision,
    calibration: calibrateBoard(
      board.calibration.breadboardId,
      board.calibration.rows,
      board.calibration.image,
      board.calibration.anchors,
    ),
    rails: board.rails as Rail[],
  }));
if (!boards.length) throw new Error("No calibration snapshot was archived.");
if (
  new Set(boards.map((board) => board.calibration.breadboardId)).size !==
    boards.length ||
  new Set(truth.wires.map((wire) => wire.id)).size !== truth.wires.length
)
  throw new Error(
    "Duplicate boards or truth wires would distort the denominator.",
  );
if (
  boards.some(
    (board) =>
      board.calibration.image.width !== analysis.image.width ||
      board.calibration.image.height !== analysis.image.height,
  )
)
  throw new Error("Calibration and photograph dimensions differ.");
if (
  bundle.resolverPolicy &&
  JSON.stringify(bundle.resolverPolicy) !== JSON.stringify(HOLE_RESOLVER_POLICY)
)
  throw new Error(
    "The archived resolver policy differs; replay it separately instead of silently changing thresholds.",
  );
for (const wire of truth.wires) {
  const board = boards.find(
    (board) => board.calibration.breadboardId === wire.boardId,
  );
  if (
    !board ||
    wire.holes[0] === wire.holes[1] ||
    !wire.holes.every((id) =>
      allHoles(board.calibration, board.rails).some((hole) => hole.id === id),
    )
  )
    throw new Error(
      "Truth must identify two distinct existing physical holes on a known board.",
    );
  if (
    wire.positions?.some(
      (position) =>
        position.x < 0 ||
        position.y < 0 ||
        position.x >= analysis.image.width ||
        position.y >= analysis.image.height,
    )
  )
    throw new Error(
      "Independently marked centers must use original-image pixels inside the photograph.",
    );
}
const pixels = await sharp(bytes)
  .rotate()
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
if (
  pixels.info.width !== analysis.image.width ||
  pixels.info.height !== analysis.image.height
)
  throw new Error("Image dimensions do not match analysis.");
const reviews = z
  .array(
    z.object({
      proposal: z.object({
        analysisId: z.string(),
        imageId: z.string(),
        wireCandidateId: z.string(),
        calibrationRevisions: z.record(z.string(), z.number()),
        endpoints: z.tuple([
          z.object({
            proposedImagePosition: z.tuple([z.number(), z.number()]).nullable(),
            evidence: z.string(),
          }),
          z.object({
            proposedImagePosition: z.tuple([z.number(), z.number()]).nullable(),
            evidence: z.string(),
          }),
        ]),
      }),
    }),
  )
  .parse(bundle.reviews);
const wireMap = new Map<string, Component>();
const wires: EvaluationWire[] = truth.wires.map((truthWire) => {
  const component = analysis.objects.find(
    (object) =>
      object.id === truthWire.id &&
      object.type === "jumper_wire" &&
      object.mask,
  );
  if (!component)
    throw new Error(
      `Original SAM mask missing for ${truthWire.id}; do not rerun SAM or substitute a mask for frozen evaluation.`,
    );
  wireMap.set(truthWire.id, component);
  const review = [...reviews]
    .reverse()
    .find(
      (review) =>
        review.proposal.wireCandidateId === truthWire.id &&
        review.proposal.analysisId === truth.analysisRunId &&
        review.proposal.imageId === bundle.image.id,
    );
  if (!review)
    throw new Error(`Original proposal snapshot missing for ${truthWire.id}.`);
  if (
    boards.some(
      (board) =>
        review.proposal.calibrationRevisions[board.calibration.breadboardId] !==
        board.revision,
    ) ||
    Object.keys(review.proposal.calibrationRevisions).length !== boards.length
  )
    throw new Error("Calibration revision differs from the proposal snapshot.");
  const proposals = review.proposal.endpoints.map((endpoint) =>
    endpoint.evidence === "visible_insertion" && endpoint.proposedImagePosition
      ? {
          x: endpoint.proposedImagePosition[0],
          y: endpoint.proposedImagePosition[1],
        }
      : null,
  ) as EvaluationWire["proposals"];
  if (
    proposals.some(
      (position) =>
        position &&
        (position.x < 0 ||
          position.y < 0 ||
          position.x >= analysis.image.width ||
          position.y >= analysis.image.height),
    )
  )
    throw new Error("Original Muse coordinates are outside the photograph.");
  return {
    ...truthWire,
    proposals,
    groundTruthPositions: truthWire.positions,
  };
});
const comparison = await compareRefinement(
  wires,
  boards,
  async (wireId, _index, seed) => {
    const wire = wireMap.get(wireId)!,
      r = Math.max(
        16,
        Math.min(64, Math.max(...boards.map(boardPitchPx)) * 1.5),
      );
    const left = Math.max(0, Math.floor(seed.x - r)),
      top = Math.max(0, Math.floor(seed.y - r)),
      width = Math.min(
        pixels.info.width - left,
        Math.ceil(seed.x + r + 1) - left,
      ),
      height = Math.min(
        pixels.info.height - top,
        Math.ceil(seed.y + r + 1) - top,
      );
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++)
      rgba.set(
        pixels.data.subarray(
          ((y + top) * pixels.info.width + left) * 4,
          ((y + top) * pixels.info.width + left + width) * 4,
        ),
        y * width * 4,
      );
    const [x, y, w, h] = wire.bbox,
      mask = wire.mask!;
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g transform="translate(${x - left} ${y - top}) scale(${w / mask.width} ${h / mask.height})"><path d="${mask.path}" fill="white" fill-rule="evenodd"/></g></svg>`,
    );
    const selectedMask = new Uint8ClampedArray(
      await sharp(svg).ensureAlpha().raw().toBuffer(),
    );
    return refineWireTip({
      width,
      height,
      rgba,
      selectedMask,
      origin: { x: left, y: top },
      seed,
      searchRadius: r,
    });
  },
  { allEndpoints },
);
const report = {
  reportVersion: "praxis-refinement-comparison-v2",
  runtime: { node: process.version, sharp: sharp.versions.sharp },
  implementationHashes: {
    refinement: sha(
      readFileSync(new URL("../lib/wires/refinement.ts", import.meta.url)),
    ),
    resolver: sha(
      readFileSync(
        new URL("../lib/breadboard/calibration.ts", import.meta.url),
      ),
    ),
    evaluator: sha(
      readFileSync(
        new URL("../lib/wires/refinement-evaluation.ts", import.meta.url),
      ),
    ),
  },
  inputHashes: {
    photo: sha(bytes),
    bundle: sha(bundleBytes),
    truth: sha(truthBytes),
  },
  analysisRunId: truth.analysisRunId,
  policy: REFINEMENT_POLICY,
  resolverPolicy: HOLE_RESOLVER_POLICY,
  archivedResolverPolicy:
    bundle.resolverPolicy ?? "not_archived_current_policy_assumed",
  ...comparison,
};
const json = JSON.stringify(report, null, 2) + "\n";
const summary = refinementTerminalSummary(comparison);
if (outputPath) {
  // Exclusive creation also rejects existing files, hardlinks and symlinks to input files.
  writeFileSync(outputPath, json, { flag: "wx" });
  console.log(summary + `\nJSON report: ${resolve(outputPath)}`);
} else {
  console.log(json);
  console.error(summary);
}
