import type { CSSProperties } from "react";
import {
  categories,
  componentLabel,
  componentTypes,
  type Analysis,
} from "@/lib/vision";
import { Icon } from "./icons";
import { regionLabel, regionExplanations } from "@/lib/geometry";
import { BreadboardRegions } from "./breadboard-regions";

interface Props {
  result: Analysis | null;
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  elapsed: number | null;
}

/** Results and overlays share IDs, so inspection never relies on array order. */
export function ResultsPanel({
  result,
  loading,
  selectedId,
  onSelect,
  elapsed,
}: Props) {
  return (
    <aside
      className="results-panel"
      aria-label="Analysis results"
      aria-busy={loading}
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">SCENE UNDERSTANDING</span>
          <h2>What Praxis sees</h2>
        </div>
        <span className="object-count">
          {result ? result.objects.length.toString().padStart(2, "0") : "—"}
        </span>
      </div>
      <div className="category-summary">
        {componentTypes.map((type) => (
          <div key={type} className="category-count">
            <span
              className="category-dot"
              style={{ background: categories[type].color }}
            />
            <span>
              {type === "breadboard" && result?.provenance.mode === "sam-only"
                ? "Board regions — unverified"
                : type === "jumper_wire"
                  ? "Wire candidates"
                  : categories[type].plural}
            </span>
            <span className="mono">
              {result
                ? result.objects.filter((object) => object.type === type).length
                : "—"}
            </span>
          </div>
        ))}
      </div>
      <div className="detection-area">
        {loading ? (
          <div className="results-empty">
            <span className="spinner large-spinner" />
            <h3>Taking a closer look</h3>
            <p>Finding visible components and interpreting the scene.</p>
            <span className="waiting-note">
              Model calls can take a few minutes.
            </span>
          </div>
        ) : !result ? (
          <div className="results-empty">
            <div className="empty-results-icon">
              <Icon name="scan" width="27" height="27" />
            </div>
            <h3>A little context goes a long way.</h3>
            <p>
              Add a clear photo of your workspace. Your components will appear
              here.
            </p>
          </div>
        ) : result.objects.length === 0 ? (
          <div className="results-empty">
            <div className="empty-results-icon">
              <Icon name="eye" width="27" height="27" />
            </div>
            <h3>
              {result.breadboardAudit?.unresolvedCandidateIds.length
                ? "Board regions need a closer look"
                : result.proposals?.length
                  ? "Wire regions need a closer look"
                  : "No components identified"}
            </h3>
            <p>
              Try a closer, well-lit photo with the components unobstructed. An
              empty result does not prove they are absent.
            </p>
          </div>
        ) : (
          <>
            <div className="list-heading">
              <span>
                {result.provenance.mode === "sam-only"
                  ? "SAM CANDIDATES — UNVERIFIED"
                  : "VISIBLE COMPONENTS"}
              </span>
              <span>SELECT TO INSPECT</span>
            </div>
            <ul className="detection-list">
              {result.objects.map((object) => (
                <li key={object.id}>
                  <button
                    type="button"
                    className={`detection-item ${selectedId === object.id ? "selected" : ""}`}
                    aria-pressed={selectedId === object.id}
                    onClick={() => onSelect(object.id)}
                    style={
                      {
                        "--component-color": categories[object.type].color,
                      } as CSSProperties
                    }
                  >
                    <span className="component-icon">
                      <Icon name={object.type} width="22" height="22" />
                    </span>
                    <span className="detection-details">
                      <span className="detection-name">
                        {object.reviewStatus === "sam_unverified" &&
                        object.type === "breadboard"
                          ? `SAM board region ${object.id.split("_").at(-1)}`
                          : componentLabel(object)}
                        {object.interpretation === "uncertain" && (
                          <span className="uncertain-label">Uncertain</span>
                        )}
                      </span>
                      <span className="detection-description">
                        {object.color
                          ? `${object.color.charAt(0).toUpperCase()}${object.color.slice(1)} · `
                          : ""}
                        {object.type === "jumper_wire"
                          ? "Segmented mask"
                          : `${object.bbox[2]} × ${object.bbox[3]} px`}
                        {object.detectionSource === "muse"
                          ? " · Recovered candidate"
                          : ""}
                        {object.breadboardGrouping
                          ? object.breadboardGrouping.geometrySource ===
                            "candidate_union"
                            ? " · Grouped SAM regions"
                            : " · Whole-board SAM region"
                          : ""}
                      </span>
                    </span>
                    <span className="detection-score mono">
                      {object.confidence === undefined
                        ? "—"
                        : `${Math.round(object.confidence * 100)}%`}
                      <span>
                        {object.localizationSource === "derived"
                          ? "DERIVED BOX"
                          : object.localizationSource === "muse"
                            ? "MUSE ESTIMATE"
                            : "SAM SCORE"}
                      </span>
                    </span>
                  </button>
                  {selectedId === object.id && (
                    <div className="coordinate-detail">
                      <span>POSITION</span>
                      <code>
                        x {object.bbox[0]} · y {object.bbox[1]}
                      </code>
                      <span>
                        {object.type === "jumper_wire"
                          ? "Identity unverified"
                          : object.interpretation === "uncertain"
                            ? "Needs a closer look"
                            : "Visually identified"}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {result && (
        <BreadboardRegions
          result={result}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}
      {!!result?.proposals?.length && (
        <section
          className="wire-regions-panel"
          aria-label="Unresolved wire regions"
        >
          <h3>
            Unresolved regions <span>{result.proposals.length}</span>
          </h3>
          <p>
            Possible wires, not counted as individual components. A region can
            contain several wires.
          </p>
          <ul>
            {result.proposals.map((region) => (
              <li key={region.id}>
                <button
                  type="button"
                  onClick={() => onSelect(region.id)}
                  aria-pressed={selectedId === region.id}
                  className={`wire-region-item ${selectedId === region.id ? "selected" : ""}`}
                >
                  <Icon name="scan" width="18" height="18" />
                  <span>
                    {regionLabel(region.id)}
                    <small>
                      {region.color ? `${region.color} · ` : ""}
                      {region.refinementStatus.replaceAll("_", " ")}
                    </small>
                  </span>
                  <span className="uncertain-label">Unresolved</span>
                </button>
                {selectedId === region.id && (
                  <p className="region-explanation">
                    {regionExplanations[region.reason]}{" "}
                    {region.refinementCode ? `(${region.refinementCode})` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="results-footnote">
        <Icon name="info" width="16" height="16" />
        <p>
          Candidate geometry only. Wire identity, connectors, and electrical
          function aren’t verified. Numbers reset with each analysis.
        </p>
      </div>
      {result && (
        <div className="run-info">
          <span className="status-dot" />
          <span>
            {result.provenance.mode === "sam-only"
              ? "Segmentation only · unverified"
              : "Analysis complete"}
          </span>
          {elapsed !== null && (
            <span className="mono">{elapsed.toFixed(1)}s</span>
          )}
        </div>
      )}
    </aside>
  );
}
