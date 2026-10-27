import {
  allHoles,
  project,
  type Calibration,
  type HoleSelection,
  type Point,
  type Rail,
} from "@/lib/breadboard/calibration";

/** Passive geometry only; the sibling hit surface handles bounded hole selection. */
export function BreadboardOverlay({
  calibration,
  rails,
  selected,
  anchors,
  anchorLabels,
  activeAnchor,
  image,
}: {
  calibration: Calibration | null;
  rails: Rail[];
  selected: HoleSelection | null;
  anchors: Point[];
  anchorLabels?: string[];
  activeAnchor?: number | null;
  image: { width: number; height: number };
}) {
  const polygon = (points: Point[]) =>
    points
      .map((point) => {
        const p = project(calibration!, point);
        return `${p.x},${p.y}`;
      })
      .join(" ");
  return (
    <svg
      className="breadboard-overlay"
      viewBox={`0 0 ${image.width} ${image.height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Calibrated terminal strips, center gap, and registered rail holes"
    >
      {calibration && (
        <>
          {[
            [-0.3, 4.3],
            [6.7, 11.3],
          ].map(([left, right], i) => (
            <polygon
              key={left}
              className={`terminal-strip strip-${i}`}
              points={polygon([
                { x: left, y: -0.3 },
                { x: right, y: -0.3 },
                { x: right, y: calibration.rows - 0.7 },
                { x: left, y: calibration.rows - 0.7 },
              ])}
            />
          ))}
          <polygon
            className="center-gap"
            points={polygon([
              { x: 4.4, y: 0 },
              { x: 6.6, y: 0 },
              { x: 6.6, y: calibration.rows - 1 },
              { x: 4.4, y: calibration.rows - 1 },
            ])}
          />
          {allHoles(calibration, rails).map((hole) => {
            const p = project(calibration, hole.grid);
            const neighbor = project(calibration, {
              x: hole.grid.x + 0.14,
              y: hole.grid.y,
            });
            const radius = Math.max(
              1,
              Math.min(8, Math.hypot(neighbor.x - p.x, neighbor.y - p.y)),
            );
            const inGroup =
              selected?.electricalGroup != null &&
              selected.electricalGroup === hole.electricalGroup;
            return (
              <circle
                key={hole.id}
                cx={p.x}
                cy={p.y}
                r={radius}
                className={`grid-hole ${hole.kind} ${inGroup ? "same-group" : ""} ${selected?.hole === hole.id ? "picked-hole" : ""}`}
              >
                <title>{hole.id}</title>
              </circle>
            );
          })}
          {[
            "a1",
            "e1",
            "f1",
            "j1",
            `a${calibration.rows}`,
            `j${calibration.rows}`,
          ].map((id) => {
            const hole = allHoles(calibration, []).find(
              (hole) => hole.id === id,
            )!;
            const p = project(calibration, hole.grid);
            return (
              <text key={id} x={p.x} y={p.y - 8} className="grid-label">
                {id}
              </text>
            );
          })}
        </>
      )}
      {anchors.map((p, index) => (
        <g key={index}>
          <circle
            cx={p.x}
            cy={p.y}
            r="5"
            className={`anchor-point ${activeAnchor === index ? "active-anchor" : ""}`}
          />
          <text x={p.x + 8} y={p.y - 8} className="grid-label">
            {anchorLabels?.[index] ?? index + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}
