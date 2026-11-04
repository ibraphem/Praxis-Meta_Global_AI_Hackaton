import {
  calibrateBoard,
  project,
  unproject,
} from "../../../praxis-backend/server/src/shared/calibration";
import type { LatticeFit, PixelPoint } from "./lattice";
const median = (a: number[]) =>
  [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
/** Fit unmarked rail hole patterns; this never declares electrical continuity. */
export function fitPowerRails(
  points: PixelPoint[],
  fit: LatticeFit,
  image: { width: number; height: number },
): NonNullable<LatticeFit["rails"]> {
  const c = calibrateBoard("board_1", fit.rows, image, fit.anchors);
  const outside = points
    .map((p) => unproject(c, p))
    .filter(
      (p) =>
        (p.x < -0.8 || p.x > 11.8) &&
        p.x > -6 &&
        p.x < 17 &&
        p.y > -0.5 &&
        p.y < fit.rows - 0.5,
    )
    .sort((a, b) => a.x - b.x);
  const clusters: PixelPoint[][] = [];
  for (const p of outside) {
    const nearest = clusters.find(
      (group) => Math.abs(median(group.map((p) => p.x)) - p.x) < 0.2,
    );
    if (nearest) nearest.push(p);
    else clusters.push([p]);
  }
  const result: NonNullable<LatticeFit["rails"]> = [];
  for (const group of clusters.filter((g) => g.length >= 18)) {
    const x = median(group.map((p) => p.x)),
      ys = group.map((p) => p.y).sort((a, b) => a - b);
    let best: {
      count: 25 | 50;
      layout: "uniform" | "groups-of-five";
      phase: number;
      support: number;
      rms: number;
      span: number;
    } | null = null;
    for (const count of [25, 50] as const)
      for (const layout of ["uniform", "groups-of-five"] as const) {
        const offsets = Array.from(
            { length: count },
            (_, i) => i + (layout === "groups-of-five" ? Math.floor(i / 5) : 0),
          ),
          span = offsets.at(-1)!;
        if (span > fit.rows - 1) continue;
        for (let phase = 0; phase <= fit.rows - 1 - span; phase += 0.05) {
          const residuals = ys
            .map((y) =>
              Math.min(
                ...offsets.map((offset) => Math.abs(y - offset - phase)),
              ),
            )
            .filter((d) => d < 0.16);
          const support = new Set(
            ys
              .map(
                (y) =>
                  offsets
                    .map((offset, index) => ({
                      index,
                      d: Math.abs(y - offset - phase),
                    }))
                    .sort((a, b) => a.d - b.d)[0],
              )
              .filter((o) => o.d < 0.16)
              .map((o) => o.index),
          ).size;
          const rms = Math.sqrt(
            residuals.reduce((s, d) => s + d * d, 0) /
              Math.max(1, residuals.length),
          );
          if (
            support >= count * 0.72 &&
            residuals.length >= group.length * 0.85 &&
            (!best ||
              support / count > best.support / best.count + 0.01 ||
              (Math.abs(support / count - best.support / best.count) <= 0.01 &&
                rms < best.rms))
          )
            best = { count, layout, phase, support, rms, span };
        }
      }
    if (best && best.rms < 0.1)
      result.push({
        first: project(c, { x, y: best.phase }),
        last: project(c, { x, y: best.phase + best.span }),
        count: best.count,
        layout: best.layout,
        observedCount: best.support,
        rmsPitch: best.rms,
      });
  }
  return result.slice(0, 4);
}
