import type { CSSProperties } from "react";
import { categories, componentLabel, type Analysis } from "@/lib/vision";
import { Icon } from "./icons";
import { WireOverlays } from "./wire-overlays";
import { BreadboardWorkspace } from "./breadboard-workspace";
import styles from "./breadboard-workspace.module.css";
import { BreadboardRegionOverlays } from "./breadboard-regions";

export interface Photograph {
  id: string;
  file: File;
  url: string;
  width: number;
  height: number;
}
interface Props {
  photograph: Photograph | null;
  result: Analysis | null;
  loading: boolean;
  selecting: boolean;
  dragging: boolean;
  showOverlays: boolean;
  selectedId: string | null;
  analysisRunId: string | null;
  onSelect: (id: string) => void;
  onChoose: () => void;
  onRecoveryContext?: (context: {
    pitchPx: number;
    gridPoints: [number, number][];
  }) => void;
}

export function ImagePreview({
  photograph,
  result,
  loading,
  selecting,
  dragging,
  showOverlays,
  selectedId,
  analysisRunId,
  onSelect,
  onChoose,
  onRecoveryContext,
}: Props) {
  if (!photograph)
    return (
      <div className={`upload-stage ${dragging ? "is-dragging" : ""}`}>
        <div className="stage-grid" aria-hidden="true" />
        <div className="upload-target">
          <span className="target-corner top-left" />
          <span className="target-corner top-right" />
          <span className="target-corner bottom-left" />
          <span className="target-corner bottom-right" />
          <div className="upload-icon">
            <Icon name="upload" width="30" height="30" />
          </div>
          <h2>
            {selecting
              ? "Opening your photograph…"
              : dragging
                ? "Drop it here"
                : "Bring your workspace into view"}
          </h2>
          <p>
            A breadboard. A few components.
            <br />
            Start with a photograph of what’s in front of you.
          </p>
          <button
            type="button"
            className="button button-dark"
            onClick={onChoose}
            disabled={selecting}
          >
            <Icon name="image" width="17" height="17" />
            Choose a photograph
          </button>
          <span className="drop-hint">or drag and drop it here</span>
        </div>
        <div className="stage-caption">
          <span className="crosshair">+</span>
          <span>JPEG, PNG OR WEBP</span>
          <span>UP TO 8 MB · 16 MP</span>
        </div>
      </div>
    );

  const dimensionsMatch =
    !result ||
    (result.image.width === photograph.width &&
      result.image.height === photograph.height);
  return (
    <div
      className={`photo-stage ${styles.workspace} ${dragging ? "is-dragging" : ""}`}
    >
      <div className="stage-grid" aria-hidden="true" />
      <BreadboardWorkspace
        key={photograph.url}
        image={{ width: photograph.width, height: photograph.height }}
        imageUrl={photograph.url}
        imageFile={photograph.file}
        onRecoveryContext={onRecoveryContext}
        disabled={loading || selecting}
        assignmentContext={{
          photoId: photograph.id,
          analysisRunId,
          analysis: result,
        }}
        selectedWireId={selectedId}
        onSelectWire={onSelect}
        overlaysVisible={showOverlays}
      >
        {result && dimensionsMatch && showOverlays && (
          <div className="detection-overlays" aria-label="Component locations">
            {/* Keep smaller components above their enclosing breadboard. */}
            {[...result.objects]
              .filter((object) => object.type !== "jumper_wire")
              .sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3])
              .map((object, index) => {
                const [x, y, width, height] = object.bbox;
                return (
                  <button
                    type="button"
                    key={object.id}
                    aria-label={`Inspect ${componentLabel(object)}`}
                    aria-pressed={selectedId === object.id}
                    className={`bounding-box ${selectedId === object.id ? "is-selected" : ""} ${object.interpretation === "uncertain" ? "is-uncertain" : ""}`}
                    onClick={() => onSelect(object.id)}
                    style={
                      {
                        left: `${(x / result.image.width) * 100}%`,
                        top: `${(y / result.image.height) * 100}%`,
                        width: `${(width / result.image.width) * 100}%`,
                        height: `${(height / result.image.height) * 100}%`,
                        zIndex: index + 1,
                        "--component-color": categories[object.type].color,
                      } as CSSProperties
                    }
                  >
                    <span className="box-label">{componentLabel(object)}</span>
                  </button>
                );
              })}
            <WireOverlays
              result={result}
              selectedId={selectedId}
              onSelect={onSelect}
            />
            <BreadboardRegionOverlays
              result={result}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          </div>
        )}
        {loading && (
          <div className="scanning-overlay" aria-hidden="true">
            <div className="scan-line" />
            <span>
              <span className="spinner" />
              Analyzing photograph
            </span>
          </div>
        )}
      </BreadboardWorkspace>
      {dragging && (
        <div className="drop-replace">Drop to replace this photograph</div>
      )}
      {!dimensionsMatch && (
        <p className="alignment-warning" role="status">
          Image dimensions differ from the result. Overlays are hidden to avoid
          showing incorrect locations.
        </p>
      )}
      <div className="photo-caption">
        <Icon name="image" width="15" height="15" />
        <span>{photograph.file.name}</span>
        <span className="mono">
          {photograph.width} × {photograph.height}
        </span>
      </div>
    </div>
  );
}
