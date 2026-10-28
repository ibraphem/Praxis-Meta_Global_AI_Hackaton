import type { Analysis, Component } from "../vision";
import {
  pickHole,
  type Calibration,
  type ImageSize,
  type Point,
  type Rail,
} from "../breadboard/calibration";

export interface CalibratedBoard {
  calibration: Calibration;
  rails: Rail[];
  revision: number;
}
export interface AssignmentContext {
  photoId: string;
  analysisRunId: string | null;
  analysis: Analysis | null;
}
export interface ManualEndpoint {
  selectionSource: "manual";
  inputMethod: "image_click" | "pixel_entry";
  locationVerification: "user_selected";
  /** Preserve the user's observation independently of the snapped grid location. */
  selectedImagePosition: Point;
  boardId: string;
  calibrationRevision: number;
  resolution:
    | {
        status: "resolved";
        source: "calibrated_grid";
        holeId: string;
        imagePosition: Point;
        electricalGroup: string | null;
        groupBasis: "template" | "user_declared" | "unknown";
        snapDistancePx: number;
      }
    | { status: "unknown"; source: "none"; reason: "no_unambiguous_hole" };
  electricalContact: "unknown";
}
export interface WireAssignment {
  id: string;
  photoId: string;
  analysisRunId: string;
  wireCandidateId: string;
  wireIdentity: { status: "unverified"; associationSource: "user" };
  endpoints: [ManualEndpoint | null, ManualEndpoint | null];
}
export type StaleReason =
  | "photo_changed"
  | "analysis_changed"
  | "wire_unavailable"
  | "calibration_changed"
  | "board_removed"
  | "image_dimensions_changed";
export interface AssignmentValidity {
  status: "stale" | "draft" | "complete";
  reasons: StaleReason[];
}
export const MAX_ASSIGNMENTS = 100;

export function isSegmentedWire(
  component: Component | undefined,
): component is Component & { mask: NonNullable<Component["mask"]> } {
  return (
    component?.type === "jumper_wire" &&
    component.geometryStatus === "segmented" &&
    !!component.mask
  );
}
export function wireCandidate(context: AssignmentContext, id: string) {
  const component = context.analysis?.objects.find(
    (object) => object.id === id,
  );
  return isSegmentedWire(component) ? component : null;
}
export function sameImage(a: ImageSize, b: ImageSize) {
  return a.width === b.width && a.height === b.height;
}

/** Derived validity never re-snaps stored observations when calibration changes. */
export function assignmentValidity(
  assignment: WireAssignment,
  context: AssignmentContext,
  boards: CalibratedBoard[],
): AssignmentValidity {
  const reasons = new Set<StaleReason>();
  if (assignment.photoId !== context.photoId) reasons.add("photo_changed");
  if (assignment.analysisRunId !== context.analysisRunId)
    reasons.add("analysis_changed");
  if (!wireCandidate(context, assignment.wireCandidateId))
    reasons.add("wire_unavailable");
  for (const endpoint of assignment.endpoints) {
    if (!endpoint) continue;
    const board = boards.find(
      (board) => board.calibration.breadboardId === endpoint.boardId,
    );
    if (!board) reasons.add("board_removed");
    else {
      if (board.revision !== endpoint.calibrationRevision)
        reasons.add("calibration_changed");
      if (
        context.analysis &&
        !sameImage(board.calibration.image, context.analysis.image)
      )
        reasons.add("image_dimensions_changed");
    }
  }
  return {
    status: reasons.size
      ? "stale"
      : assignment.endpoints.every(
            (endpoint) => endpoint?.resolution.status === "resolved",
          )
        ? "complete"
        : "draft",
    reasons: [...reasons],
  };
}
export function createAssignment(
  id: string,
  context: AssignmentContext,
  wireId: string,
): WireAssignment {
  if (
    !/^connection_[1-9]\d*$/.test(id) ||
    !context.photoId ||
    !context.analysisRunId ||
    !wireCandidate(context, wireId)
  )
    throw new Error("Select a segmented wire from the current analysis first.");
  return {
    id,
    photoId: context.photoId,
    analysisRunId: context.analysisRunId,
    wireCandidateId: wireId,
    wireIdentity: { status: "unverified", associationSource: "user" },
    endpoints: [null, null],
  };
}

/** Manual locations are observations, not inferred connector identity or measured contact. */
export function assignEndpoint(
  assignment: WireAssignment,
  index: 0 | 1,
  point: Point,
  inputMethod: ManualEndpoint["inputMethod"],
  board: CalibratedBoard,
  context: AssignmentContext,
  boards: CalibratedBoard[],
): WireAssignment {
  if (index !== 0 && index !== 1) throw new Error("Choose endpoint 1 or 2.");
  if (assignmentValidity(assignment, context, boards).status === "stale")
    throw new Error(
      "This assignment is stale. Start a new assignment for the current analysis and calibration.",
    );
  if (
    !boards.includes(board) ||
    !Number.isSafeInteger(board.revision) ||
    board.revision < 1 ||
    !context.analysis ||
    !sameImage(board.calibration.image, context.analysis.image)
  )
    throw new Error("Choose a current calibration for this photograph.");
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= board.calibration.image.width ||
    point.y >= board.calibration.image.height
  )
    throw new Error("Choose a position inside the photograph.");
  const hole = pickHole(board.calibration, board.rails, point, inputMethod);
  const endpoint: ManualEndpoint = {
    selectionSource: "manual",
    inputMethod,
    locationVerification: "user_selected",
    selectedImagePosition: { ...point },
    boardId: board.calibration.breadboardId,
    calibrationRevision: board.revision,
    resolution: hole
      ? {
          status: "resolved",
          source: "calibrated_grid",
          holeId: hole.hole,
          imagePosition: { ...hole.imagePosition },
          electricalGroup: hole.electricalGroup,
          groupBasis: hole.groupBasis,
          snapDistancePx: Math.hypot(
            point.x - hole.imagePosition.x,
            point.y - hole.imagePosition.y,
          ),
        }
      : { status: "unknown", source: "none", reason: "no_unambiguous_hole" },
    electricalContact: "unknown",
  };
  const endpoints: [ManualEndpoint | null, ManualEndpoint | null] = [
    ...assignment.endpoints,
  ];
  endpoints[index] = endpoint;
  return { ...assignment, endpoints };
}
export function reviseRails(
  board: CalibratedBoard,
  rails: Rail[],
): CalibratedBoard {
  return { ...board, rails, revision: board.revision + 1 };
}
export function replaceBoard(
  previous: CalibratedBoard | undefined,
  calibration: Calibration,
): CalibratedBoard {
  return { calibration, rails: [], revision: (previous?.revision ?? 0) + 1 };
}
