import type { Rows } from "@/lib/breadboard/calibration";
import { referenceNames } from "@/lib/breadboard/references";

/** A template diagram, never an inferred annotation of the uploaded photograph. */
export function CalibrationGuide({
  rows,
  active,
}: {
  rows: Rows;
  active: number | null;
}) {
  const names = referenceNames(rows);
  const corners = [
    [55, 36],
    [215, 36],
    [215, 134],
    [55, 134],
  ];
  return (
    <div className="calibration-guide">
      <svg
        viewBox="0 0 270 166"
        role="img"
        aria-label={`Reference diagram: a1 and j1 at row 1, j${rows} and a${rows} at row ${rows}. Select terminal holes, not power rails.`}
      >
        <rect
          x="39"
          y="25"
          width="86"
          height="120"
          rx="4"
          className="guide-strip"
        />
        <rect
          x="145"
          y="25"
          width="86"
          height="120"
          rx="4"
          className="guide-strip"
        />
        <path d="M135 30V142" className="guide-gap" />
        {Array.from({ length: 10 }, (_, col) =>
          [36, 51, 66, 104, 119, 134].map((y) => (
            <circle
              key={`${col}-${y}`}
              cx={55 + (col < 5 ? col : col + 2) * (160 / 11)}
              cy={y}
              r="2"
              fill="#61777a"
            />
          )),
        )}
        {corners.map(([x, y], index) => (
          <g
            key={names[index]}
            className={active === index ? "guide-active" : ""}
          >
            <circle cx={x} cy={y} r="5" className="guide-reference" />
            <text
              x={index === 0 || index === 3 ? x - 9 : x + 9}
              y={y + (index < 2 ? -13 : 23)}
              textAnchor={index === 0 || index === 3 ? "end" : "start"}
              className="guide-label"
            >
              {names[index]}
            </text>
          </g>
        ))}
        <text x="134" y="86" textAnchor="middle" className="guide-small">
          gap
        </text>
      </svg>
      <p>
        Four outer <strong>terminal hole centers</strong>. Match the printed
        labels on your photo, even if the board is rotated. The rails and
        plastic corners are outside this reference grid.
      </p>
    </div>
  );
}
