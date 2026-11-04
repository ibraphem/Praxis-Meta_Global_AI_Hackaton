"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseInspection,
  type CircuitInspection,
  type CircuitInput,
} from "@/lib/automatic-circuit";
import {
  allHoles,
  diagnoseHole,
  project,
  type Calibration,
  type Rail,
} from "../../praxis-backend/server/src/shared/calibration";
import { CircuitGraph } from "./circuit-graph";
import { BenchIcon } from "./bench-ui";
import "./circuit-camera.css";
import "./automatic-circuit.css";

type Observations = NonNullable<CircuitInspection["observations"]>;
type Picking =
  | { kind: "terminal"; id: string }
  | { kind: "landmark"; board: number; index: number }
  | { kind: "rail"; board: number; index: number; end: "first" | "last" };
const active = (v: CircuitInspection | null) =>
  v?.status === "queued" || v?.status === "running";
async function json(response: Response) {
  const v = await response.json();
  if (!response.ok)
    throw Error(v.error?.message ?? "Circuit inspection failed.");
  return v;
}
function holeTarget(input: CircuitInput, position: { x: number; y: number }) {
  const found = input.boards.flatMap((b) => {
    const d = diagnoseHole(
      b.calibration as Calibration,
      b.rails as Rail[],
      position,
    );
    return d.reason === "accepted" && d.candidates[0]
      ? [
          {
            kind: "hole" as const,
            boardId: b.id,
            holeId: d.candidates[0].holeId,
            calibrationRevision: b.revision,
          },
        ]
      : [];
  });
  return found.length === 1 ? found[0] : null;
}
export function AutomaticCircuitWorkspace() {
  const [view, setView] = useState<CircuitInspection | null>(null),
    [draft, setDraft] = useState<CircuitInput | null>(null),
    [observations, setObservations] = useState<Observations | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [cameraOn, setCameraOn] = useState(false),
    [photo, setPhoto] = useState<string | null>(null),
    [pending, setPending] = useState<File | null>(null);
  const [reviewer, setReviewer] = useState(""),
    [dirty, setDirty] = useState(false),
    [gridDirty, setGridDirty] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [picking, setPicking] = useState<Picking | null>(null),
    [gridVisible, setGridVisible] = useState(true);
  const video = useRef<HTMLVideoElement>(null),
    stream = useRef<MediaStream | null>(null),
    objectUrl = useRef<string | null>(null),
    mounted = useRef(true),
    generation = useRef(0),
    lock = useRef(false);
  const replacePhoto = useCallback((url: string) => {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
    setPhoto(url);
  }, []);
  const accept = useCallback(
    (v: CircuitInspection) => {
      if (!mounted.current) return;
      setView(v);
      setDraft(v.input ? structuredClone(v.input) : null);
      setObservations(v.observations ? structuredClone(v.observations) : null);
      setDirty(false);
      setGridDirty(false);
      setPicking(null);
      replacePhoto(`/api/circuit-inspections/${v.id}/image`);
      localStorage.setItem("praxis-automatic-inspection", v.id);
    },
    [replacePhoto],
  );
  const stop = useCallback(() => {
    generation.current++;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setCameraOn(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const id = localStorage.getItem("praxis-automatic-inspection");
    queueMicrotask(() => {
      if (mounted.current)
        setReviewer(localStorage.getItem("praxis-reviewer") ?? "");
    });
    if (id)
      fetch(`/api/circuit-inspections/${id}`, { cache: "no-store" })
        .then(json)
        .then((v) => {
          if (mounted.current) accept(parseInspection(v, id));
        })
        .catch(() => {});
    return () => {
      mounted.current = false;
      // Invalidate a pending getUserMedia response on unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      stream.current?.getTracks().forEach((t) => t.stop());
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, [accept]);
  useEffect(() => {
    if (!view || !active(view)) return;
    const controller = new AbortController();
    let fetching = false;
    const timer = setInterval(() => {
      if (fetching) return;
      fetching = true;
      fetch(`/api/circuit-inspections/${view.id}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(json)
        .then((v) => accept(parseInspection(v, view.id)))
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          fetching = false;
        });
    }, 1400);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [view, accept]);
  const work = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "Circuit inspection failed.");
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const start = async () => {
    stop();
    const token = generation.current;
    if (!window.isSecureContext)
      throw Error(
        "Camera access requires HTTPS on your phone. Open the deployed HTTPS app.",
      );
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error(
        "Camera access is unavailable. You can upload a photograph instead.",
      );
    const media = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "environment",
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
    });
    if (!mounted.current || generation.current !== token) {
      media.getTracks().forEach((t) => t.stop());
      return;
    }
    stream.current = media;
    if (video.current) {
      video.current.srcObject = media;
      await video.current.play();
    }
    setCameraOn(true);
  };
  const stage = (file: File) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw Error("Choose a JPEG, PNG or WebP photograph.");
    if (file.size > 8 * 1024 * 1024)
      throw Error("Choose a photograph under 8 MB.");
    const url = URL.createObjectURL(file);
    replacePhoto(url);
    objectUrl.current = url;
    stop();
    setPending(file);
    setView(null);
    setDraft(null);
    setObservations(null);
    setSelected(null);
    setPicking(null);
    setDirty(false);
    setGridDirty(false);
  };
  const capture = async () => {
    const v = video.current;
    if (!v || v.readyState < 2) throw Error("Wait for the camera image.");
    const scale = Math.min(
        1,
        Math.sqrt(16000000 / (v.videoWidth * v.videoHeight)),
      ),
      canvas = document.createElement("canvas");
    canvas.width = Math.floor(v.videoWidth * scale);
    canvas.height = Math.floor(v.videoHeight * scale);
    canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(Error("Capture failed."))),
        "image/jpeg",
        0.94,
      ),
    );
    stage(new File([blob], "circuit.jpg", { type: "image/jpeg" }));
  };
  const analyze = async () => {
    if (!pending) return;
    const form = new FormData();
    form.append("image", pending);
    const v = parseInspection(
      await json(
        await fetch("/api/circuit-inspections", { method: "POST", body: form }),
      ),
    );
    accept(v);
    setPending(null);
  };
  const edit = (fn: (v: CircuitInput) => void) => {
    if (!draft) return;
    const next = structuredClone(draft);
    fn(next);
    setDraft(next);
    setDirty(true);
  };
  const post = async (action: "review" | "calibrate", body: unknown) => {
    if (!view) return;
    const v = parseInspection(
      await json(
        await fetch(`/api/circuit-inspections/${view.id}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
      view.id,
    );
    accept(v);
  };
  const pick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!picking || !view) return;
    const rect = event.currentTarget.getBoundingClientRect(),
      position = {
        x: Math.max(
          0,
          Math.min(
            view.image.width - 1,
            ((event.clientX - rect.left) / rect.width) * view.image.width,
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            view.image.height - 1,
            ((event.clientY - rect.top) / rect.height) * view.image.height,
          ),
        ),
      };
    if (picking.kind === "terminal")
      edit((input) => {
        const t = input.terminals.find((t) => t.id === picking.id)!;
        t.position = position;
        const a = input.associations.find((a) => a.terminalId === t.id)!;
        a.target = holeTarget(input, position);
        a.type = "insertion";
        a.state = "unresolved";
      });
    else if (observations) {
      const next = structuredClone(observations);
      const normalized: [number, number] = [
        (position.x / (view.image.width - 1)) * 999,
        (position.y / (view.image.height - 1)) * 999,
      ];
      if (picking.kind === "landmark")
        next.boards[picking.board].landmarks[picking.index].position =
          normalized;
      else
        next.boards[picking.board].rails[picking.index][picking.end] =
          normalized;
      setObservations(next);
      setGridDirty(true);
    }
    setPicking(null);
  };
  const reset = () => {
    stop();
    replacePhoto("");
    setPhoto(null);
    setView(null);
    setDraft(null);
    setPending(null);
    setPicking(null);
    setError("");
    localStorage.removeItem("praxis-automatic-inspection");
  };
  const holes =
    draft?.boards.flatMap((b) =>
      allHoles(b.calibration as Calibration, b.rails as Rail[]).map((h) => ({
        board: b,
        h,
        position: project(b.calibration as Calibration, h.grid),
      })),
    ) ?? [];
  const running = active(view),
    ready = !!draft && !running && !cameraOn;
  const confirmed =
      draft?.associations.filter((a) => a.state === "confirmed_manual")
        .length ?? 0,
    total = draft?.terminals.length ?? 0;
  const targetValue = (a: CircuitInput["associations"][number]) =>
    a.target?.kind === "hole"
      ? `${a.target.boardId}/${a.target.holeId}`
      : a.target?.kind === "terminal"
        ? `terminal/${a.target.terminalId}`
        : "";
  return (
    <main className="bench-app ai-app">
      <header className="bench-header">
        <Link className="bench-brand" href="/">
          <BenchIcon name="circuit" />
          praxis<span>.</span>
        </Link>
        <span className="ai-header-label">CIRCUIT INSPECTION</span>
        <Link className="bench-link-button" href="/workspace">
          Photo workspace
        </Link>
      </header>
      <div className="ai-heading">
        <div>
          <span className="ai-eyebrow">CAPTURE · INSPECT · CONFIRM</span>
          <h1>Your circuit, mapped from the photo.</h1>
          <p>
            AI proposes the board grid and physical connections. You review the
            evidence and confirm what is connected.
          </p>
        </div>
        {view && (
          <button
            className="bench-button bench-button-quiet"
            disabled={busy || running}
            onClick={reset}
          >
            New inspection
          </button>
        )}
      </div>
      {error && (
        <div className="ai-error" role="alert">
          {error}
          <button className="bench-link-button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
      <div className="ai-layout">
        <section
          className="ai-card ai-camera-card"
          aria-label="Circuit photograph"
        >
          <div className="ai-card-heading">
            <strong>
              {cameraOn
                ? "Live camera"
                : photo
                  ? "Captured photograph"
                  : "Get a clear view"}
            </strong>
            <span>
              {view
                ? `${view.image.width} × ${view.image.height}`
                : "Full resolution"}
            </span>
          </div>
          <div className={`ai-photo ${picking ? "is-picking" : ""}`}>
            <video
              ref={video}
              muted
              playsInline
              style={{ display: cameraOn ? "block" : "none" }}
            />
            {!cameraOn && photo ? (
              <div className="ai-image-wrap">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo}
                  alt="Captured breadboard circuit for connection review"
                />
                {view && draft && (
                  <svg
                    viewBox={`0 0 ${view.image.width} ${view.image.height}`}
                    onClick={pick}
                    aria-label="Proposed grid and terminals"
                    style={{ cursor: picking ? "crosshair" : "default" }}
                  >
                    {gridVisible &&
                      holes.map(({ board, h, position }) => (
                        <circle
                          key={`${board.id}/${h.id}`}
                          cx={position.x}
                          cy={position.y}
                          r={view.image.width / 750}
                          fill="none"
                          stroke={
                            board.topologyState === "confirmed_manual"
                              ? "#40ba87"
                              : "#e4b345"
                          }
                          strokeWidth={view.image.width / 1600}
                        >
                          <title>
                            {board.id} / {h.id.toUpperCase()}
                          </title>
                        </circle>
                      ))}
                    {observations?.boards.flatMap((b, bi) =>
                      b.landmarks.map((l, li) => (
                        <g key={`l${bi}:${li}`}>
                          <circle
                            cx={(l.position[0] / 999) * (view.image.width - 1)}
                            cy={(l.position[1] / 999) * (view.image.height - 1)}
                            r={view.image.width / 160}
                            fill="#e5b246"
                            stroke="#fff"
                            strokeWidth={view.image.width / 1200}
                          />
                          <text
                            x={
                              (l.position[0] / 999) * (view.image.width - 1) +
                              view.image.width / 100
                            }
                            y={(l.position[1] / 999) * (view.image.height - 1)}
                            fill="#473811"
                            stroke="#fff"
                            paintOrder="stroke"
                            strokeWidth={view.image.width / 1500}
                            fontSize={view.image.width / 75}
                          >
                            {l.hole.toUpperCase()}
                          </text>
                        </g>
                      )),
                    )}
                    {draft.terminals
                      .filter(
                        (t) =>
                          t.position &&
                          draft.components.find((c) => c.id === t.componentId)
                            ?.state !== "rejected",
                      )
                      .map((t) => {
                        const a = draft.associations.find(
                            (a) => a.terminalId === t.id,
                          ),
                          c = draft.components.find(
                            (c) => c.id === t.componentId,
                          );
                        return (
                          <g
                            key={t.id}
                            onClick={(e) => {
                              if (!picking) {
                                e.stopPropagation();
                                setSelected(t.componentId);
                                document
                                  .getElementById(`review-${t.componentId}`)
                                  ?.scrollIntoView({
                                    behavior: "smooth",
                                    block: "nearest",
                                  });
                              }
                            }}
                          >
                            <circle
                              cx={t.position!.x}
                              cy={t.position!.y}
                              r={
                                view.image.width /
                                (selected === t.componentId ? 100 : 150)
                              }
                              fill={
                                a?.state === "confirmed_manual"
                                  ? "#1ca578"
                                  : "#de923a"
                              }
                              stroke="#fff"
                              strokeWidth={view.image.width / 800}
                            />
                            <title>
                              {c?.label}: {t.label} ·{" "}
                              {a?.target?.kind === "hole"
                                ? a.target.holeId.toUpperCase()
                                : "unresolved"}
                            </title>
                          </g>
                        );
                      })}
                  </svg>
                )}
              </div>
            ) : (
              !cameraOn && (
                <div className="ai-camera-empty">
                  <BenchIcon name="camera" size={42} />
                  <h2>Start with the actual wiring.</h2>
                  <p>
                    Use an overhead photo with readable hole labels. Keep wire
                    ends and component legs visible.
                  </p>
                </div>
              )
            )}
          </div>
          {picking && (
            <p className="ai-picking" role="status">
              Click the actual{" "}
              {picking.kind === "terminal"
                ? "insertion point"
                : "labelled hole centre"}{" "}
              in the photo.{" "}
              <button
                className="bench-link-button"
                onClick={() => setPicking(null)}
              >
                Cancel
              </button>
            </p>
          )}
          <div className="ai-camera-actions">
            {cameraOn ? (
              <>
                <button
                  className="bench-button bench-button-dark"
                  disabled={busy}
                  onClick={() => work(capture)}
                >
                  Capture frame
                </button>
                <button
                  className="bench-button bench-button-quiet"
                  onClick={stop}
                >
                  Stop camera
                </button>
              </>
            ) : (
              <button
                className="bench-button bench-button-dark"
                disabled={busy || running}
                onClick={() => work(start)}
              >
                {photo ? "Retake with camera" : "Start camera"}
              </button>
            )}
            <label
              className={`bench-button bench-button-quiet ${busy || running ? "ai-disabled" : ""}`}
            >
              Upload photo
              <input
                aria-label="Upload circuit photo"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy || running}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void work(async () => stage(file));
                  e.target.value = "";
                }}
              />
            </label>
            {pending && (
              <button
                className="bench-button bench-button-dark"
                disabled={busy}
                onClick={() => work(analyze)}
              >
                {busy ? "Uploading…" : "Analyze circuit"}
              </button>
            )}
            {view && (
              <label className="ai-check">
                <input
                  type="checkbox"
                  checked={gridVisible}
                  onChange={(e) => setGridVisible(e.target.checked)}
                />
                Show grid
              </label>
            )}
          </div>
          {pending && (
            <p className="ai-help">
              Analysis finds the grid and components, then inspects a crop of
              each component. No reference schematic is supplied.
            </p>
          )}
          {view && (
            <div className="ai-photo-legend">
              <span>
                <i />
                AI proposal
              </span>
              <span>
                <i className="confirmed" />
                Human confirmed
              </span>
              <span>{view.requestCount} AI requests</span>
            </div>
          )}
        </section>
        <aside
          className="ai-card ai-review"
          aria-label="Human connection review"
        >
          <div className="ai-card-heading">
            <strong>
              {running
                ? "Inspecting your circuit"
                : ready
                  ? "Review the proposed wiring"
                  : "How it works"}
            </strong>
            {ready && (
              <span>
                {confirmed}/{total} connections confirmed
              </span>
            )}
          </div>
          {running ? (
            <div className="ai-progress" role="status">
              <i className="bench-spinner" />
              <h2>{view?.stage}</h2>
              <p>
                You can leave and reopen this inspection. Requests are not
                repeated when you refresh.
              </p>
            </div>
          ) : !ready ? (
            <div className="ai-intro">
              <ol>
                <li>Capture or upload your circuit.</li>
                <li>AI fits the grid and proposes components and terminals.</li>
                <li>
                  Check the overlays, adjust uncertain points, and confirm
                  connections.
                </li>
              </ol>
              {view?.error && <p role="alert">{view.error}</p>}
            </div>
          ) : (
            <>
              {view?.error && (
                <p className="ai-warning" role="alert">
                  {view.error}
                </p>
              )}
              <section className="ai-review-section">
                <h2>1. Check the board grid</h2>
                <p>
                  Yellow circles should sit on hole centres. Confirm the board
                  layout; power rails need a separate continuity declaration.
                </p>
                {!draft.boards.length && (
                  <p className="ai-warning">
                    The grid could not be fitted. Adjust or add labelled
                    landmarks below, then fit it again.
                  </p>
                )}
                {draft.boards.map((b) => (
                  <div className="ai-board" key={b.id}>
                    <label className="ai-check">
                      <input
                        type="checkbox"
                        checked={b.topologyState === "confirmed_manual"}
                        disabled={gridDirty}
                        onChange={(e) =>
                          edit((v) => {
                            v.boards.find(
                              (board) => board.id === b.id,
                            )!.topologyState = e.target.checked
                              ? "confirmed_manual"
                              : "unresolved";
                            for (const a of v.associations)
                              if (
                                a.target?.kind === "hole" &&
                                a.target.boardId === b.id
                              )
                                a.state = "unresolved";
                          })
                        }
                      />
                      <strong>
                        {b.id.replace("_", " ")} · {b.calibration.rows} rows
                      </strong>
                      <span>Grid and terminal-strip layout checked</span>
                    </label>
                    {b.rails.map((r) => (
                      <label className="ai-rail" key={r.id}>
                        {r.id} · {r.label}
                        <select
                          aria-label={`${b.id} ${r.id} continuity`}
                          value={r.connectivity}
                          onChange={(e) =>
                            edit((v) => {
                              const rail = v.boards
                                .find((x) => x.id === b.id)!
                                .rails.find((x) => x.id === r.id)!;
                              rail.connectivity = e.target
                                .value as Rail["connectivity"];
                              rail.splitAfter =
                                rail.connectivity === "split"
                                  ? Math.floor(rail.count / 2)
                                  : null;
                              for (const a of v.associations)
                                if (
                                  a.target?.kind === "hole" &&
                                  a.target.boardId === b.id &&
                                  a.target.holeId.startsWith(r.id + ":")
                                )
                                  a.state = "unresolved";
                            })
                          }
                        >
                          <option value="unknown">Continuity unknown</option>
                          <option value="continuous">
                            I verified it is continuous
                          </option>
                          <option value="split">I verified a break</option>
                        </select>
                        {r.connectivity === "split" && (
                          <input
                            aria-label={`${r.id} split after hole`}
                            type="number"
                            min={1}
                            max={r.count - 1}
                            value={r.splitAfter ?? ""}
                            onChange={(e) =>
                              edit((v) => {
                                v.boards
                                  .find((x) => x.id === b.id)!
                                  .rails.find(
                                    (x) => x.id === r.id,
                                  )!.splitAfter = Number(e.target.value);
                              })
                            }
                          />
                        )}
                      </label>
                    ))}
                  </div>
                ))}
                <details>
                  <summary>Adjust grid landmarks</summary>
                  <p>
                    Use visible labelled holes on both halves, spread along the
                    board. Place at least six.
                  </p>
                  {observations?.boards.map((b, bi) => (
                    <div key={bi} className="ai-landmarks">
                      <label>
                        Board rows
                        <select
                          value={b.rows}
                          onChange={(e) => {
                            const next = structuredClone(observations);
                            next.boards[bi].rows = Number(e.target.value) as
                              30 | 63;
                            setObservations(next);
                            setGridDirty(true);
                          }}
                        >
                          <option value={30}>30</option>
                          <option value={63}>63</option>
                        </select>
                      </label>
                      {b.landmarks.map((l, li) => (
                        <div key={li}>
                          <input
                            aria-label={`Board ${bi + 1} landmark ${li + 1}`}
                            value={l.hole}
                            onChange={(e) => {
                              const next = structuredClone(observations);
                              next.boards[bi].landmarks[li].hole =
                                e.target.value.toLowerCase();
                              setObservations(next);
                              setGridDirty(true);
                            }}
                          />
                          <button
                            className="bench-link-button"
                            onClick={() =>
                              setPicking({
                                kind: "landmark",
                                board: bi,
                                index: li,
                              })
                            }
                          >
                            Place {l.hole.toUpperCase()}
                          </button>
                          <button
                            className="bench-link-button"
                            onClick={() => {
                              const next = structuredClone(observations);
                              next.boards[bi].landmarks.splice(li, 1);
                              setObservations(next);
                              setGridDirty(true);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      <button
                        className="bench-link-button"
                        onClick={() => {
                          const next = structuredClone(observations);
                          next.boards[bi].landmarks.push({
                            hole: "a1",
                            position: [0, 0],
                          });
                          setObservations(next);
                          setGridDirty(true);
                          setPicking({
                            kind: "landmark",
                            board: bi,
                            index: b.landmarks.length,
                          });
                        }}
                      >
                        Add labelled hole
                      </button>
                      {b.rails.map((rail, ri) => (
                        <fieldset className="ai-rail-editor" key={ri}>
                          <legend>Power rail {ri + 1}</legend>
                          <label>
                            Marking
                            <select
                              value={rail.label}
                              onChange={(e) => {
                                const next = structuredClone(observations);
                                next.boards[bi].rails[ri].label = e.target
                                  .value as typeof rail.label;
                                setObservations(next);
                                setGridDirty(true);
                              }}
                            >
                              <option value="unmarked">Unmarked</option>
                              <option value="positive">Positive marking</option>
                              <option value="negative">Negative marking</option>
                            </select>
                          </label>
                          <label>
                            Hole count
                            <select
                              value={rail.count}
                              onChange={(e) => {
                                const next = structuredClone(observations);
                                next.boards[bi].rails[ri].count = Number(
                                  e.target.value,
                                ) as 25 | 50;
                                setObservations(next);
                                setGridDirty(true);
                              }}
                            >
                              <option value={25}>25</option>
                              <option value={50}>50</option>
                            </select>
                          </label>
                          <label>
                            Spacing
                            <select
                              value={rail.layout}
                              onChange={(e) => {
                                const next = structuredClone(observations);
                                next.boards[bi].rails[ri].layout = e.target
                                  .value as typeof rail.layout;
                                setObservations(next);
                                setGridDirty(true);
                              }}
                            >
                              <option value="uniform">Uniform</option>
                              <option value="groups-of-five">
                                Groups of five
                              </option>
                            </select>
                          </label>
                          {(["first", "last"] as const).map((end) => (
                            <button
                              key={end}
                              className="bench-link-button"
                              onClick={() =>
                                setPicking({
                                  kind: "rail",
                                  board: bi,
                                  index: ri,
                                  end,
                                })
                              }
                            >
                              Place {end} hole
                            </button>
                          ))}
                          <button
                            className="bench-link-button"
                            onClick={() => {
                              const next = structuredClone(observations);
                              next.boards[bi].rails.splice(ri, 1);
                              setObservations(next);
                              setGridDirty(true);
                            }}
                          >
                            Remove rail
                          </button>
                        </fieldset>
                      ))}
                      <button
                        className="bench-link-button"
                        disabled={b.rails.length >= 4}
                        onClick={() => {
                          const next = structuredClone(observations);
                          next.boards[bi].rails.push({
                            label: "unmarked",
                            count: 25,
                            layout: "groups-of-five",
                            first: [0, 0],
                            last: [0, 0],
                          });
                          setObservations(next);
                          setGridDirty(true);
                        }}
                      >
                        Add missing power rail
                      </button>
                    </div>
                  ))}
                  {!observations?.boards.length && (
                    <button
                      className="bench-link-button"
                      onClick={() => {
                        setObservations({
                          ...(observations ?? { components: [], warnings: [] }),
                          boards: [
                            {
                              rows: 30,
                              landmarks: [],
                              rails: [],
                              note: "Human supplied landmarks",
                            },
                          ],
                        });
                        setGridDirty(true);
                      }}
                    >
                      Add board grid
                    </button>
                  )}
                  <button
                    className="bench-button bench-button-quiet"
                    disabled={busy || !gridDirty}
                    onClick={() =>
                      work(() =>
                        post("calibrate", {
                          expectedRevision: view!.revision,
                          observations,
                          input: draft,
                        }),
                      )
                    }
                  >
                    Fit adjusted grid
                  </button>
                  {dirty && (
                    <p className="ai-help">
                      Fitting keeps your edits and clears confirmations so the
                      adjusted grid can be reviewed.
                    </p>
                  )}
                </details>
              </section>
              <section className="ai-review-section">
                <h2>2. Check parts and contacts</h2>
                <p>
                  Confirm each part, then each supported insertion. Hidden
                  contacts can remain unresolved. Confirm a wire’s two ends and
                  continuity separately.
                </p>
                {draft.components.map((c) => (
                  <details
                    className={`ai-component ${selected === c.id ? "is-selected" : ""}`}
                    key={c.id}
                    id={`review-${c.id}`}
                    open={selected === c.id || undefined}
                  >
                    <summary
                      onClick={(e) => {
                        e.preventDefault();
                        setSelected(selected === c.id ? null : c.id);
                      }}
                    >
                      <span>{c.label}</span>
                      <small>
                        {c.type.replaceAll("_", " ")} · {c.terminalIds.length}{" "}
                        contacts
                      </small>
                    </summary>
                    <div className="ai-component-body">
                      <label>
                        Part label
                        <input
                          value={c.label}
                          onChange={(e) =>
                            edit((v) => {
                              v.components.find((x) => x.id === c.id)!.label =
                                e.target.value;
                            })
                          }
                        />
                      </label>
                      <label>
                        Part type
                        <select
                          value={c.type}
                          onChange={(e) =>
                            edit((v) => {
                              const comp = v.components.find(
                                (x) => x.id === c.id,
                              )!;
                              comp.type = e.target.value;
                              comp.state = "unresolved";
                              comp.continuity = "unresolved";
                              for (const a of v.associations)
                                if (comp.terminalIds.includes(a.terminalId))
                                  a.state = "unresolved";
                            })
                          }
                        >
                          {[
                            ...new Set([
                              c.type,
                              "jumper_wire",
                              "resistor",
                              "led",
                              "switch_assembly",
                              "power_module",
                              "capacitor",
                              "transistor",
                              "integrated_circuit",
                              "connector",
                              "unknown",
                            ]),
                          ].map((t) => (
                            <option key={t} value={t}>
                              {t.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="ai-check">
                        <input
                          type="checkbox"
                          checked={c.state === "confirmed_manual"}
                          onChange={(e) =>
                            edit((v) => {
                              v.components.find((x) => x.id === c.id)!.state = e
                                .target.checked
                                ? "confirmed_manual"
                                : "unresolved";
                              for (const a of v.associations)
                                if (c.terminalIds.includes(a.terminalId))
                                  a.state = "unresolved";
                            })
                          }
                        />
                        I confirm this component’s identity
                      </label>
                      <label className="ai-check">
                        <input
                          type="checkbox"
                          checked={c.state === "rejected"}
                          onChange={(e) =>
                            edit((v) => {
                              v.components.find((x) => x.id === c.id)!.state = e
                                .target.checked
                                ? "rejected"
                                : "unresolved";
                              for (const a of v.associations)
                                if (c.terminalIds.includes(a.terminalId))
                                  a.state = "unresolved";
                            })
                          }
                        />
                        Reject this detection
                      </label>
                      {c.type === "jumper_wire" && (
                        <label className="ai-check">
                          <input
                            type="checkbox"
                            checked={c.continuity === "confirmed_manual"}
                            onChange={(e) =>
                              edit((v) => {
                                v.components.find(
                                  (x) => x.id === c.id,
                                )!.continuity = e.target.checked
                                  ? "confirmed_manual"
                                  : "unresolved";
                              })
                            }
                          />
                          Both ends belong to this single intact wire
                        </label>
                      )}
                      {c.terminalIds.map((tid) => {
                        const t = draft.terminals.find((t) => t.id === tid)!,
                          a = draft.associations.find(
                            (a) => a.terminalId === tid,
                          )!;
                        return (
                          <div className="ai-terminal" key={tid}>
                            <div className="ai-terminal-title">
                              <strong>{t.label}</strong>
                              <span>
                                {a.state === "confirmed_manual"
                                  ? "Confirmed"
                                  : t.position
                                    ? "Proposed · check insertion"
                                    : "Unresolved · position hidden"}
                              </span>
                            </div>
                            <button
                              className="bench-link-button"
                              onClick={() =>
                                setPicking({ kind: "terminal", id: tid })
                              }
                            >
                              Locate insertion in photo
                            </button>
                            <label>
                              Connection
                              <select
                                aria-label={`${c.label} ${t.label} connection`}
                                value={targetValue(a)}
                                onChange={(e) =>
                                  edit((v) => {
                                    const association = v.associations.find(
                                      (x) => x.id === a.id,
                                    )!;
                                    const [boardId, holeId] =
                                      e.target.value.split("/");
                                    association.target = !boardId
                                      ? null
                                      : boardId === "terminal"
                                        ? {
                                            kind: "terminal",
                                            terminalId: holeId,
                                          }
                                        : {
                                            kind: "hole",
                                            boardId,
                                            holeId,
                                            calibrationRevision: v.boards.find(
                                              (b) => b.id === boardId,
                                            )!.revision,
                                          };
                                    association.type =
                                      boardId === "terminal"
                                        ? "conductive_contact"
                                        : "insertion";
                                    association.state = "unresolved";
                                  })
                                }
                              >
                                <option value="">Unresolved</option>
                                {draft.boards.map((b) => (
                                  <optgroup key={b.id} label={b.id}>
                                    {holes
                                      .filter((h) => h.board.id === b.id)
                                      .map(({ h }) => (
                                        <option
                                          key={h.id}
                                          value={`${b.id}/${h.id}`}
                                        >
                                          {b.id} / {h.id.toUpperCase()}
                                        </option>
                                      ))}
                                  </optgroup>
                                ))}
                                <optgroup label="Direct contact to another terminal">
                                  {draft.terminals
                                    .filter(
                                      (other) =>
                                        other.componentId !== c.id &&
                                        draft.components.find(
                                          (c) => c.id === other.componentId,
                                        )?.state === "confirmed_manual",
                                    )
                                    .map((other) => (
                                      <option
                                        key={other.id}
                                        value={`terminal/${other.id}`}
                                      >
                                        {
                                          draft.components.find(
                                            (c) => c.id === other.componentId,
                                          )?.label
                                        }{" "}
                                        / {other.label}
                                      </option>
                                    ))}
                                </optgroup>
                              </select>
                            </label>
                            <label className="ai-check">
                              <input
                                type="checkbox"
                                checked={a.state === "confirmed_manual"}
                                disabled={
                                  gridDirty ||
                                  c.state !== "confirmed_manual" ||
                                  !a.target ||
                                  (a.target.kind === "hole" &&
                                    draft.boards.find(
                                      (b) =>
                                        b.id ===
                                        (a.target as { boardId: string })
                                          .boardId,
                                    )?.topologyState !== "confirmed_manual")
                                }
                                onChange={(e) =>
                                  edit((v) => {
                                    v.associations.find(
                                      (x) => x.id === a.id,
                                    )!.state = e.target.checked
                                      ? "confirmed_manual"
                                      : "unresolved";
                                  })
                                }
                              />
                              I confirm this physical connection
                            </label>
                            <label>
                              Electrical role, if known
                              <input
                                placeholder="Unknown"
                                value={t.role ?? ""}
                                onChange={(e) =>
                                  edit((v) => {
                                    const terminal = v.terminals.find(
                                      (x) => x.id === tid,
                                    )!;
                                    terminal.role = e.target.value || null;
                                    terminal.roleState = "unresolved";
                                  })
                                }
                              />
                            </label>
                            {t.role && (
                              <label className="ai-check">
                                <input
                                  type="checkbox"
                                  checked={t.roleState === "confirmed_manual"}
                                  onChange={(e) =>
                                    edit((v) => {
                                      v.terminals.find(
                                        (x) => x.id === tid,
                                      )!.roleState = e.target.checked
                                        ? "confirmed_manual"
                                        : "unresolved";
                                    })
                                  }
                                />
                                Role checked against marking or part information
                              </label>
                            )}
                            {t.evidence
                              .filter((e) => e.source === "scene_observation")
                              .map((e) => (
                                <p className="ai-help" key={e.id}>
                                  {e.note}
                                </p>
                              ))}
                            <button
                              className="bench-link-button"
                              onClick={() =>
                                edit((v) => {
                                  const component = v.components.find(
                                    (x) => x.id === c.id,
                                  )!;
                                  component.terminalIds =
                                    component.terminalIds.filter(
                                      (id) => id !== tid,
                                    );
                                  component.state = "unresolved";
                                  v.terminals = v.terminals.filter(
                                    (x) => x.id !== tid,
                                  );
                                  v.associations = v.associations.filter(
                                    (x) => x.terminalId !== tid,
                                  );
                                  for (const other of v.associations) {
                                    if (
                                      other.target?.kind === "terminal" &&
                                      other.target.terminalId === tid
                                    )
                                      other.target = null;
                                    if (
                                      component.terminalIds.includes(
                                        other.terminalId,
                                      ) ||
                                      !other.target
                                    )
                                      other.state = "unresolved";
                                  }
                                })
                              }
                            >
                              Remove this terminal
                            </button>
                          </div>
                        );
                      })}
                      <button
                        className="bench-link-button"
                        onClick={() =>
                          edit((v) => {
                            const comp = v.components.find(
                              (x) => x.id === c.id,
                            )!;
                            const tid = `${c.id}_manual_${crypto.randomUUID().replaceAll("-", "")}`;
                            comp.terminalIds.push(tid);
                            v.terminals.push({
                              id: tid,
                              componentId: c.id,
                              label: `Contact ${comp.terminalIds.length}`,
                              role: null,
                              roleState: "unresolved",
                              position: null,
                              evidence: [],
                            });
                            v.associations.push({
                              id: `a_${tid}`,
                              terminalId: tid,
                              target: null,
                              type: "insertion",
                              state: "unresolved",
                              evidence: [],
                              originalProposalRef: null,
                            });
                          })
                        }
                      >
                        Add missing terminal
                      </button>
                    </div>
                  </details>
                ))}
                <button
                  className="bench-link-button"
                  onClick={() =>
                    edit((v) => {
                      const id = `manual_${crypto.randomUUID().replaceAll("-", "")}`;
                      v.components.push({
                        id,
                        label: "Unidentified component",
                        type: "unknown",
                        objectRef: { kind: "manual", id },
                        bbox: null,
                        terminalIds: [],
                        state: "unresolved",
                        continuity: "unresolved",
                        evidence: [],
                      });
                      setSelected(id);
                    })
                  }
                >
                  Add missed component
                </button>
              </section>
              <section className="ai-save">
                <label>
                  Your name
                  <input
                    aria-label="Reviewer name"
                    value={reviewer}
                    onChange={(e) => {
                      setReviewer(e.target.value);
                      localStorage.setItem("praxis-reviewer", e.target.value);
                    }}
                    placeholder="Who checked the wiring?"
                  />
                </label>
                <button
                  className="bench-button bench-button-dark"
                  disabled={busy || !reviewer.trim() || gridDirty}
                  onClick={() =>
                    work(() =>
                      post("review", {
                        expectedRevision: view!.revision,
                        reviewer,
                        input: draft,
                      }),
                    )
                  }
                >
                  {busy ? "Saving…" : "Save review and build graph"}
                </button>
                <p className="ai-help">
                  Unconfirmed contacts stay unresolved. Saving does not
                  establish that the circuit operates.
                </p>
                {dirty && <p role="status">You have unsaved review changes.</p>}
              </section>
            </>
          )}
        </aside>
      </div>
      {view?.warnings.length ? (
        <details className="ai-card ai-notes">
          <summary>Inspection notes · {view.warnings.length}</summary>
          <ul>
            {view.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <section className="ai-card ai-graph">
        <div className="ai-card-heading">
          <strong>Observed connections</strong>
          {view && !running && (
            <a
              className="bench-link-button"
              href={`/api/circuit-inspections/${view.id}/evidence`}
              download
            >
              Download inspection
            </a>
          )}
        </div>
        {view?.graph && !dirty && !gridDirty && !cameraOn ? (
          <CircuitGraph
            graph={view.graph}
            selected={selected}
            onSelect={setSelected}
            fault={false}
            faultWireId={null}
          />
        ) : (
          <div className="ai-graph-empty">
            <BenchIcon name="circuit" size={28} />
            <p>
              {dirty || gridDirty
                ? "Save your updated review to rebuild the connection graph."
                : "Your connection graph appears after you review and save the proposed wiring."}
            </p>
          </div>
        )}
      </section>
      {view && (
        <details className="ai-notes">
          <summary>Saved inspection</summary>
          <p>Inspection ID: {view.id}</p>
          <button
            className="bench-link-button"
            disabled={busy || running}
            onClick={() =>
              work(async () => {
                await json(
                  await fetch(`/api/circuit-inspections/${view.id}`, {
                    cache: "no-store",
                  }),
                ).then((v) => accept(parseInspection(v, view.id)));
              })
            }
          >
            Reload saved inspection
          </button>
          <button
            className="bench-link-button"
            disabled={busy || running}
            onClick={() =>
              work(async () => {
                const response = await fetch(
                  `/api/circuit-inspections/${view.id}`,
                  { method: "DELETE" },
                );
                if (!response.ok) await json(response);
                reset();
              })
            }
          >
            Delete this inspection
          </button>
        </details>
      )}
    </main>
  );
}
