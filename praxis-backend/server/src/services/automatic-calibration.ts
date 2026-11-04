import {
  calibrateBoard,
  project,
  registerRail,
  unproject,
  HOLE_RESOLVER_POLICY,
  type Calibration,
  type Point,
} from '../shared/calibration.js';
import type { z } from 'zod';
import type { boardObservationSchema } from '../shared/automatic-circuit.js';

// Fit a homography to labelled, visible holes. No circuit-specific coordinates.
function solve(rows: number[][]): number[] {
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++)
      if (Math.abs(rows[r]![c]!) > Math.abs(rows[pivot]![c]!)) pivot = r;
    if (Math.abs(rows[pivot]![c]!) < 1e-10)
      throw Error('Hole landmarks do not span a stable grid.');
    [rows[c], rows[pivot]] = [rows[pivot]!, rows[c]!];
    const divisor = rows[c]![c]!;
    for (let j = c; j <= 8; j++) rows[c]![j]! /= divisor;
    for (let r = 0; r < 8; r++)
      if (r !== c) {
        const factor = rows[r]![c]!;
        for (let j = c; j <= 8; j++) rows[r]![j]! -= factor * rows[c]![j]!;
      }
  }
  return rows.map((r) => r[8]!);
}
export function fitObservedBoard(
  id: string,
  observation: z.infer<typeof boardObservationSchema>,
  image: { width: number; height: number },
) {
  const seen = new Set<string>();
  const points = observation.landmarks.map((l) => {
    if (seen.has(l.hole)) throw Error('Repeated hole landmark.');
    seen.add(l.hole);
    const column = 'abcdefghij'.indexOf(l.hole[0]!);
    const row = Number(l.hole.slice(1));
    if (column < 0 || row > observation.rows)
      throw Error('Landmark outside board layout.');
    return {
      grid: { x: column < 5 ? column : column + 2, y: row - 1 },
      pixel: {
        x: (l.position[0] / 999) * (image.width - 1),
        y: (l.position[1] / 999) * (image.height - 1),
      },
    };
  });
  if (
    points.length < 6 ||
    Math.max(...points.map((p) => p.grid.x)) -
      Math.min(...points.map((p) => p.grid.x)) <
      7 ||
    Math.max(...points.map((p) => p.grid.y)) -
      Math.min(...points.map((p) => p.grid.y)) <
      observation.rows / 4
  )
    throw Error(
      'Use visible labelled holes on both halves and across the board length.',
    );
  const equations = points.flatMap(({ grid, pixel }) => {
    const u = grid.x / 11,
      v = grid.y / (observation.rows - 1),
      x = pixel.x / image.width,
      y = pixel.y / image.height;
    return [
      [u, v, 1, 0, 0, 0, -x * u, -x * v, x],
      [0, 0, 0, u, v, 1, -y * u, -y * v, y],
    ];
  });
  const normal = Array.from({ length: 8 }, (_, r) =>
    Array.from({ length: 9 }, (_, c) =>
      equations.reduce((sum, e) => sum + e[r]! * e[c]!, 0),
    ),
  );
  const h = solve(normal);
  const at = (x: number, y: number): Point => {
    const d = h[6]! * x + h[7]! * y + 1;
    return {
      x: ((h[0]! * x + h[1]! * y + h[2]!) / d) * image.width,
      y: ((h[3]! * x + h[4]! * y + h[5]!) / d) * image.height,
    };
  };
  const calibration = calibrateBoard(
    id,
    observation.rows,
    { width: image.width, height: image.height },
    [at(0, 0), at(1, 0), at(1, 1), at(0, 1)],
  );
  const errors = points.map((p) => {
    const actual = unproject(calibration, p.pixel);
    return Math.hypot(actual.x - p.grid.x, actual.y - p.grid.y);
  });
  if (Math.max(...errors) > HOLE_RESOLVER_POLICY.snapRadiusPitch)
    throw Error(
      'Proposed grid landmarks disagree by too much; adjust them before confirming.',
    );
  const warnings: string[] = [];
  const rails = observation.rails.flatMap((r, i) => {
    try {
      return [
        registerRail(
          calibration,
          {
            id: `R${i + 1}`,
            label: r.label,
            count: r.count,
            layout: r.layout,
            connectivity: 'unknown',
            splitAfter: null,
          },
          {
            x: (r.first[0] / 999) * (image.width - 1),
            y: (r.first[1] / 999) * (image.height - 1),
          },
          {
            x: (r.last[0] / 999) * (image.width - 1),
            y: (r.last[1] / 999) * (image.height - 1),
          },
        ),
      ];
    } catch {
      warnings.push(
        `Rail ${i + 1} could not be registered; its contacts remain unresolved.`,
      );
      return [];
    }
  });
  return { calibration, rails, residualPitch: Math.max(...errors), warnings };
}

/** Locally refine a proposal using dark hole centres, never component colour. */
export function refineGridLandmarks(
  observation: z.infer<typeof boardObservationSchema>,
  gray: { data: Uint8Array; width: number; height: number },
): z.infer<typeof boardObservationSchema> {
  let calibration: Calibration;
  try {
    calibration = fitObservedBoard(
      'board_1',
      { ...observation, rails: [] },
      gray,
    ).calibration;
  } catch {
    return observation;
  }
  const landmarks = observation.landmarks.map((l) => {
    const x = (l.position[0] / 999) * (gray.width - 1),
      y = (l.position[1] / 999) * (gray.height - 1);
    const grid = unproject(calibration, { x, y }),
      neighbor = project(calibration, { x: grid.x + 1, y: grid.y });
    const radius = Math.max(
      1,
      Math.min(12, Math.hypot(neighbor.x - x, neighbor.y - y) * 0.24),
    );
    let best = Infinity,
      bx = x,
      by = y;
    for (
      let py = Math.max(1, Math.ceil(y - radius));
      py < Math.min(gray.height - 1, y + radius);
      py++
    )
      for (
        let px = Math.max(1, Math.ceil(x - radius));
        px < Math.min(gray.width - 1, x + radius);
        px++
      ) {
        if (Math.hypot(px - x, py - y) > radius) continue;
        let brightness = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            brightness += gray.data[(py + dy) * gray.width + px + dx]!;
        const score =
          brightness / 9 + (12 * Math.hypot(px - x, py - y)) / radius;
        if (score < best) {
          best = score;
          bx = px;
          by = py;
        }
      }
    return {
      ...l,
      position: [
        (bx / (gray.width - 1)) * 999,
        (by / (gray.height - 1)) * 999,
      ] as [number, number],
    };
  });
  const result = { ...observation, landmarks };
  try {
    fitObservedBoard('board_1', { ...result, rails: [] }, gray);
    return result;
  } catch {
    return observation;
  }
}
