"use client";
import { WireOverlays } from "./wire-overlays";
import { componentLabel, type Analysis } from "@/lib/vision";
/** A projection of the last captured observations, never per-frame recognition. */
export function CameraEvidenceOverlays({
  result,
  selected,
  onSelect,
  onHover,
  wireId,
  status,
}: {
  result: Analysis;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  wireId: string;
  status: "fault" | "restored" | null;
}) {
  return (
    <div
      className="camera-evidence-overlays"
      aria-label="Last-scan detection overlays"
    >
      <WireOverlays
        result={result}
        selectedId={selected}
        onSelect={onSelect}
        onHover={onHover ?? onSelect}
        wireAssessment={status ? { id: wireId, status } : null}
      />
      {result.objects
        .filter((o) => o.type !== "jumper_wire")
        .map((o) => (
          <div
            className="camera-object-box"
            key={o.id}
            style={{
              left: `${(100 * o.bbox[0]) / result.image.width}%`,
              top: `${(100 * o.bbox[1]) / result.image.height}%`,
              width: `${(100 * o.bbox[2]) / result.image.width}%`,
              height: `${(100 * o.bbox[3]) / result.image.height}%`,
            }}
          >
            <span>{componentLabel(o)} · candidate</span>
          </div>
        ))}
    </div>
  );
}
