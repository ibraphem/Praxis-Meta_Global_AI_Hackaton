/** Geometry for a standard 10-column, 2.54 mm-pitch terminal grid.
 * Coordinates are in hole pitches: a–e = x 0–4, f–j = x 7–11.
 * The three-pitch e–f spacing models the center channel, not a conductor.
 * Calibration is manual and photograph-local; it does not establish visibility
 * or electrical contact. Power buses require separate registration/declarations.
 */
export interface Point {
  x: number;
  y: number;
}
export interface ImageSize {
  width: number;
  height: number;
}
export type Rows = 30 | 63;
export type Matrix = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
export interface Calibration {
  breadboardId: string;
  templateId: "standard-10-column-v1";
  rows: Rows;
  image: ImageSize;
  /** Hole centers, in order: a1, j1, jN, aN. This order defines orientation. */
  anchors: [Point, Point, Point, Point];
  forward: Matrix;
  inverse: Matrix;
}
export interface Rail {
  id: string;
  label: "unmarked" | "positive" | "negative";
  count: 25 | 50;
  layout: "uniform" | "groups-of-five";
  /** Positions in the calibrated board plane, not image pixels. */
  first: Point;
  last: Point;
  connectivity: "unknown" | "continuous" | "split";
  splitAfter: number | null;
}
export interface Hole {
  id: string;
  kind: "terminal" | "rail";
  grid: Point;
  electricalGroup: string | null;
  groupBasis: "template" | "user_declared" | "unknown";
}
export interface HoleSelection {
  breadboardId: string;
  hole: string;
  kind: Hole["kind"];
  electricalGroup: string | null;
  groupBasis: Hole["groupBasis"];
  groupMembers: string[];
  imagePosition: Point;
  calibrationSource: "manual";
  selectionSource: "image_click" | "coordinate_lookup" | "pixel_entry";
  visibility: "unverified";
  electricalContact: "unknown";
}

const COLUMNS = "abcdefghij";
const GRID_WIDTH = 11;
const SNAP_RADIUS = 0.32; // Less than half a hole pitch; never snap across a gap.
const finitePoint = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y);
const inImage = (p: Point, image: ImageSize) =>
  finitePoint(p) &&
  p.x >= 0 &&
  p.y >= 0 &&
  p.x < image.width &&
  p.y < image.height;

/** Convert a viewport click using the actual rendered image box, including zoom/scroll. */
export function clientPointToImage(
  point: Point,
  rect: { left: number; top: number; width: number; height: number },
  image: ImageSize,
): Point | null {
  if (
    ![point.x, point.y, rect.left, rect.top, rect.width, rect.height].every(
      Number.isFinite,
    ) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null;
  const pixel = {
    x: ((point.x - rect.left) / rect.width) * image.width,
    y: ((point.y - rect.top) / rect.height) * image.height,
  };
  return inImage(pixel, image) ? pixel : null;
}

/** Partial-pivot elimination on a fixed 8×8 system, using normalized coordinates. */
function solve(rows: number[][]): number[] {
  for (let column = 0; column < 8; column++) {
    let pivot = column;
    for (let row = column + 1; row < 8; row++)
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column]))
        pivot = row;
    if (Math.abs(rows[pivot][column]) < 1e-10)
      throw new Error(
        "Reference points cannot define a stable perspective transform.",
      );
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let j = column; j <= 8; j++) rows[column][j] /= divisor;
    for (let row = 0; row < 8; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let j = column; j <= 8; j++)
        rows[row][j] -= factor * rows[column][j];
    }
  }
  return rows.map((row) => row[8]);
}
function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f, g, h, i] = m;
  const cofactors: Matrix = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ];
  const determinant = a * cofactors[0] + b * cofactors[3] + c * cofactors[6];
  if (Math.abs(determinant) < 1e-12)
    throw new Error("Reference points are too compressed.");
  return cofactors.map((value) => value / determinant) as Matrix;
}
function transform(m: Matrix, p: Point): Point {
  const denominator = m[6] * p.x + m[7] * p.y + m[8];
  if (Math.abs(denominator) < 1e-9)
    throw new Error("Position is outside the calibrated perspective plane.");
  const result = {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / denominator,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / denominator,
  };
  if (!finitePoint(result)) throw new Error("Invalid projected position.");
  return result;
}
export function project(calibration: Calibration, grid: Point): Point {
  const p = transform(calibration.forward, {
    x: grid.x / GRID_WIDTH,
    y: grid.y / (calibration.rows - 1),
  });
  return {
    x: p.x * calibration.image.width,
    y: p.y * calibration.image.height,
  };
}
export function unproject(calibration: Calibration, pixel: Point): Point {
  const p = transform(calibration.inverse, {
    x: pixel.x / calibration.image.width,
    y: pixel.y / calibration.image.height,
  });
  return { x: p.x * GRID_WIDTH, y: p.y * (calibration.rows - 1) };
}

/** Local image-axis angles: clockwise degrees from image-right, at grid center. */
export function boardOrientation(calibration: Calibration) {
  const center = { x: GRID_WIDTH / 2, y: (calibration.rows - 1) / 2 };
  const origin = project(calibration, center);
  const angle = (delta: Point) => {
    const p = project(calibration, {
      x: center.x + delta.x,
      y: center.y + delta.y,
    });
    return (Math.atan2(p.y - origin.y, p.x - origin.x) * 180) / Math.PI;
  };
  return {
    columnAxisDegrees: angle({ x: 1, y: 0 }),
    rowAxisDegrees: angle({ x: 0, y: 1 }),
  };
}

export function calibrateBoard(
  breadboardId: string,
  rows: Rows,
  image: ImageSize,
  anchors: Point[],
): Calibration {
  if (
    !/^board_[1-9]\d*$/.test(breadboardId) ||
    ![30, 63].includes(rows) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > 16_000_000 ||
    anchors.length !== 4 ||
    !anchors.every((p) => inImage(p, image))
  )
    throw new Error("Choose four hole centers inside the photograph.");
  const cross = anchors.map((a, index) => {
    const b = anchors[(index + 1) % 4],
      c = anchors[(index + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  if (!cross.every((value) => value > 1) && !cross.every((value) => value < -1))
    throw new Error(
      "Choose a1, j1, jN, aN in order around the terminal grid. Points must form a convex quadrilateral.",
    );
  const unit = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const system = unit.flatMap((p, index) => {
    const x = anchors[index].x / image.width,
      y = anchors[index].y / image.height;
    return [
      [p.x, p.y, 1, 0, 0, 0, -x * p.x, -x * p.y, x],
      [0, 0, 0, p.x, p.y, 1, -y * p.x, -y * p.y, y],
    ];
  });
  const forward = [...solve(system), 1] as Matrix;
  // Include the narrow padding used to draw terminal-strip outlines. A horizon
  // immediately outside the anchors must not produce an unrenderable overlay.
  const padded = [-0.4, GRID_WIDTH + 0.4].flatMap((x) =>
    [-0.4, rows - 0.6].map((y) => ({ x: x / GRID_WIDTH, y: y / (rows - 1) })),
  );
  const denominators = [...unit, ...padded].map(
    (p) => forward[6] * p.x + forward[7] * p.y + 1,
  );
  if (!denominators.every((d) => d > 1e-6))
    throw new Error("The perspective is too extreme to calibrate reliably.");
  const calibration: Calibration = {
    breadboardId,
    templateId: "standard-10-column-v1",
    rows,
    image: { ...image },
    anchors: anchors.map((p) => ({ ...p })) as Calibration["anchors"],
    forward,
    inverse: invert(forward),
  };
  // A grid that is subpixel in the source cannot support credible hole picking.
  for (const grid of [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: rows - 2 },
    { x: 10, y: rows - 2 },
  ]) {
    const p = project(calibration, grid);
    for (const delta of [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]) {
      const q = project(calibration, {
        x: grid.x + delta.x,
        y: grid.y + delta.y,
      });
      if (Math.hypot(p.x - q.x, p.y - q.y) < 1.5)
        throw new Error(
          "Holes are too small in the original photograph. Use a closer, clearer image.",
        );
    }
  }
  return calibration;
}

export function terminalHoles(calibration: Calibration): Hole[] {
  return [...COLUMNS].flatMap((column, index) =>
    Array.from({ length: calibration.rows }, (_, i) => ({
      id: `${column}${i + 1}`,
      kind: "terminal" as const,
      grid: { x: index < 5 ? index : index + 2, y: i },
      electricalGroup: `${calibration.breadboardId}:terminal-${index < 5 ? "a-e" : "f-j"}-${i + 1}`,
      groupBasis: "template" as const,
    })),
  );
}
const railOffset = (index: number, layout: Rail["layout"]) =>
  index + (layout === "groups-of-five" ? Math.floor(index / 5) : 0);

/** Register a rail from its first/last hole centers. Never infer bus continuity from color. */
export function registerRail(
  calibration: Calibration,
  definition: Omit<Rail, "first" | "last">,
  firstPixel: Point,
  lastPixel: Point,
): Rail {
  if (
    !/^R[1-4]$/.test(definition.id) ||
    !["unmarked", "positive", "negative"].includes(definition.label) ||
    ![25, 50].includes(definition.count) ||
    !["uniform", "groups-of-five"].includes(definition.layout) ||
    !["unknown", "continuous", "split"].includes(definition.connectivity) ||
    !inImage(firstPixel, calibration.image) ||
    !inImage(lastPixel, calibration.image)
  )
    throw new Error("Invalid rail definition or reference points.");
  if (
    definition.connectivity === "split" &&
    (!Number.isInteger(definition.splitAfter) ||
      definition.splitAfter! < 1 ||
      definition.splitAfter! >= definition.count)
  )
    throw new Error("Declare the rail split after a valid hole number.");
  const first = unproject(calibration, firstPixel),
    last = unproject(calibration, lastPixel);
  const pitch =
    Math.hypot(last.x - first.x, last.y - first.y) /
    railOffset(definition.count - 1, definition.layout);
  if (
    Math.abs(first.x - last.x) > 0.5 ||
    !(
      (first.x < -0.7 && last.x < -0.7) ||
      (first.x > GRID_WIDTH + 0.7 && last.x > GRID_WIDTH + 0.7)
    ) ||
    pitch < 0.8 ||
    pitch > 1.2
  )
    throw new Error(
      "Rail anchors must follow one bus outside the terminal grid, at approximately the same hole pitch. Check the count and spacing pattern.",
    );
  const rail: Rail = {
    ...definition,
    splitAfter:
      definition.connectivity === "split" ? definition.splitAfter : null,
    first,
    last,
  };
  if (
    railHoles(calibration, rail).some(
      (hole) => !inImage(project(calibration, hole.grid), calibration.image),
    )
  )
    throw new Error("The projected rail extends outside the photograph.");
  return rail;
}
export function railHoles(calibration: Calibration, rail: Rail): Hole[] {
  const span = railOffset(rail.count - 1, rail.layout);
  return Array.from({ length: rail.count }, (_, index) => {
    const fraction = railOffset(index, rail.layout) / span;
    return {
      id: `${rail.id}:${index + 1}`,
      kind: "rail",
      grid: {
        x: rail.first.x + (rail.last.x - rail.first.x) * fraction,
        y: rail.first.y + (rail.last.y - rail.first.y) * fraction,
      },
      electricalGroup:
        rail.connectivity === "unknown"
          ? null
          : `${calibration.breadboardId}:rail-${rail.id}-${rail.connectivity === "split" && index >= rail.splitAfter! ? 2 : 1}`,
      groupBasis: rail.connectivity === "unknown" ? "unknown" : "user_declared",
    };
  });
}
export function allHoles(calibration: Calibration, rails: Rail[]): Hole[] {
  return [
    ...terminalHoles(calibration),
    ...rails.flatMap((rail) => railHoles(calibration, rail)),
  ];
}
export function selectHole(
  calibration: Calibration,
  rails: Rail[],
  hole: Hole,
  selectionSource: HoleSelection["selectionSource"],
): HoleSelection {
  return {
    breadboardId: calibration.breadboardId,
    hole: hole.id,
    kind: hole.kind,
    electricalGroup: hole.electricalGroup,
    groupBasis: hole.groupBasis,
    groupMembers:
      hole.electricalGroup === null
        ? []
        : allHoles(calibration, rails)
            .filter(
              (candidate) => candidate.electricalGroup === hole.electricalGroup,
            )
            .map((candidate) => candidate.id),
    imagePosition: project(calibration, hole.grid),
    calibrationSource: "manual",
    selectionSource,
    visibility: "unverified",
    electricalContact: "unknown",
  };
}
/** Reject background, center-channel and between-hole clicks rather than inventing a match. */
export function pickHole(
  calibration: Calibration,
  rails: Rail[],
  pixel: Point,
  source: "image_click" | "pixel_entry" = "image_click",
): HoleSelection | null {
  if (!inImage(pixel, calibration.image)) return null;
  let grid: Point;
  try {
    grid = unproject(calibration, pixel);
  } catch {
    return null;
  }
  const nearest = allHoles(calibration, rails)
    .map((hole) => ({
      hole,
      distance: Math.hypot(grid.x - hole.grid.x, grid.y - hole.grid.y),
    }))
    .sort((a, b) => a.distance - b.distance);
  if (
    !nearest[0] ||
    nearest[0].distance > SNAP_RADIUS ||
    (nearest[1] && nearest[1].distance - nearest[0].distance < 0.12)
  )
    return null;
  return selectHole(calibration, rails, nearest[0].hole, source);
}
