export interface PixelPoint {
  x: number;
  y: number;
}
export interface MeasuredHole extends PixelPoint {
  column: number;
  row: number;
}
export interface LatticeFit {
  rows: 30 | 63;
  observedRows: number;
  anchors: [PixelPoint, PixelPoint, PixelPoint, PixelPoint];
  holes: MeasuredHole[];
  pitch: number;
  rmsPitch: number;
  inlierRatio: number;
  rails?: {
    first: PixelPoint;
    last: PixelPoint;
    count: 25 | 50;
    layout: "uniform" | "groups-of-five";
    observedCount: number;
    rmsPitch: number;
  }[];
}
const columns = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
const median = (a: number[]) =>
  [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const quantile = (a: number[], q: number) =>
  [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)] ?? 0;
const dot = (a: PixelPoint, b: PixelPoint) => a.x * b.x + a.y * b.y;
const distance = (a: PixelPoint, b: PixelPoint) =>
  Math.hypot(a.x - b.x, a.y - b.y);
let seed = 1;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
interface Line {
  origin: PixelPoint;
  axis: PixelPoint;
  points: PixelPoint[];
  at: number;
}
function lineFit(points: PixelPoint[], direction: PixelPoint): Line {
  const origin = {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  };
  let xx = 0,
    yy = 0,
    xy = 0;
  for (const p of points) {
    const x = p.x - origin.x,
      y = p.y - origin.y;
    xx += x * x;
    xy += x * y;
    yy += y * y;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  let axis = { x: Math.cos(angle), y: Math.sin(angle) };
  if (dot(axis, direction) < 0) axis = { x: -axis.x, y: -axis.y };
  return { origin, axis, points, at: 0 };
}
function lines(
  points: PixelPoint[],
  direction: PixelPoint,
  pitch: number,
  minimum: number,
  max: number,
  angleTolerance = 10,
) {
  let remaining = [...points];
  const found: Line[] = [];
  for (let group = 0; group < max && remaining.length >= minimum; group++) {
    let best: PixelPoint[] = [];
    if (angleTolerance < 5) {
      const normal = { x: -direction.y, y: direction.x };
      for (const a of remaining) {
        const band = remaining.filter(
          (p) => Math.abs(dot(p, normal) - dot(a, normal)) < pitch * 0.22,
        );
        if (band.length < minimum) continue;
        const fitted = lineFit(band, direction);
        if (
          Math.abs(dot(fitted.axis, direction)) <
          Math.cos((angleTolerance * Math.PI) / 180)
        )
          continue;
        const members = remaining.filter(
          (p) =>
            Math.abs(
              (p.x - fitted.origin.x) * fitted.axis.y -
                (p.y - fitted.origin.y) * fitted.axis.x,
            ) <
            pitch * 0.19,
        );
        if (members.length > best.length) best = members;
      }
    }
    for (let trial = 0; trial < 450; trial++) {
      const a = remaining[Math.floor(random() * remaining.length)],
        b = remaining[Math.floor(random() * remaining.length)];
      const length = distance(a, b);
      if (length < pitch * 2) continue;
      const axis = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
      if (
        Math.abs(dot(axis, direction)) <
        Math.cos((angleTolerance * Math.PI) / 180)
      )
        continue;
      const members = remaining.filter(
        (p) =>
          Math.abs((p.x - a.x) * axis.y - (p.y - a.y) * axis.x) < pitch * 0.19,
      );
      if (members.length > best.length) best = members;
    }
    if (best.length < minimum) break;
    const fitted = lineFit(best, direction);
    const selected = new Set(best);
    remaining = remaining.filter((p) => !selected.has(p));
    found.push(fitted);
  }
  return found;
}
function intercept(
  line: Line,
  across: PixelPoint,
  along: PixelPoint,
  center: number,
) {
  const d = dot(line.axis, along);
  if (Math.abs(d) < 0.1) return NaN;
  return (
    dot(line.origin, across) +
    ((center - dot(line.origin, along)) * dot(line.axis, across)) / d
  );
}
function solve(rows: number[][]) {
  const n = 8;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
    if (Math.abs(rows[pivot][c]) < 1e-10) throw Error("Degenerate grid");
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    const divisor = rows[c][c];
    for (let j = c; j <= n; j++) rows[c][j] /= divisor;
    for (let r = 0; r < n; r++)
      if (r !== c) {
        const f = rows[r][c];
        for (let j = c; j <= n; j++) rows[r][j] -= f * rows[c][j];
      }
  }
  return [...rows.map((r) => r[8]), 1];
}
function homography(
  points: MeasuredHole[],
  width: number,
  height: number,
  rows: number,
) {
  const equations = points.flatMap((p) => {
    const u = columns[p.column] / 11,
      v = p.row / (rows - 1),
      x = p.x / width,
      y = p.y / height;
    return [
      [u, v, 1, 0, 0, 0, -x * u, -x * v, x],
      [0, 0, 0, u, v, 1, -y * u, -y * v, y],
    ];
  });
  return solve(
    Array.from({ length: 8 }, (_, r) =>
      Array.from({ length: 9 }, (_, c) =>
        equations.reduce((sum, e) => sum + e[r] * e[c], 0),
      ),
    ),
  );
}
function transform(
  h: number[],
  x: number,
  y: number,
  width: number,
  height: number,
): PixelPoint {
  const d = h[6] * x + h[7] * y + 1;
  return {
    x: ((h[0] * x + h[1] * y + h[2]) / d) * width,
    y: ((h[3] * x + h[4] * y + h[5]) / d) * height,
  };
}
/** Fit the repeated physical lattice, with no image-specific anchors or circuit layout. */
export function fitHoleLattice(
  raw: PixelPoint[],
  width: number,
  height: number,
  diagnostic?: (data: unknown) => void,
): LatticeFit {
  seed = 12345;
  if (raw.length < 60 || raw.length > 4000)
    throw Error("Not enough distinct hole centres to fit the grid.");
  const nearest = raw.map((p, i) =>
    Math.min(...raw.filter((_, j) => i !== j).map((q) => distance(p, q))),
  );
  const pitch = median(nearest.filter((d) => d > 2));
  if (pitch < 5)
    throw Error("Hole spacing is too small for reliable calibration.");
  const bins = Array.from({ length: 180 }, () => 0);
  for (let i = 0; i < raw.length; i++)
    for (let j = i + 1; j < raw.length; j++) {
      const dx = raw[j].x - raw[i].x,
        dy = raw[j].y - raw[i].y,
        d = Math.hypot(dx, dy);
      if (d < pitch * 0.75 || d > pitch * 1.3) continue;
      const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180;
      bins[Math.round(angle) % 180]++;
    }
  const smoothed = bins.map((_, i) =>
    [-3, -2, -1, 0, 1, 2, 3].reduce((s, j) => s + bins[(i + j + 180) % 180], 0),
  );
  const first = smoothed.indexOf(Math.max(...smoothed));
  let second = 0,
    best = -1;
  for (let i = 0; i < 180; i++) {
    const gap = Math.abs(((i - first + 270) % 180) - 90);
    if (gap > 65 && gap < 115 && smoothed[i] > best) {
      best = smoothed[i];
      second = i;
    }
  }
  const axes = [first, second].map((peak) => {
    let sine = 0,
      cosine = 0;
    for (let delta = -5; delta <= 5; delta++) {
      const a = (peak + delta + 180) % 180,
        weight = bins[a];
      sine += weight * Math.sin((a * Math.PI) / 90);
      cosine += weight * Math.cos((a * Math.PI) / 90);
    }
    const angle = 0.5 * Math.atan2(sine, cosine);
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });
  const extent = (axis: PixelPoint) =>
    quantile(
      raw.map((p) => dot(p, axis)),
      0.95,
    ) -
    quantile(
      raw.map((p) => dot(p, axis)),
      0.05,
    );
  const yAxis = axes[extent(axes[0]) > extent(axes[1]) ? 0 : 1];
  if (yAxis.y < -0.2 || (Math.abs(yAxis.y) < 0.2 && yAxis.x < 0)) {
    yAxis.x *= -1;
    yAxis.y *= -1;
  }
  let xAxis = { ...axes[yAxis === axes[0] ? 1 : 0] };
  if (xAxis.x < -0.2 || (Math.abs(xAxis.x) < 0.2 && xAxis.y < 0))
    xAxis = { x: -xAxis.x, y: -xAxis.y };
  diagnostic?.({ pitch, axes, xAxis, yAxis });
  const center = median(raw.map((p) => dot(p, yAxis)));
  const vertical = lines(
    raw,
    yAxis,
    pitch,
    Math.max(9, Math.round(raw.length / 45)),
    22,
  );
  vertical.forEach((l) => (l.at = intercept(l, xAxis, yAxis, center)));
  vertical.sort((a, b) => a.at - b.at);
  let matched: { line: Line; column: number }[] = [],
    score = -Infinity;
  for (const start of vertical)
    for (const scale of [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15]) {
      const spacing = pitch * scale,
        used = new Set<Line>(),
        candidate: { line: Line; column: number }[] = [];
      let residual = 0;
      if (
        vertical.some(
          (l) =>
            l.at > start.at + spacing * 4.5 && l.at < start.at + spacing * 6.5,
        )
      )
        continue;
      for (let c = 0; c < 10; c++) {
        const expected = start.at + columns[c] * spacing;
        const line = vertical
          .filter((l) => !used.has(l))
          .sort(
            (a, b) => Math.abs(a.at - expected) - Math.abs(b.at - expected),
          )[0];
        if (line && Math.abs(line.at - expected) < spacing * 0.32) {
          used.add(line);
          candidate.push({ line, column: c });
          residual += Math.abs(line.at - expected) / spacing;
        }
      }
      if (
        candidate.filter((c) => c.column < 5).length < 4 ||
        candidate.filter((c) => c.column >= 5).length < 4
      )
        continue;
      const value =
        candidate.length * 50 +
        candidate.reduce((s, c) => s + c.line.points.length, 0) -
        residual * 15;
      if (value > score) {
        score = value;
        matched = candidate;
      }
    }
  diagnostic?.({
    vertical: vertical.map((l) => ({ at: l.at, n: l.points.length })),
    matched: matched.map((l) => ({
      c: l.column,
      at: l.line.at,
      n: l.line.points.length,
    })),
  });
  if (matched.length < 8)
    throw Error("Could not separate both five-column terminal banks.");
  const selected = matched.flatMap((c) => c.line.points);
  // Printed column letters and component markings can form short, hole-like
  // horizontal rows. A physical terminal row must be supported across most of
  // the detected terminal banks.
  const minimumRowPoints = Math.max(4, Math.ceil(matched.length * 0.55));
  const horizontal = lines(
    selected,
    xAxis,
    pitch,
    minimumRowPoints,
    65,
    3.5,
  );
  const crossCenter = median(selected.map((p) => dot(p, xAxis)));
  horizontal.forEach((l) => (l.at = intercept(l, yAxis, xAxis, crossCenter)));
  horizontal.sort((a, b) => a.at - b.at);
  diagnostic?.({
    horizontal: horizontal.map((l) => ({ at: l.at, n: l.points.length })),
  });
  const spacing = median(
    horizontal
      .slice(1)
      .map((l, i) => l.at - horizontal[i].at)
      .filter((d) => d > pitch * 0.6 && d < pitch * 1.4),
  );
  if (!spacing || horizontal.length < 18)
    throw Error("Too few repeated rows are visible.");
  const indexed: { line: Line; row: number }[] = [];
  let index = 0;
  for (const [i, line] of horizontal.entries()) {
    if (i) {
      const d = (line.at - horizontal[i - 1].at) / spacing;
      index += Math.max(1, Math.round(d));
      if (Math.abs(d - Math.round(d)) > 0.35) continue;
    }
    indexed.push({ line, row: index });
  }
  const observedRows = indexed.at(-1)!.row + 1;
  const rows =
    observedRows <= 30
      ? 30
      : observedRows >= 45 && observedRows <= 63
        ? 63
        : null;
  if (!rows)
    throw Error("The measured row span does not match a supported board.");
  const labelled: MeasuredHole[] = [];
  for (const column of matched)
    for (const p of column.line.points) {
      const best = indexed
        .map((r) => ({
          r,
          d: Math.abs(
            (p.x - r.line.origin.x) * r.line.axis.y -
              (p.y - r.line.origin.y) * r.line.axis.x,
          ),
        }))
        .sort((a, b) => a.d - b.d)[0];
      if (best && best.d < pitch * 0.22)
        labelled.push({ ...p, column: column.column, row: best.r.row });
    }
  let inliers: MeasuredHole[] = [],
    matrix: number[] = [];
  for (let trial = 0; trial < 250; trial++) {
    const sample = Array.from(
      { length: 4 },
      () => labelled[Math.floor(random() * labelled.length)],
    );
    try {
      const h = homography(sample, width, height, rows);
      const selected = labelled.filter(
        (p) =>
          distance(
            p,
            transform(
              h,
              columns[p.column] / 11,
              p.row / (rows - 1),
              width,
              height,
            ),
          ) <
          pitch * 0.2,
      );
      if (selected.length > inliers.length) {
        inliers = selected;
        matrix = h;
      }
    } catch {}
  }
  if (inliers.length < 60 || inliers.length / labelled.length < 0.7)
    throw Error("Measured holes do not support a stable perspective grid.");
  matrix = homography(inliers, width, height, rows);
  const rmsPitch =
    Math.sqrt(
      inliers.reduce(
        (s, p) =>
          s +
          distance(
            p,
            transform(
              matrix,
              columns[p.column] / 11,
              p.row / (rows - 1),
              width,
              height,
            ),
          ) **
            2,
        0,
      ) / inliers.length,
    ) / pitch;
  if (rmsPitch > 0.13) throw Error("Grid reprojection error is too large.");
  const anchors = [
    transform(matrix, 0, 0, width, height),
    transform(matrix, 1, 0, width, height),
    transform(matrix, 1, 1, width, height),
    transform(matrix, 0, 1, width, height),
  ] as LatticeFit["anchors"];
  if (
    anchors.some(
      (p) =>
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.y < 0 ||
        p.x >= width ||
        p.y >= height,
    )
  )
    throw Error(
      "The grid extends beyond the photograph; capture the full board.",
    );
  return {
    rows,
    observedRows,
    anchors,
    holes: inliers,
    pitch,
    rmsPitch,
    inlierRatio: inliers.length / labelled.length,
  };
}
