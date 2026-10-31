import type { CSSProperties } from "react";
import type { AnalysisJob } from "@/lib/analysis-jobs";
import type { SceneGraph } from "@/lib/scene";

export function SceneInventoryNotRun({
  job,
  busy,
  onStart,
}: {
  job: AnalysisJob;
  busy: boolean;
  onStart: () => void;
}) {
  const ready = job.sam.status === "succeeded" && !!job.sam.snapshotRef;
  return (
    <section
      className="scene-inventory-panel"
      aria-label="Dynamic scene inventory"
    >
      <h3>Scene inventory</h3>
      <p>
        <strong>Not run for this analysis.</strong>
      </p>
      <p>
        {job.settings.dynamicScene === false
          ? "Automatic scene discovery was disabled when this photograph was uploaded. The four-category results do not include an open-vocabulary inventory."
          : "This saved analysis has no dynamic inventory. Its existing component results are preserved."}
      </p>
      <button
        type="button"
        className="button button-secondary"
        disabled={busy || !ready}
        onClick={onStart}
      >
        Discover scene objects
      </button>
      <p>
        {ready
          ? "Uses one Muse request to inspect the whole photograph. Reuses saved segmentation and displays discovered objects as boxes; no new SAM requests."
          : "Complete segmentation before discovering objects on this saved photograph."}
      </p>
    </section>
  );
}

export function SceneInventory({
  scene,
  selectedId,
  onSelect,
  onRetry,
  busy,
}: {
  scene: NonNullable<AnalysisJob["scene"]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
  busy: boolean;
}) {
  const graph = scene.graph;
  const attempt = scene.attempts.at(-1);
  const selected = graph?.objects.find((o) => o.id === selectedId);
  const associations =
    graph?.associations.filter((a) => a.objectId === selectedId) ?? [];
  return (
    <section
      className={"scene-inventory-panel"}
      aria-label="Dynamic scene inventory"
    >
      <h3>Scene inventory</h3>
      <p>
        {graph?.objects.length ?? 0} object hypotheses ·{" "}
        {scene.status.replaceAll("_", " ")}
      </p>
      <p>
        Labels and mask associations are proposals. Hypothesis counts do not
        establish distinct physical objects or electrical connections.
      </p>
      <p>
        Small objects use S markers on the photograph. Select a marker or row to
        inspect its full description and evidence.
      </p>
      {graph && (
        <ul className={"scene-inventory-list"}>
          {graph.objects.map((object, index) => (
            <li key={object.id}>
              <button
                type="button"
                className={
                  selectedId === object.id ? "scene-inventory-selected" : ""
                }
                aria-pressed={selectedId === object.id}
                onClick={() => onSelect(object.id)}
              >
                <strong>
                  S{index + 1} · {object.proposedType}
                </strong>
                <span>
                  {object.category.replaceAll("_", " ")} ·{" "}
                  {object.recognitionStatus}
                </span>
                <span>
                  {object.segmentationStatus === "candidates_returned"
                    ? "Mask candidates available"
                    : object.segmentationStatus.replaceAll("_", " ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {graph && !graph.objects.length && (
        <p>
          No scene hypotheses yet. An empty inventory does not establish that
          objects are absent.
        </p>
      )}
      {selected && graph && (
        <div
          className={"scene-inventory-evidence"}
          aria-label="Selected scene evidence"
        >
          <h4>{selected.proposedType}</h4>
          <p>
            Position: {selected.bbox.join(", ")} · original-image x, y, width,
            height.
          </p>
          <ul>
            {associations.map((a) => {
              const observation = graph.observations.find(
                (o) => o.id === a.observationId,
              )!;
              const competing = graph.associations.filter(
                (other) =>
                  other.observationId === observation.id &&
                  other.objectId !== selected.id,
              ).length;
              return (
                <li key={a.id}>
                  {observation.source.toUpperCase()} {observation.kind} ·{" "}
                  {a.basis.replaceAll("_", " ")} · {a.status}
                  {observation.kind === "mask" && !observation.mask
                    ? " · box preview; native mask saved"
                    : ""}
                  {competing
                    ? ` · ${competing} competing object associations`
                    : ""}
                  <small>Attempt {observation.attemptId}</small>
                  {observation.requestId && (
                    <small>Request {observation.requestId}</small>
                  )}
                  {observation.samSnapshotId && (
                    <small>
                      Baseline candidate {observation.sourceCandidateId} ·
                      checkpoint {observation.samSnapshotId}
                    </small>
                  )}
                </li>
              );
            })}
          </ul>
          <p>Terminals and electrical connections remain unestablished.</p>
        </div>
      )}
      {!!scene.work.length && (
        <details>
          <summary>Guided segmentation evidence</summary>
          <ul>
            {scene.work.map((work) => (
              <li key={work.requestId}>
                {work.prompt} · {work.reason.replaceAll("_", " ")} ·{" "}
                {work.status.replaceAll("_", " ")}
                {work.upstreamOutcome === "unknown"
                  ? " · provider outcome unknown"
                  : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p>
        {scene.budget.requests} guided requests ·{" "}
        {scene.budget.pixels.toLocaleString()} crop pixels charged.
      </p>
      {scene.attempts.map((a) => (
        <p key={a.attemptId}>
          {a.sceneOperation === "inventory"
            ? "Inventory"
            : a.sceneOperation === "terminals"
              ? "Terminal discovery"
              : a.sceneOperation === "reconcile"
                ? "Local reconciliation"
                : "Guided segmentation"}
          : {a.status.replaceAll("_", " ")}
          {a.startedAt && a.finishedAt
            ? ` · ${((a.finishedAt - a.startedAt) / 1000).toFixed(1)}s`
            : ""}
          {a.errorCode ? ` · ${a.errorCode}` : ""}
        </p>
      ))}
      {attempt?.retryPolicy === "manual_only" &&
        attempt.sceneOperation === "inventory" && (
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onRetry}
          >
            Retry scene inventory
          </button>
        )}
    </section>
  );
}

/** Scene inspection uses the same original image frame as calibration and wire overlays. */
export function SceneOverlays({
  graph,
  selectedId,
  onSelect = () => {},
}: {
  graph: SceneGraph;
  selectedId: string | null;
  onSelect?: (id: string) => void;
}) {
  const object = graph.objects.find((o) => o.id === selectedId);
  const ids = new Set(
    graph.associations
      .filter((a) => a.objectId === object?.id)
      .map((a) => a.observationId),
  );
  const observations = graph.observations.filter((o) => ids.has(o.id));
  const inventoryIds = new Set(
    graph.associations
      .filter((a) => a.basis === "inventory")
      .map((a) => a.objectId),
  );
  const visibleObjects = graph.objects
    .filter((o) => inventoryIds.has(o.id) || o.id === object?.id)
    .sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3]);
  if (!visibleObjects.length) return null;
  return (
    <div
      className={"scene-inventory-overlays"}
      aria-label="Scene object locations"
    >
      {visibleObjects.map((box, index) => {
        const showName =
          box.id === selectedId ||
          box.category === "power_source" ||
          (box.category === "connector" &&
            (box.bbox[2] * box.bbox[3]) /
              (graph.image.width * graph.image.height) >=
              0.005);
        return (
          <div
            key={box.id}
            className={`scene-inventory-box ${box.id === selectedId ? "is-selected" : ""}`}
            style={
              {
                left: `${(box.bbox[0] / graph.image.width) * 100}%`,
                top: `${(box.bbox[1] / graph.image.height) * 100}%`,
                width: `${(box.bbox[2] / graph.image.width) * 100}%`,
                height: `${(box.bbox[3] / graph.image.height) * 100}%`,
                zIndex: index + 1,
              } as CSSProperties
            }
          >
            <button
              type="button"
              className={`scene-inventory-label ${showName ? "" : "is-compact"}`}
              style={{
                width: "max-content",
                ...(box.bbox[0] > graph.image.width * 0.6
                  ? { left: "auto", right: 0 }
                  : {}),
              }}
              title={`${box.proposedType} — ${box.recognitionStatus}`}
              aria-label={`Inspect ${box.proposedType} scene hypothesis`}
              aria-pressed={box.id === selectedId}
              onClick={() => onSelect(box.id)}
            >
              <strong>
                {showName
                  ? box.proposedType
                  : `S${graph.objects.indexOf(box) + 1}`}
              </strong>
              {showName && <small>{box.recognitionStatus}</small>}
            </button>
          </div>
        );
      })}
      {object && (
        <div
          className="scene-inventory-selected-evidence"
          aria-label="Selected scene object locations"
        >
          {observations
            .filter((o) => o.source === "sam")
            .map((o) => (
              <div
                key={o.id}
                className="scene-inventory-box scene-inventory-evidence-box"
                style={{
                  left: `${(o.bbox[0] / graph.image.width) * 100}%`,
                  top: `${(o.bbox[1] / graph.image.height) * 100}%`,
                  width: `${(o.bbox[2] / graph.image.width) * 100}%`,
                  height: `${(o.bbox[3] / graph.image.height) * 100}%`,
                }}
              />
            ))}
          <svg
            viewBox={`0 0 ${graph.image.width} ${graph.image.height}`}
            preserveAspectRatio="none"
            aria-label="Scene mask candidates"
          >
            {observations
              .filter((o) => o.mask)
              .map((o) => (
                <g
                  key={o.id}
                  transform={`translate(${o.bbox[0]} ${o.bbox[1]}) scale(${o.bbox[2] / o.mask!.width} ${o.bbox[3] / o.mask!.height})`}
                >
                  <path
                    d={o.mask!.path}
                    fill="#8b5cf6"
                    fillOpacity="0.35"
                    fillRule="evenodd"
                  >
                    <title>{`Proposed mask association for ${object.proposedType}`}</title>
                  </path>
                </g>
              ))}
          </svg>
        </div>
      )}
    </div>
  );
}
