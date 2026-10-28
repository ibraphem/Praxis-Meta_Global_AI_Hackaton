import type { Analysis } from "@/lib/vision";
import { Icon } from "./icons";

/** Unresolved SAM regions are observations, never additional physical-board counts. */
export function unresolvedBoards(result: Analysis) {
  const ids = new Set(result.breadboardAudit?.unresolvedCandidateIds ?? []);
  return result.breadboardAudit?.candidates.filter((c) => ids.has(c.id)) ?? [];
}
export function BreadboardRegions({
  result,
  selectedId,
  onSelect,
}: {
  result: Analysis;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const candidates = unresolvedBoards(result);
  if (!candidates.length) return null;
  return (
    <section
      className="wire-regions-panel"
      aria-label="Unresolved breadboard regions"
    >
      <h3>
        Unresolved board regions <span>{candidates.length}</span>
      </h3>
      <p>
        Possible whole boards or board sections. Not counted as physical
        breadboards until their grouping is clear.
      </p>
      <ul>
        {candidates.map((c, i) => (
          <li key={c.id}>
            <button
              type="button"
              className="wire-region-item"
              aria-pressed={selectedId === c.id}
              onClick={() => onSelect(c.id)}
            >
              <Icon name="breadboard" width="18" height="18" />
              <span>
                Board region {i + 1}
                <small>
                  {c.extent === "whole"
                    ? "Whole-board candidate"
                    : c.extent === "part"
                      ? "Board section"
                      : "Extent uncertain"}
                </small>
              </span>
              <span className="uncertain-label">Unresolved</span>
            </button>
            {selectedId === c.id && (
              <p className="region-explanation">
                Physical-board grouping needs review.{" "}
                {c.confidence === undefined
                  ? ""
                  : `SAM region score: ${Math.round(c.confidence * 100)}%. This is not confidence in the board count.`}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
export function BreadboardRegionOverlays({
  result,
  selectedId,
  onSelect,
}: {
  result: Analysis;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {unresolvedBoards(result).map((c, i) => (
        <button
          type="button"
          key={c.id}
          className={`bounding-box is-uncertain ${selectedId === c.id ? "is-selected" : ""}`}
          aria-label={`Inspect unresolved board region ${i + 1}`}
          aria-pressed={selectedId === c.id}
          onClick={() => onSelect(c.id)}
          style={{
            left: `${(c.bbox[0] / result.image.width) * 100}%`,
            top: `${(c.bbox[1] / result.image.height) * 100}%`,
            width: `${(c.bbox[2] / result.image.width) * 100}%`,
            height: `${(c.bbox[3] / result.image.height) * 100}%`,
            borderColor: "#a47722",
            zIndex: 101,
          }}
        >
          <span className="box-label" style={{ background: "#a47722" }}>
            Board region {i + 1}
          </span>
        </button>
      ))}
    </>
  );
}
