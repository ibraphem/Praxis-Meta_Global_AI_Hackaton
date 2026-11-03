import type { CSSProperties } from "react";
import { categories, componentLabel, type Analysis } from "@/lib/vision";
import { regionLabel } from "@/lib/geometry";

/** Wire interaction follows painted mask geometry; broad regions expose labels only. */
export function WireOverlays({
  result,
  selectedId,
  onSelect,
  onHover,
  wireAssessment,
}: {
  result: Analysis;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onHover?: (id: string | null) => void;
  wireAssessment?: { id: string; status: "fault" | "restored" } | null;
}) {
  const wires = result.objects.filter(
    (object) => object.type === "jumper_wire" && object.mask,
  );
  const color = categories.jumper_wire.color;
  return (
    <>
      <svg
        className="wire-mask-layer"
        viewBox={`0 0 ${result.image.width} ${result.image.height}`}
        preserveAspectRatio="none"
        aria-label="Segmented wire candidates"
      >
        {wires.map((object) => (
          <g
            key={object.id}
            transform={`translate(${object.bbox[0]} ${object.bbox[1]}) scale(${object.bbox[2] / object.mask!.width} ${object.bbox[3] / object.mask!.height})`}
          >
            <path
              d={object.mask!.path}
              role="button"
              tabIndex={0}
              aria-label={`Inspect ${componentLabel(object)} mask`}
              aria-pressed={selectedId === object.id}
              className={`wire-mask ${selectedId === object.id ? "selected" : ""} ${object.interpretation === "uncertain" ? "uncertain" : ""}`}
              fill={
                wireAssessment?.id === object.id
                  ? wireAssessment.status === "fault"
                    ? "#c43a35"
                    : "#278066"
                  : color
              }
              stroke={
                wireAssessment?.id === object.id
                  ? wireAssessment.status === "fault"
                    ? "#c43a35"
                    : "#278066"
                  : color
              }
              style={
                wireAssessment?.id === object.id &&
                wireAssessment.status === "fault"
                  ? {
                      animation: "camera-fault-pulse 1.2s ease-in-out infinite",
                    }
                  : undefined
              }
              fillRule="evenodd"
              vectorEffect="non-scaling-stroke"
              onMouseEnter={() => onHover?.(object.id)}
              onMouseLeave={() => onHover?.(null)}
              onFocus={() => onHover?.(object.id)}
              onBlur={() => onHover?.(null)}
              onClick={() => onSelect(object.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(object.id);
                }
              }}
            >
              <title>{`${componentLabel(object)} — geometry candidate; identity unverified`}</title>
            </path>
          </g>
        ))}
      </svg>
      {wires.map((object) => (
        <button
          type="button"
          className="wire-mask-label"
          key={object.id}
          onClick={() => onSelect(object.id)}
          aria-pressed={selectedId === object.id}
          aria-label={`Inspect ${componentLabel(object)}`}
          style={{
            left: `${(object.bbox[0] / result.image.width) * 100}%`,
            top: `${Math.max(0, (object.bbox[1] / result.image.height) * 100)}%`,
            background: color,
          }}
        >
          {componentLabel(object)}
        </button>
      ))}
      {(result.proposals ?? []).map((region) => (
        <div
          className={`wire-region-box ${selectedId === region.id ? "selected" : ""}`}
          key={region.id}
          style={
            {
              left: `${(region.bbox[0] / result.image.width) * 100}%`,
              top: `${(region.bbox[1] / result.image.height) * 100}%`,
              width: `${(region.bbox[2] / result.image.width) * 100}%`,
              height: `${(region.bbox[3] / result.image.height) * 100}%`,
            } as CSSProperties
          }
        >
          <button
            type="button"
            className="wire-region-label"
            onClick={() => onSelect(region.id)}
            aria-pressed={selectedId === region.id}
          >
            {regionLabel(region.id)}
          </button>
        </div>
      ))}
    </>
  );
}
