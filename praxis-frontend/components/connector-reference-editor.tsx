"use client";
import { useEffect, useRef, useState } from "react";
import styles from "./connector-reference-editor.module.css";
import {
  annotationContentSchema,
  connectorAnnotationViewSchema,
  type AnnotationContent,
} from "@/lib/connector-validation";
const names = ["connector", "redWire", "blackWire", "uncertain"] as const;
const colors = [
  [0, 0, 0, 0],
  [120, 60, 230, 150],
  [240, 50, 50, 160],
  [30, 120, 240, 160],
  [250, 180, 20, 170],
];
interface Draft {
  revision: number;
  updatedAt: number;
  image: { width: number; height: number };
  content: AnnotationContent;
}
interface View {
  draft: Draft;
  imageUrl: string;
  references: Array<{
    annotationVersion: number;
    frozenAt: number;
    independent: boolean;
    source?: string;
    predictionExposure?: string;
    referenceHash: string;
  }>;
}
export function ConnectorReferenceEditor({
  analysisId,
  workflowId,
}: {
  analysisId: string;
  workflowId: string;
}) {
  const [view, setView] = useState<View | null>(null),
    [content, setContent] = useState<AnnotationContent | null>(null),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [dirty, setDirty] = useState(false),
    [locked, setLocked] = useState(false);
  const [tool, setTool] = useState(1),
    [brush, setBrush] = useState(3),
    [zoom, setZoom] = useState(1),
    [pixels, setPixels] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null),
    raster = useRef<Uint8Array>(new Uint8Array()),
    previous = useRef<[number, number] | null>(null),
    undo = useRef<Uint8Array[]>([]);
  const endpoint = `/api/analyses/${analysisId}`;
  function render() {
    if (!canvas.current || !view) return;
    const ctx = canvas.current.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(
      view.draft.image.width,
      view.draft.image.height,
    );
    for (let i = 0; i < raster.current.length; i++)
      image.data.set(colors[raster.current[i]!]!, i * 4);
    ctx.putImageData(image, 0, 0);
  }
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`${endpoint}/connector-annotation?workflowId=${workflowId}`, {
      signal: abort.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok)
          throw Error("Could not load the reference workspace.");
        const next = connectorAnnotationViewSchema.parse(
          await response.json(),
        ) as View;
        annotationContentSchema.parse(next.draft.content);
        const { width, height } = next.draft.image;
        if (
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width * height > 4000000
        )
          throw Error("Invalid source dimensions.");
        const data = new Uint8Array(width * height);
        names.forEach((name, index) =>
          next.draft.content.regions[name].forEach(([y, x, end]) =>
            data.fill(index + 1, y * width + x, y * width + end),
          ),
        );
        raster.current = data;
        setView(next);
        setContent(next.draft.content);
        setPixels(data.reduce((n, v) => n + (v ? 1 : 0), 0));
        setLocked(
          next.references.some((r) => r.frozenAt >= next.draft.updatedAt),
        );
        const image = new Image();
        image.onload = () => {
          if (image.naturalWidth !== width || image.naturalHeight !== height) {
            setError(
              "Source orientation/dimensions do not match the annotation coordinates.",
            );
            return;
          }
          setReady(true);
        };
        image.onerror = () =>
          setError("The original photograph could not be loaded.");
        image.src = next.imageUrl;
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "Load failed.");
      });
    return () => abort.abort();
  }, [endpoint, workflowId]);
  useEffect(() => {
    render();
  });
  function coordinates(
    event: React.PointerEvent<HTMLCanvasElement>,
  ): [number, number] {
    const rect = event.currentTarget.getBoundingClientRect(),
      { width, height } = view!.draft.image;
    return [
      Math.max(
        0,
        Math.min(
          width - 1,
          Math.floor(((event.clientX - rect.left) * width) / rect.width),
        ),
      ),
      Math.max(
        0,
        Math.min(
          height - 1,
          Math.floor(((event.clientY - rect.top) * height) / rect.height),
        ),
      ),
    ];
  }
  function paint(point: [number, number]) {
    if (!view || !ready || locked) return;
    const { width, height } = view.draft.image,
      from = previous.current ?? point,
      steps = Math.max(
        1,
        Math.abs(point[0] - from[0]),
        Math.abs(point[1] - from[1]),
      );
    for (let step = 0; step <= steps; step++) {
      const cx = Math.round(from[0] + ((point[0] - from[0]) * step) / steps),
        cy = Math.round(from[1] + ((point[1] - from[1]) * step) / steps);
      for (
        let y = Math.max(0, cy - brush);
        y < Math.min(height, cy + brush + 1);
        y++
      )
        for (
          let x = Math.max(0, cx - brush);
          x < Math.min(width, cx + brush + 1);
          x++
        )
          if ((x - cx) ** 2 + (y - cy) ** 2 <= brush ** 2)
            raster.current[y * width + x] = tool;
    }
    previous.current = point;
    setDirty(true);
    setPixels(raster.current.reduce((n, v) => n + (v ? 1 : 0), 0));
    render();
  }
  function encodedContent() {
    const regions: AnnotationContent["regions"] = {
        connector: [],
        redWire: [],
        blackWire: [],
        uncertain: [],
      },
      { width, height } = view!.draft.image;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width;) {
        const label = raster.current[y * width + x]!;
        if (!label) {
          x++;
          continue;
        }
        const start = x;
        while (x < width && raster.current[y * width + x] === label) x++;
        regions[names[label - 1]!].push([y, start, x]);
      }
    return { ...content!, regions };
  }
  async function action(kind: "save" | "freeze") {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch(`${endpoint}/${kind}-connector-reference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId,
          revision: view!.draft.revision,
          ...(kind === "save" ? { content: encodedContent() } : {}),
        }),
      });
      if (!response.ok)
        throw Error(
          kind === "save"
            ? "Save rejected. Reload if another reviewer changed the draft."
            : "Freeze rejected. Save first and label the connector and both visible wires.",
        );
      const next = connectorAnnotationViewSchema.parse(
        await response.json(),
      ) as View;
      setView(next);
      setContent(next.draft.content);
      setDirty(false);
      if (kind === "freeze") setLocked(true);
      setStatus(
        kind === "save"
          ? "Draft saved. No inference sent."
          : "Reference frozen as a new immutable version. No prediction was used or displayed by this workspace.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  function field<K extends keyof AnnotationContent>(
    key: K,
    value: AnnotationContent[K],
  ) {
    setContent({ ...content!, [key]: value });
    setDirty(true);
  }
  if (!view || !content)
    return (
      <main style={{ padding: 32 }}>
        <h1>Connector reference annotation</h1>
        <p>{error || "Loading original photograph…"}</p>
      </main>
    );
  return (
    <main className={styles.workspace}>
      <h1>Connector reference annotation</h1>
      <p>
        Draw the visible connector body and its red and black insulated wires
        from the original photograph. This page does not load prediction masks.
        Mark disputed or occluded pixels uncertain; do not infer hidden
        contacts.
      </p>
      <p>
        Coordinates: {view.draft.image.width} × {view.draft.image.height},
        original display pixels. Draft revision {view.draft.revision}. Painted
        pixels: {pixels}.
      </p>
      <fieldset disabled={busy || locked}>
        <legend>Paint reference pixels</legend>
        <label>
          Region{" "}
          <select
            aria-label="Annotation region"
            value={tool}
            onChange={(e) => setTool(Number(e.target.value))}
          >
            <option value={1}>Connector body (purple)</option>
            <option value={2}>Red wire</option>
            <option value={3}>Black wire (blue)</option>
            <option value={4}>Uncertain (yellow)</option>
            <option value={0}>Erase</option>
          </select>
        </label>{" "}
        <label>
          Brush radius{" "}
          <input
            aria-label="Brush radius"
            type="number"
            min={1}
            max={30}
            value={brush}
            onChange={(e) =>
              setBrush(Math.max(1, Math.min(30, Number(e.target.value) || 1)))
            }
          />
        </label>{" "}
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            const last = undo.current.pop();
            if (last) {
              raster.current = last;
              setDirty(true);
              setPixels(last.reduce((n, v) => n + (v ? 1 : 0), 0));
              render();
            }
          }}
        >
          Undo stroke
        </button>
      </fieldset>
      <label className={styles.zoom}>
        Zoom{" "}
        <select
          aria-label="Annotation zoom"
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
        >
          <option value={0.5}>50%</option>
          <option value={1}>100%</option>
          <option value={2}>200%</option>
          <option value={4}>400%</option>
        </select>
      </label>
      <div
        style={{
          overflow: "auto",
          maxHeight: "75vh",
          maxWidth: "100%",
          border: "1px solid #999",
        }}
      >
        <canvas
          ref={canvas}
          aria-label="Original photograph annotation canvas"
          width={view.draft.image.width}
          height={view.draft.image.height}
          style={{
            display: "block",
            width: view.draft.image.width * zoom,
            height: view.draft.image.height * zoom,
            backgroundImage: `url(${view.imageUrl})`,
            backgroundSize: "100% 100%",
            touchAction: "none",
            cursor: locked ? "default" : "crosshair",
          }}
          onPointerDown={(e) => {
            if (!ready || locked) return;
            undo.current.push(raster.current.slice());
            if (undo.current.length > 20) undo.current.shift();
            e.currentTarget.setPointerCapture(e.pointerId);
            previous.current = null;
            paint(coordinates(e));
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1 && previous.current) paint(coordinates(e));
          }}
          onPointerUp={() => {
            previous.current = null;
          }}
          onPointerCancel={() => {
            previous.current = null;
          }}
        />
      </div>
      <fieldset disabled={busy || locked}>
        <legend>Human reference provenance</legend>
        <label>
          Reviewer label{" "}
          <input
            aria-label="Reference reviewer"
            value={content.reviewer}
            onChange={(e) => field("reviewer", e.target.value)}
          />
        </label>
        <label>
          Prior prediction exposure{" "}
          <select
            aria-label="Prediction exposure"
            value={content.predictionExposure}
            onChange={(e) =>
              field(
                "predictionExposure",
                e.target.value as AnnotationContent["predictionExposure"],
              )
            }
          >
            <option value="unknown">Unknown / not declared</option>
            <option value="never_seen">
              I have never seen the prediction mask
            </option>
            <option value="seen_before">
              I have already seen the prediction mask
            </option>
          </select>
        </label>
        <label>
          Boundary definition{" "}
          <textarea
            aria-label="Boundary definition"
            value={content.boundaryDefinition}
            onChange={(e) => field("boundaryDefinition", e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={content.originalImageOnly}
            onChange={(e) => field("originalImageOnly", e.target.checked)}
          />
          I annotated from the original photograph without tracing a prediction.
        </label>
        <label>
          <input
            type="checkbox"
            checked={content.independentAttestation}
            onChange={(e) => field("independentAttestation", e.target.checked)}
          />
          I attest that this is my independently authored human pixel reference.
        </label>
        <p>
          Prior exposure is recorded honestly. A seen-before or unknown
          reference remains non-blinded/provisional even when independently
          drawn.
        </p>
      </fieldset>
      <button
        type="button"
        className="button button-secondary"
        disabled={busy || locked || !ready || !dirty}
        onClick={() => void action("save")}
      >
        Save annotation draft
      </button>{" "}
      <button
        type="button"
        className="button button-primary"
        disabled={busy || locked || dirty || !view.draft.revision}
        onClick={() => void action("freeze")}
      >
        Freeze reference version
      </button>
      {locked && (
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            setLocked(false);
            setContent({
              ...content,
              predictionExposure: "unknown",
              independentAttestation: false,
              originalImageOnly: false,
            });
            setDirty(true);
          }}
        >
          Start a new reference version
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <ul>
        {view.references.map((r) => (
          <li key={r.referenceHash}>
            Version {r.annotationVersion}:{" "}
            {r.independent
              ? "blinded independent human reference (attested)"
              : r.source === "human_review" &&
                  r.predictionExposure === "seen_before"
                ? "non-blinded human reference"
                : "provisional reference awaiting independent review"}{" "}
            · {r.referenceHash}
          </li>
        ))}
      </ul>
      <a href={`/?analysis=${analysisId}`}>
        Return to workspace to evaluate the saved mask (will expose predictions)
      </a>
    </main>
  );
}
