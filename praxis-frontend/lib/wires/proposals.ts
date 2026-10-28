import { z } from "zod";
import { diagnosticsSchema } from "../diagnostics";
import type { Point } from "../breadboard/calibration";
import {
  assignmentValidity,
  createAssignment,
  resolveEndpoint,
  sameImage,
  wireCandidate,
  type AssignmentContext,
  type CalibratedBoard,
  type ManualEndpoint,
  type StaleReason,
  type WireAssignment,
} from "./assignments";

export type EndpointRole = "A" | "B";
export type EndpointIndex = 0 | 1;
export type ReviewStatus = "proposed" | "confirmed" | "corrected" | "unknown";
export const endpointEvidenceSchema = z.enum([
  "visible_insertion",
  "visible_connector",
  "wire_mask_tip",
  "occluded",
  "insufficient",
]);
const pixelSchema = z.tuple([
  z.number().finite().nonnegative(),
  z.number().finite().nonnegative(),
]);
export const endpointSuggestionSchema = z
  .object({
    role: z.enum(["A", "B"]),
    proposedImagePosition: pixelSchema.nullable(),
    evidence: endpointEvidenceSchema,
  })
  .strict();
export const endpointResponseSchema = z
  .object({
    analysisId: z.string().min(1).max(100),
    imageId: z.string().min(1).max(100),
    wireCandidateId: z.string().regex(/^jumper_wire_[1-9]\d*$/),
    model: z.string().min(1).max(100),
    endpoints: z.tuple([endpointSuggestionSchema, endpointSuggestionSchema]),
    diagnostics: diagnosticsSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.endpoints[0].role === "A" && value.endpoints[1].role === "B",
  );
export type EndpointResponse = z.infer<typeof endpointResponseSchema>;
export interface ResolvedHole {
  boardId: string;
  holeId: string;
  snapDistancePx: number;
}
export interface EndpointProposal extends z.infer<
  typeof endpointSuggestionSchema
> {
  proposedHole: ResolvedHole | null;
  reviewStatus: "proposed";
}
export interface WireEndpointProposal {
  id: string;
  analysisId: string;
  imageId: string;
  wireCandidateId: string;
  calibrationRevisions: Record<string, number>;
  model: string;
  endpoints: [EndpointProposal, EndpointProposal];
}
export interface ReviewedEndpoint {
  role: EndpointRole;
  originalProposal: EndpointProposal;
  finalPosition: [number, number] | null;
  finalHole: ResolvedHole | null;
  reviewStatus: ReviewStatus;
  source: "ai_user_confirmed" | "manual_correction" | "user_unknown" | null;
  /** Resolver output retained for the existing assignment representation. */
  observation: ManualEndpoint | null;
}
export interface WireEndpointReview {
  proposal: WireEndpointProposal;
  endpoints: [ReviewedEndpoint, ReviewedEndpoint];
  pendingCorrections: [ManualEndpoint | null, ManualEndpoint | null];
  savedAssignmentId: string | null;
  dirty: boolean;
}
export function calibrationRevisions(boards: CalibratedBoard[]) {
  return Object.fromEntries(
    boards.map((board) => [board.calibration.breadboardId, board.revision]),
  );
}
export function proposalValidity(
  proposal: WireEndpointProposal,
  context: AssignmentContext,
  boards: CalibratedBoard[],
) {
  const reasons = new Set<StaleReason>();
  if (proposal.imageId !== context.photoId) reasons.add("photo_changed");
  if (proposal.analysisId !== context.analysisRunId)
    reasons.add("analysis_changed");
  if (!wireCandidate(context, proposal.wireCandidateId))
    reasons.add("wire_unavailable");
  for (const [id, revision] of Object.entries(proposal.calibrationRevisions)) {
    const board = boards.find((item) => item.calibration.breadboardId === id);
    if (!board) reasons.add("board_removed");
    else if (board.revision !== revision) reasons.add("calibration_changed");
  }
  // A newly calibrated board can make a formerly unique snap ambiguous.
  if (
    boards.some(
      (board) =>
        !(board.calibration.breadboardId in proposal.calibrationRevisions),
    )
  )
    reasons.add("calibration_changed");
  if (
    context.analysis &&
    boards.some(
      (board) => !sameImage(board.calibration.image, context.analysis!.image),
    )
  )
    reasons.add("image_dimensions_changed");
  return {
    status: reasons.size ? ("stale" as const) : ("current" as const),
    reasons: [...reasons],
  };
}
function assertCurrent(
  review: WireEndpointReview,
  context: AssignmentContext,
  boards: CalibratedBoard[],
) {
  if (proposalValidity(review.proposal, context, boards).status === "stale")
    throw new Error(
      "This endpoint review is stale. Request new proposals for the current analysis and calibration.",
    );
}
function holeOf(observation: ManualEndpoint | null): ResolvedHole | null {
  return observation?.resolution.status === "resolved"
    ? {
        boardId: observation.boardId,
        holeId: observation.resolution.holeId,
        snapDistancePx: observation.resolution.snapDistancePx,
      }
    : null;
}
/** Snap only through Step A, and refuse ambiguous matches across boards. */
export function createProposal(
  id: string,
  response: EndpointResponse,
  context: AssignmentContext,
  boards: CalibratedBoard[],
): WireEndpointProposal {
  const data = endpointResponseSchema.parse(response);
  if (
    !boards.length ||
    data.imageId !== context.photoId ||
    data.analysisId !== context.analysisRunId ||
    !wireCandidate(context, data.wireCandidateId)
  )
    throw new Error(
      "Endpoint response does not match the current wire and analysis.",
    );
  const endpoints = data.endpoints.map((endpoint): EndpointProposal => {
    const position = endpoint.proposedImagePosition;
    if (
      position &&
      (!context.analysis ||
        position[0] >= context.analysis.image.width ||
        position[1] >= context.analysis.image.height)
    )
      throw new Error(
        "Endpoint response contains pixels outside the photograph.",
      );
    // Hidden/insufficient evidence is never an authoritative insertion proposal.
    const matches =
      position && !["occluded", "insufficient"].includes(endpoint.evidence)
        ? boards
            .map((board) =>
              resolveEndpoint(
                { x: position[0], y: position[1] },
                "pixel_entry",
                board,
                context,
                boards,
              ),
            )
            .filter((item) => item.resolution.status === "resolved")
        : [];
    return {
      ...endpoint,
      proposedHole: matches.length === 1 ? holeOf(matches[0]) : null,
      reviewStatus: "proposed",
    };
  }) as [EndpointProposal, EndpointProposal];
  return {
    id,
    analysisId: data.analysisId,
    imageId: data.imageId,
    wireCandidateId: data.wireCandidateId,
    calibrationRevisions: calibrationRevisions(boards),
    model: data.model,
    endpoints,
  };
}
export function startReview(
  proposal: WireEndpointProposal,
): WireEndpointReview {
  // Detach the provenance snapshot from callers and pending edits.
  const original = structuredClone(proposal);
  return {
    proposal: original,
    endpoints: original.endpoints.map((endpoint) => ({
      role: endpoint.role,
      originalProposal: endpoint,
      finalPosition: null,
      finalHole: null,
      reviewStatus: "proposed",
      source: null,
      observation: null,
    })) as [ReviewedEndpoint, ReviewedEndpoint],
    pendingCorrections: [null, null],
    savedAssignmentId: null,
    dirty: true,
  };
}
function updateEndpoint(
  review: WireEndpointReview,
  index: EndpointIndex,
  endpoint: ReviewedEndpoint,
): WireEndpointReview {
  const endpoints: WireEndpointReview["endpoints"] = [...review.endpoints];
  const pendingCorrections: WireEndpointReview["pendingCorrections"] = [
    ...review.pendingCorrections,
  ];
  endpoints[index] = endpoint;
  pendingCorrections[index] = null;
  return { ...review, endpoints, pendingCorrections, dirty: true };
}
export function confirmEndpoint(
  review: WireEndpointReview,
  index: EndpointIndex,
  context: AssignmentContext,
  boards: CalibratedBoard[],
) {
  assertCurrent(review, context, boards);
  const original = review.endpoints[index].originalProposal;
  if (!original.proposedHole || !original.proposedImagePosition)
    throw new Error(
      "No reliable proposed hole. Correct this endpoint or mark it unknown.",
    );
  const board = boards.find(
    (item) => item.calibration.breadboardId === original.proposedHole!.boardId,
  )!;
  const observation: ManualEndpoint = {
    ...resolveEndpoint(
      {
        x: original.proposedImagePosition[0],
        y: original.proposedImagePosition[1],
      },
      "pixel_entry",
      board,
      context,
      boards,
    ),
    selectionSource: "ai_user_confirmed",
    inputMethod: "ai_proposal",
    locationVerification: "user_confirmed",
  };
  return updateEndpoint(review, index, {
    ...review.endpoints[index],
    finalPosition: [...original.proposedImagePosition],
    finalHole: { ...original.proposedHole },
    reviewStatus: "confirmed",
    source: "ai_user_confirmed",
    observation,
  });
}
export function markEndpointUnknown(
  review: WireEndpointReview,
  index: EndpointIndex,
  context: AssignmentContext,
  boards: CalibratedBoard[],
) {
  assertCurrent(review, context, boards);
  return updateEndpoint(review, index, {
    ...review.endpoints[index],
    finalPosition: null,
    finalHole: null,
    reviewStatus: "unknown",
    source: "user_unknown",
    observation: null,
  });
}
export function stageCorrection(
  review: WireEndpointReview,
  index: EndpointIndex,
  point: Point,
  method: Exclude<ManualEndpoint["inputMethod"], "ai_proposal">,
  board: CalibratedBoard,
  context: AssignmentContext,
  boards: CalibratedBoard[],
) {
  assertCurrent(review, context, boards);
  const pendingCorrections: WireEndpointReview["pendingCorrections"] = [
    ...review.pendingCorrections,
  ];
  pendingCorrections[index] = resolveEndpoint(
    point,
    method,
    board,
    context,
    boards,
  );
  return { ...review, pendingCorrections, dirty: true };
}
export function confirmCorrection(
  review: WireEndpointReview,
  index: EndpointIndex,
  context: AssignmentContext,
  boards: CalibratedBoard[],
) {
  assertCurrent(review, context, boards);
  const pending = review.pendingCorrections[index];
  const observation = pending
    ? { ...pending, selectionSource: "manual_correction" as const }
    : null;
  const finalHole = holeOf(observation);
  if (!observation || !finalHole)
    throw new Error(
      "Choose an unambiguous calibrated hole, or mark this endpoint unknown.",
    );
  return updateEndpoint(review, index, {
    ...review.endpoints[index],
    finalPosition: [
      observation.selectedImagePosition.x,
      observation.selectedImagePosition.y,
    ],
    finalHole,
    reviewStatus: "corrected",
    source: "manual_correction",
    observation,
  });
}
export function cancelCorrection(
  review: WireEndpointReview,
  index: EndpointIndex,
) {
  const pendingCorrections: WireEndpointReview["pendingCorrections"] = [
    ...review.pendingCorrections,
  ];
  pendingCorrections[index] = null;
  return { ...review, pendingCorrections };
}
export function reviewSaveIssue(
  review: WireEndpointReview,
  context: AssignmentContext,
  boards: CalibratedBoard[],
): string | null {
  if (proposalValidity(review.proposal, context, boards).status === "stale")
    return "Analysis or calibration changed. Request new proposals.";
  if (review.pendingCorrections.some(Boolean))
    return "Confirm or cancel the pending correction first.";
  if (review.endpoints.some((endpoint) => endpoint.reviewStatus === "proposed"))
    return "Review both endpoints before saving. Unknown is allowed.";
  const [a, b] = review.endpoints.map((endpoint) => endpoint.finalHole);
  if (a && b && a.boardId === b.boardId && a.holeId === b.holeId)
    return "Both endpoints use the same physical hole. Correct an endpoint or mark it unknown.";
  return null;
}
/** Only an explicitly saved review becomes an assignment, with contact still unknown. */
export function reviewedAssignment(
  id: string,
  review: WireEndpointReview,
  context: AssignmentContext,
  boards: CalibratedBoard[],
): WireAssignment {
  const issue = reviewSaveIssue(review, context, boards);
  if (issue) throw new Error(issue);
  const assignment = createAssignment(
    id,
    context,
    review.proposal.wireCandidateId,
  );
  const snapshot = structuredClone({
    ...review,
    savedAssignmentId: id,
    dirty: false,
  });
  const result: WireAssignment = {
    ...assignment,
    endpoints: snapshot.endpoints.map(
      (endpoint) => endpoint.observation,
    ) as WireAssignment["endpoints"],
    endpointReview: snapshot,
  };
  if (assignmentValidity(result, context, boards).status === "stale")
    throw new Error("This assignment is stale.");
  return result;
}

/** Invalidate on selection, analysis, calibration, requests and every manual edit. */
export class ProposalRequestGate {
  private generation = 0;
  invalidate() {
    this.generation++;
  }
  begin() {
    return ++this.generation;
  }
  accepts(generation: number) {
    return generation === this.generation;
  }
}
