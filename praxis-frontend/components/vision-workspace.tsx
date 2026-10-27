"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  analysisSchema,
  categories,
  componentTypes,
  IMAGE_TYPES,
  MAX_FILE_BYTES,
  MAX_IMAGE_PIXELS,
  type Analysis,
} from "@/lib/vision";
import { Icon, PraxisMark } from "./icons";
import { ImagePreview, type Photograph } from "./image-preview";
import { ResultsPanel } from "./results-panel";
import { AnalysisError } from "./analysis-error";
import { failureSchema, type Failure } from "@/lib/diagnostics";

class AnalysisRequestError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

export function VisionWorkspace() {
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const selectionVersion = useRef(0);
  const dragDepth = useRef(0);
  const [photograph, setPhotograph] = useState<Photograph | null>(null);
  const [result, setResult] = useState<Analysis | null>(null);
  const [error, setErrorState] = useState<Failure | null>(null);
  function setError(message: string | null) {
    setErrorState(message ? { code: "CLIENT_ERROR", message } : null);
  }
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showOverlays, setShowOverlays] = useState(true);
  const [elapsed, setElapsed] = useState<number | null>(null);

  // Release blob URLs on replacement/unmount; photographs never enter browser storage.
  useEffect(
    () => () => {
      if (photograph) URL.revokeObjectURL(photograph.url);
    },
    [photograph],
  );
  useEffect(
    () => () => {
      requestRef.current?.abort();
      selectionVersion.current++;
    },
    [],
  );

  async function selectFiles(files: FileList | File[]) {
    if (files.length !== 1) {
      setError("Choose one photograph at a time.");
      return;
    }
    const file = files[0];
    if (!IMAGE_TYPES.includes(file.type)) {
      setError("Choose a JPEG, PNG, or WebP photograph.");
      return;
    }
    if (!file.size || file.size > MAX_FILE_BYTES) {
      setError("Choose a non-empty photograph under 8 MB.");
      return;
    }
    requestRef.current?.abort();
    requestRef.current = null;
    setLoading(false);
    const version = ++selectionVersion.current;
    setSelecting(true);
    setError(null);
    const url = URL.createObjectURL(file);
    try {
      const image = new window.Image();
      image.src = url;
      await image.decode();
      if (version !== selectionVersion.current) {
        URL.revokeObjectURL(url);
        return;
      }
      if (image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS)
        throw new Error("Use a photograph with no more than 16 megapixels.");
      setPhotograph({
        file,
        url,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      setResult(null);
      setSelectedId(null);
      setElapsed(null);
      setShowOverlays(true);
    } catch (cause) {
      URL.revokeObjectURL(url);
      if (version === selectionVersion.current)
        setError(
          cause instanceof Error && cause.message.startsWith("Use a photograph")
            ? cause.message
            : "This image could not be opened. Try another photograph.",
        );
    } finally {
      if (version === selectionVersion.current) setSelecting(false);
    }
  }

  function clear() {
    selectionVersion.current++;
    requestRef.current?.abort();
    requestRef.current = null;
    setPhotograph(null);
    setResult(null);
    setError(null);
    setLoading(false);
    setSelecting(false);
    setSelectedId(null);
    setElapsed(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function analyze() {
    if (!photograph || loading || selecting) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedId(null);
    setElapsed(null);
    const started = performance.now();
    try {
      const body = new FormData();
      body.set("image", photograph.file);
      const response = await fetch("/api/vision/analyze", {
        method: "POST",
        body,
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (requestRef.current !== controller) return;
      if (!response.ok) {
        // The same-origin proxy returns curated error messages, never provider text.
        const parsed = failureSchema.safeParse(payload);
        if (parsed.success) throw new AnalysisRequestError(parsed.data.error);
        throw new Error("Analysis could not be completed. Please try again.");
      }
      const parsed = analysisSchema.safeParse(payload);
      if (!parsed.success)
        throw new Error(
          "The analysis result could not be read. Please try again.",
        );
      setResult(parsed.data);
      setElapsed((performance.now() - started) / 1000);
      setSelectedId(
        parsed.data.objects[0]?.id ?? parsed.data.proposals?.[0]?.id ?? null,
      );
    } catch (cause) {
      if (!controller.signal.aborted && requestRef.current === controller) {
        if (cause instanceof AnalysisRequestError) setErrorState(cause.failure);
        else
          setError(
            cause instanceof Error &&
              !(cause instanceof TypeError) &&
              !(cause instanceof SyntaxError)
              ? cause.message
              : "The connection was interrupted. Please try again.",
          );
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }

  function onDragEnter(event: DragEvent) {
    event.preventDefault();
    if (!event.dataTransfer.types.includes("Files")) return;
    dragDepth.current++;
    setDragging(true);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="Praxis home">
          <PraxisMark />
          <span>
            praxis<span className="brand-period">.</span>
          </span>
        </a>
        <div className="header-divider" />
        <span className="header-context">
          Your hands. A little more insight.
        </span>
        <div className="header-mode">
          <span className="status-dot" />
          Vision workspace<span className="version-tag mono">V0.1</span>
        </div>
      </header>
      <main className="main-content">
        <div className="page-intro">
          <div>
            <div className="intro-eyebrow">
              <span className="step-number mono">01</span>
              <span>PERCEPTION</span>
              <span className="eyebrow-line" />
            </div>
            <h1>
              Let’s see what you’re working on<span>.</span>
            </h1>
            <p>Upload your workspace. Find the parts. Get a clearer picture.</p>
          </div>
          <div className="intro-note">
            <Icon name="scan" width="21" height="21" />
            <div>
              One photograph.
              <br />
              <strong>Four kinds of possibility.</strong>
            </div>
          </div>
        </div>
        <div className="workspace-layout">
          <section
            className="workspace-panel"
            aria-label="Photograph workspace"
          >
            <div className="workspace-toolbar">
              <div className="toolbar-title">
                <Icon name="image" width="17" height="17" />
                <h2>Workspace</h2>
                <span className="toolbar-slash">/</span>
                <span>Still image</span>
              </div>
              <span className={`state-badge ${loading ? "is-loading" : ""}`}>
                {loading
                  ? "Analyzing"
                  : result
                    ? "Analyzed"
                    : photograph
                      ? "Ready to analyze"
                      : "No image added"}
              </span>
            </div>
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              tabIndex={-1}
              aria-label="Upload a workspace photograph"
              onChange={(event) => {
                if (event.target.files?.length)
                  void selectFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div
              className="drop-surface"
              onDragEnter={onDragEnter}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (!dragDepth.current) setDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                dragDepth.current = 0;
                setDragging(false);
                if (event.dataTransfer.files.length)
                  void selectFiles(event.dataTransfer.files);
              }}
            >
              <ImagePreview
                photograph={photograph}
                result={result}
                loading={loading}
                selecting={selecting}
                dragging={dragging}
                showOverlays={showOverlays}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onChoose={() => inputRef.current?.click()}
              />
            </div>
            {error && (
              <AnalysisError failure={error} onDismiss={() => setError(null)} />
            )}
            <div className="workspace-actions">
              <div className="secondary-actions">
                {photograph ? (
                  <>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => inputRef.current?.click()}
                      disabled={selecting}
                    >
                      <Icon name="upload" width="15" height="15" />
                      Replace photo
                    </button>
                    <button
                      type="button"
                      className="icon-button clear-button"
                      onClick={clear}
                      aria-label="Remove photograph"
                    >
                      <Icon name="close" width="17" height="17" />
                    </button>
                  </>
                ) : (
                  <span className="action-hint">
                    <Icon name="info" width="15" height="15" />A clear overhead
                    photo works best.
                  </span>
                )}
              </div>
              {loading ? (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    requestRef.current?.abort();
                    requestRef.current = null;
                    setLoading(false);
                  }}
                >
                  Cancel analysis
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void analyze()}
                  disabled={!photograph || selecting}
                >
                  <Icon name="scan" width="17" height="17" />
                  {result ? "Analyze again" : "Analyze image"}
                  <Icon name="arrow" width="17" height="17" />
                </button>
              )}
            </div>
            <div className="workspace-bottom">
              <span>
                <span className="mini-dot" />
                {photograph
                  ? `${(photograph.file.size / 1024 / 1024).toFixed(2)} MB · Original resolution`
                  : "YOUR PHOTO IS SENT ONLY WHEN YOU ANALYZE"}
              </span>
              {result && (
                <button
                  type="button"
                  className="overlay-toggle"
                  aria-pressed={showOverlays}
                  onClick={() => setShowOverlays(!showOverlays)}
                >
                  <Icon name="eye" width="14" height="14" />
                  {showOverlays ? "Hide" : "Show"} overlays
                </button>
              )}
            </div>
          </section>
          <ResultsPanel
            result={result}
            loading={loading}
            selectedId={selectedId}
            onSelect={setSelectedId}
            elapsed={elapsed}
          />
        </div>
        <div className="under-workspace">
          <div className="supported-components">
            <span>LOOKING FOR</span>
            {componentTypes.map((type) => (
              <span key={type}>
                <Icon name={type} width="16" height="16" />
                {categories[type].label}
              </span>
            ))}
          </div>
          <p>Good light. Visible parts. Hands out of frame.</p>
        </div>
        {result && (
          <details className="response-inspector">
            <summary>
              <Icon name="code" width="17" height="17" />
              <span>Inspect response JSON</span>
              <span className="mono">
                {result.provenance.mode === "combined" ? "SAM + MUSE" : "MUSE"}
              </span>
              <span className="details-chevron">⌄</span>
            </summary>
            <div className="response-models">
              {result.provenance.segmentationModel && (
                <span>Segmentation: {result.provenance.segmentationModel}</span>
              )}
              <span>Interpretation: {result.provenance.reasoningModel}</span>
            </div>
            <pre tabIndex={0}>{JSON.stringify(result, null, 2)}</pre>
          </details>
        )}
        <p className="sr-status" role="status" aria-live="polite">
          {loading
            ? "Analyzing your photograph."
            : result
              ? `Analysis complete. ${result.objects.length} component candidates. ${result.proposals?.length ?? 0} unresolved wire regions.`
              : photograph
                ? "Photograph ready to analyze."
                : "Choose a photograph to get started."}
        </p>
        <footer className="app-footer">
          <span>Built for the work in front of you.</span>
          <span className="mono">PRAXIS / SEE FIRST, BUILD NEXT</span>
        </footer>
      </main>
    </div>
  );
}
