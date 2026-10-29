import { z } from "zod";
import { analysisSchema } from "../vision";
import {
  calibrateBoard,
  allHoles,
  HOLE_RESOLVER_POLICY,
  type Rail,
} from "../breadboard/calibration";
import { replayEvaluation, type EvaluationWire } from "./evaluation";
import { alignTruth } from "./refinement-evaluation";
import { endpointResponseSchema } from "./proposals";
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
export function scoreGrounding(
  rawBundle: unknown,
  rawTruth: unknown,
  rawReport: unknown,
) {
  const bundle = z
    .object({
      schemaVersion: z.literal("praxis-evaluation-v1"),
      analysisRunId: z.string(),
      image: z.object({ sha256: z.string(), id: z.string() }),
      analysis: analysisSchema,
      resolverPolicy: z.unknown(),
      boards: z.array(
        z.object({
          revision: z.number(),
          calibration: z.object({
            breadboardId: z.string(),
            rows: z.union([z.literal(30), z.literal(63)]),
            image: z.object({ width: z.number(), height: z.number() }),
            anchors: z.tuple([point, point, point, point]),
          }),
          rails: z.array(z.unknown()),
        }),
      ),
      reviews: z.array(
        z.object({
          proposal: z.object({
            analysisId: z.string(),
            imageId: z.string(),
            calibrationRevisions: z.record(z.string(), z.number()),
            wireCandidateId: z.string(),
            endpoints: z.tuple([
              z.object({
                proposedImagePosition: z
                  .tuple([z.number(), z.number()])
                  .nullable(),
                evidence: z.string(),
              }),
              z.object({
                proposedImagePosition: z
                  .tuple([z.number(), z.number()])
                  .nullable(),
                evidence: z.string(),
              }),
            ]),
          }),
        }),
      ),
    })
    .parse(rawBundle);
  const truth = z
    .object({
      imageSha256: z.string(),
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
    .parse(rawTruth);
  const report = z
    .object({
      version: z.literal("endpoint-grounding-experiment-v1"),
      imageHash: z.string(),
      snapshotRef: z.object({ samSnapshotHash: z.string() }),
      measurements: z.array(
        z.object({
          variant: z.enum(["full", "candidate_crop", "endpoint_crops"]),
          run: z.number().int().nonnegative(),
          wireCandidateId: z.string(),
          status: z.string(),
          response: z.unknown().nullable(),
        }),
      ),
      batches: z.array(
        z.object({
          variant: z.string(),
          run: z.number(),
          wallMs: z.number().nonnegative(),
          providerRequests: z.number().nonnegative(),
        }),
      ),
    })
    .parse(rawReport);
  if (
    truth.imageSha256 !== bundle.image.sha256 ||
    report.imageHash !== truth.imageSha256 ||
    truth.analysisRunId !== bundle.analysisRunId ||
    report.snapshotRef.samSnapshotHash !==
      bundle.analysis.provenance.samSnapshotHash ||
    JSON.stringify(bundle.resolverPolicy) !==
      JSON.stringify(HOLE_RESOLVER_POLICY)
  )
    throw new Error("Frozen image, run, snapshot or snap policy differs.");
  if (
    new Set(truth.wires.map((w) => w.id)).size !== truth.wires.length ||
    new Set(bundle.boards.map((b) => b.calibration.breadboardId)).size !==
      bundle.boards.length
  )
    throw new Error("Truth wires and boards must be unique.");
  const boards = bundle.boards.map((b) => ({
    revision: b.revision,
    calibration: calibrateBoard(
      b.calibration.breadboardId,
      b.calibration.rows,
      b.calibration.image,
      b.calibration.anchors,
    ),
    rails: b.rails as Rail[],
  }));
  if (
    boards.some(
      (b) =>
        b.calibration.image.width !== bundle.analysis.image.width ||
        b.calibration.image.height !== bundle.analysis.image.height,
    )
  )
    throw new Error("Calibration image dimensions differ.");
  const original: EvaluationWire[] = truth.wires.map((w) => {
    const candidates = bundle.reviews.filter(
      (r) => r.proposal.wireCandidateId === w.id,
    );
    if (candidates.length !== 1)
      throw new Error(
        "Freeze exactly one original proposal per evaluated physical wire.",
      );
    const proposal = candidates[0]!.proposal;
    if (
      proposal.analysisId !== bundle.analysisRunId ||
      proposal.imageId !== bundle.image.id ||
      boards.some(
        (b) =>
          proposal.calibrationRevisions[b.calibration.breadboardId] !==
          b.revision,
      )
    )
      throw new Error(
        "Original endpoint proposal is stale for this frozen run or calibration.",
      );
    const b = boards.find((b) => b.calibration.breadboardId === w.boardId);
    if (
      !b ||
      w.holes[0] === w.holes[1] ||
      !w.holes.every((id) =>
        allHoles(b.calibration, b.rails).some((h) => h.id === id),
      )
    )
      throw new Error("Truth must name distinct calibrated holes.");
    return {
      id: w.id,
      boardId: w.boardId,
      holes: w.holes,
      ...(w.positions ? { groundTruthPositions: w.positions } : {}),
      proposals: candidates[0]!.proposal.endpoints.map((e) =>
        e.evidence === "visible_insertion" && e.proposedImagePosition
          ? { x: e.proposedImagePosition[0], y: e.proposedImagePosition[1] }
          : null,
      ) as EvaluationWire["proposals"],
    };
  });
  const raw = replayEvaluation(original, boards),
    aligned = original.map((w, i) =>
      alignTruth(w, raw.results[i].resolved, boards),
    ),
    baseline = replayEvaluation(
      aligned.map((a) => a.wire),
      boards,
      { orderedRoles: true },
    );
  const keys = [
    ...new Set(report.measurements.map((m) => `${m.variant}:${m.run}`)),
  ];
  const experiments = keys.map((key) => {
    const [variant, runString] = key.split(":"),
      run = Number(runString),
      measurements = report.measurements.filter(
        (m) => m.variant === variant && m.run === run,
      );
    if (
      new Set(measurements.map((m) => m.wireCandidateId)).size !==
        measurements.length ||
      measurements.some(
        (m) => !original.some((w) => w.id === m.wireCandidateId),
      )
    )
      throw new Error("Duplicate or foreign measured wires.");
    const proposed = aligned.map((a) => {
      const m = measurements.find((m) => m.wireCandidateId === a.wire.id),
        response =
          m?.status === "succeeded"
            ? endpointResponseSchema.parse(m.response)
            : null;
      if (
        response &&
        (response.wireCandidateId !== a.wire.id ||
          response.analysisId !== bundle.analysisRunId ||
          response.imageId !== bundle.image.id ||
          response.endpoints.some(
            (e) =>
              e.proposedImagePosition &&
              (e.proposedImagePosition[0] >= bundle.analysis.image.width ||
                e.proposedImagePosition[1] >= bundle.analysis.image.height),
          ))
      )
        throw new Error("Measured endpoint provenance or bounds differ.");
      return {
        ...a.wire,
        proposals: response
          ? (response.endpoints.map((e) =>
              e.evidence === "visible_insertion" && e.proposedImagePosition
                ? {
                    x: e.proposedImagePosition[0],
                    y: e.proposedImagePosition[1],
                  }
                : null,
            ) as EvaluationWire["proposals"])
          : ([null, null] as EvaluationWire["proposals"]),
      };
    });
    const scored = replayEvaluation(proposed, boards, { orderedRoles: true });
    let correctToWrong = 0,
      correctToUnresolved = 0,
      unresolvedToCorrect = 0;
    const pairs: { raw: number; focused: number }[] = [];
    aligned.forEach((a, i) => {
      for (let j = 0; j < 2; j++) {
        const expected = `${a.wire.boardId}:${a.wire.holes[j]}`,
          before = baseline.results[i].resolved[j],
          after = scored.results[i].resolved[j];
        if (before === expected && after !== expected) {
          if (after) correctToWrong++;
          else correctToUnresolved++;
        }
        if (!before && after === expected) unresolvedToCorrect++;
        const p = a.wire.proposals[j],
          q = proposed[i].proposals[j],
          center = a.reference[j];
        if (p && q)
          pairs.push({
            raw: Math.hypot(p.x - center.x, p.y - center.y),
            focused: Math.hypot(q.x - center.x, q.y - center.y),
          });
      }
    });
    const batch = report.batches.find(
        (b) => b.variant === variant && b.run === run,
      ),
      mean = (values: number[]) =>
        values.length
          ? values.reduce((a, b) => a + b, 0) / values.length
          : null;
    const localization = {
      pairedCount: pairs.length,
      rawMeanPx: mean(pairs.map((p) => p.raw)),
      variantMeanPx: mean(pairs.map((p) => p.focused)),
      independentlyMarkedEndpoints:
        aligned.filter((a) => a.basis === "independently_marked_centers")
          .length * 2,
      referenceNote:
        "Projected centers are calibration-derived, not independently measured localization truth.",
    };
    return {
      variant,
      run,
      ...scored,
      transitions: { correctToWrong, correctToUnresolved, unresolvedToCorrect },
      localization,
      batch: batch ?? null,
      noRegression:
        scored.wrong === 0 && correctToWrong === 0 && correctToUnresolved === 0,
      nextTargetsMet:
        scored.endpoints === 10 &&
        scored.wires === 5 &&
        scored.correct >= 8 &&
        scored.completeWires >= 4 &&
        scored.wrong === 0 &&
        correctToWrong === 0 &&
        correctToUnresolved === 0 &&
        batch !== undefined &&
        batch.wallMs < 75000,
    };
  });
  return {
    version: "grounding-comparison-v1",
    baseline,
    experiments,
    notes:
      "Every blinded truth endpoint stays in the denominator, including absent/failed responses and original abstentions. A/B truth correspondence is frozen from original proposals once. No corrected assignment or ground truth was sent to Muse. Passing one photograph requires held-out validation.",
  };
}
