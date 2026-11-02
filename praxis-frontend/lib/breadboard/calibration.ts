// One geometry implementation shared with deterministic backend connectivity.
export {
  HOLE_RESOLVER_POLICY,
  clientPointToImage,
  project,
  unproject,
  boardOrientation,
  calibrateBoard,
  terminalHoles,
  registerRail,
  railHoles,
  allHoles,
  selectHole,
  diagnoseHole,
  pickHole,
} from "../../../praxis-backend/server/src/shared/calibration";
export type {
  Point,
  ImageSize,
  Rows,
  Matrix,
  Calibration,
  Rail,
  Hole,
  HoleSelection,
  HoleCandidateDiagnostic,
  HoleDiagnosis,
} from "../../../praxis-backend/server/src/shared/calibration";
