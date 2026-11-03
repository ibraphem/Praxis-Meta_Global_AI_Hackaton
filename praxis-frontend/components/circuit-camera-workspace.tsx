"use client";
import Link from "next/link";
import { useState, useEffect, useRef, useCallback } from "react";
import { ImagePreview, type Photograph } from "./image-preview";
import { CircuitGraph } from "./circuit-graph";
import { CameraEvidenceOverlays } from "./camera-evidence-overlays";
import { analysisJobSchema, type AnalysisJob } from "@/lib/analysis-jobs";
import {
  parseCircuitSession,
  hashBytes,
  demoPartIds,
  type CircuitSessionView,
} from "@/lib/circuit-session";
import {
  parseConnectivityView,
  type ConnectivityView,
} from "@/lib/connectivity";
import { captureCamera, frameSize, imagePixels, rgbPixels } from "@/lib/camera";
import {
  checkFixedCamera,
  junctionRegionsUnchanged,
} from "../../praxis-backend/server/src/shared/fixed-camera";
import {
  allHoles,
  type Calibration,
  type Rail,
} from "@/lib/breadboard/calibration";
import "./circuit-camera.css";
const emptyParts = {
  supplyVolts: 5,
  r1Ohms: 1000,
  r2Ohms: 1000,
  ledSource: "",
  switchPart: "",
  switchContacts: "",
  schematicSource: "",
};
const partLabels = {
  P1: "Supply",
  R1: "Green LED resistor",
  D1: "Green LED",
  S1: "Normally-open switch",
  R2: "Red LED resistor",
  J1: "Movable red-branch jumper",
  D2: "Red LED",
};
async function json(response: Response) {
  const data = await response.json();
  if (!response.ok) throw Error(data?.error?.message ?? "Request failed.");
  return data;
}
export function CircuitCameraWorkspace() {
  const [view, setView] = useState<CircuitSessionView | null>(null),
    [sessionId, setSessionId] = useState(""),
    [savedId, setSavedId] = useState(""),
    [job, setJob] = useState<AnalysisJob | null>(null),
    [photo, setPhoto] = useState<Photograph | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [cameraOn, setCameraOn] = useState(false),
    [videoAspect, setVideoAspect] = useState(4 / 3),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [deviceId, setDeviceId] = useState(""),
    [pending, setPending] = useState<{
      file: File;
      width: number;
      height: number;
      capturedAt: number;
      url: string;
    } | null>(null),
    [setupView, setSetupView] = useState<ConnectivityView | null>(null),
    [reviewer, setReviewer] = useState(""),
    [reason, setReason] = useState(""),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [parts, setParts] = useState(emptyParts),
    [anchors, setAnchors] = useState([
      { x: 40, y: 40 },
      { x: 200, y: 40 },
      { x: 200, y: 200 },
      { x: 40, y: 200 },
    ]),
    [physicalVerified, setPhysicalVerified] = useState(false),
    [wireId, setWireId] = useState(""),
    [anchored, setAnchored] = useState(""),
    [moving, setMoving] = useState(""),
    [destination, setDestination] = useState(""),
    [freshConfirmed, setFreshConfirmed] = useState(false),
    [destinationConfirmed, setDestinationConfirmed] = useState(false),
    [liveAlignment, setLiveAlignment] = useState<{
      captureId: string;
      valid: boolean;
    }>({ captureId: "", valid: false }),
    [liveReason, setLiveReason] = useState(
      "Guidance appears on the last captured image until the fixed view is checked.",
    ),
    [clearView, setClearView] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    stream = useRef<MediaStream | null>(null),
    lock = useRef(false),
    alive = useRef(true),
    urls = useRef<string[]>([]),
    abort = useRef(new AbortController()),
    cameraGeneration = useRef(0);
  const currentCapture = view?.captures.find(
      (c) => c.plan.captureId === view.session.activeCaptureId,
    ),
    profile = view?.profile,
    repair = view?.repairs.find(
      (r) => r.repairId === view.session.activeRepairId,
    ),
    result = job?.result ?? null;
  const boundCapture =
      currentCapture?.analysisId === job?.analysisId ? currentCapture : null,
    qualified = profile?.qualification === "verified_human";
  const input = view?.input,
    holes =
      input?.boards.flatMap((b) =>
        allHoles(b.calibration as Calibration, b.rails as Rail[]).map((h) => ({
          value: `${b.id}/${h.id}`,
          label: `${b.id} / ${h.id}`,
        })),
      ) ?? [];
  const target = (v: string) => {
    const i = v.indexOf("/");
    if (i < 1) throw Error("Select a registered hole.");
    return { boardId: v.slice(0, i), holeId: v.slice(i + 1) };
  };
  const keep = useCallback((v: CircuitSessionView) => {
    if (!alive.current) return;
    setView(v);
    setSessionId(v.session.sessionId);
    localStorage.setItem("praxis-camera-session", v.session.sessionId);
  }, []);
  const api = useCallback(
    async (action: string, body?: unknown, id = view?.session.sessionId) => {
      if (action === "create") id = undefined;
      if (action !== "create" && !id)
        throw Error("Create or open a session first.");
      return parseCircuitSession(
        await json(
          await fetch(
            `/api/circuit-sessions${id ? `/${id}` : ""}${!["get", "create"].includes(action) ? `/${action}` : ""}`,
            {
              method: ["get", "evidence"].includes(action) ? "GET" : "POST",
              ...(body
                ? {
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                  }
                : {}),
              cache: "no-store",
              signal: abort.current.signal,
            },
          ),
        ),
        id,
      );
    },
    [view?.session.sessionId],
  );
  const work = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : "This operation could not finish.",
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const stop = useCallback(() => {
    cameraGeneration.current++;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setCameraOn(false);
    setLiveAlignment({ captureId: "", valid: false });
  }, []);
  useEffect(() => {
    alive.current = true;
    abort.current = new AbortController();
    const ownedUrls = urls.current;
    return () => {
      alive.current = false;
      abort.current.abort();
      stream.current?.getTracks().forEach((t) => t.stop());
      ownedUrls.forEach(URL.revokeObjectURL);
    };
  }, []);
  const start = async () => {
    stop();
    const generation = cameraGeneration.current;
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error(
        "Camera access requires localhost or HTTPS and a supported browser.",
      );
    const media = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(deviceId
          ? { deviceId: { exact: deviceId } }
          : { facingMode: "environment" }),
        width: { ideal: 1280 },
        height: { ideal: 960 },
      },
    });
    if (!alive.current || generation !== cameraGeneration.current) {
      media.getTracks().forEach((t) => t.stop());
      return;
    }
    stream.current = media;
    media.getVideoTracks()[0]?.addEventListener("ended", stop, { once: true });
    if (video.current) {
      video.current.srcObject = media;
      await video.current.play();
    }
    setVideoAspect(
      video.current!.videoWidth / video.current!.videoHeight || 4 / 3,
    );
    setCameraOn(true);
    setDevices(
      (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "videoinput",
      ),
    );
  };
  const loadJob = async (id: string) => {
    const j = analysisJobSchema.parse(
      await json(
        await fetch(`/api/analyses/${id}`, {
          cache: "no-store",
          signal: abort.current.signal,
        }),
      ),
    );
    const bytes = await fetch(`/api/analyses/${id}/image`, {
      cache: "no-store",
      signal: abort.current.signal,
    }).then((r) => {
      if (!r.ok) throw Error("Saved photograph unavailable.");
      return r.blob();
    });
    const file = new File([bytes], "saved-capture.jpg", { type: bytes.type }),
      url = URL.createObjectURL(file);
    urls.current.push(url);
    setPhoto({ id: j.analysisId, file, url, ...j.image });
    setJob(j);
    setSelected(null);
    setWireId("");
    setAnchored("");
    setMoving("");
    setFreshConfirmed(false);
    return j;
  };
  const refresh = async () => {
    if (!view) return;
    const v = await api("get");
    keep(v);
    if (currentCapture?.analysisId) {
      const j = analysisJobSchema.parse(
        await json(
          await fetch(`/api/analyses/${currentCapture.analysisId}`, {
            cache: "no-store",
            signal: abort.current.signal,
          }),
        ),
      );
      setJob(j);
    }
  };
  useEffect(() => {
    if (
      !job ||
      (!["queued", "segmenting", "interpreting"].includes(job.status) &&
        job.scene?.status !== "queued" &&
        job.scene?.status !== "running")
    )
      return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const j = analysisJobSchema.parse(
          await json(
            await fetch(`/api/analyses/${job.analysisId}`, {
              cache: "no-store",
              signal: abort.current.signal,
            }),
          ),
        );
        if (cancelled) return;
        setJob(j);
        if (view) keep(await api("get"));
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Scan status unavailable.");
      }
    }, 1200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, job, view, keep]); // polling never dispatches inference
  const stageCapture = async (
    purpose: "setup" | "assessment" | "verification",
  ) => {
    if (!video.current) throw Error("Start the camera.");
    const captured = await captureCamera(video.current),
      url = URL.createObjectURL(captured.file);
    urls.current.push(url);
    const frameHash = await hashBytes(await captured.file.arrayBuffer());
    const next = await api("prepare-capture", {
      expectedRevision: view!.session.revision,
      frameHash,
      width: captured.width,
      height: captured.height,
      capturedAt: captured.capturedAt,
      cameraFrame: captured.cameraFrame,
      purpose,
    });
    keep(next);
    setPending({ ...captured, url });
    setFreshConfirmed(false);
    setClearView(false);
  };
  const upload = async () => {
    if (!pending || !currentCapture)
      throw Error("Capture and review a frame first.");
    const form = new FormData();
    form.append("image", pending.file);
    const j = analysisJobSchema.parse(
      await json(
        await fetch("/api/analyses", {
          method: "POST",
          headers: { "X-Praxis-Capture-Plan": currentCapture.plan.planId },
          body: form,
          signal: abort.current.signal,
        }),
      ),
    );
    setPhoto({ id: j.analysisId, ...pending });
    setJob(j);
    setSelected(null);
    setWireId("");
    setAnchored("");
    setMoving("");
    setDestination("");
    setPending(null);
    keep(await api("get"));
  };
  const loadSetup = async () => {
    if (!job) throw Error("Open a reviewed healthy setup analysis.");
    const v = parseConnectivityView(
      await json(
        await fetch(`/api/analyses/${job.analysisId}/connectivity`, {
          cache: "no-store",
          signal: abort.current.signal,
        }),
      ),
      job.analysisId,
      job.imageHash,
    );
    if (!v.source)
      throw Error(
        "Use the calibration and Electrical connectivity panel below to save and review the healthy setup first.",
      );
    setSetupView(v);
  };
  const saveProfile = async (qualification: "draft" | "verified_human") => {
    if (!job || !setupView) throw Error("Refresh setup evidence first.");
    keep(
      await api("profile", {
        expectedRevision: view!.session.revision,
        analysisId: job.analysisId,
        qualification,
        parts,
        mapping,
        poseAnchors: anchors,
        physicalDetailsVerified: physicalVerified,
        reviewer,
        reason,
      }),
    );
  };
  const openSession = async (id: string) => {
    const v = await api("get", undefined, id);
    keep(v);
    if (v.profile) {
      setMapping(v.profile.mapping);
      setParts(v.profile.parts);
      setAnchors(v.profile.poseAnchors);
    }
    const c = v.captures.find(
      (c) => c.plan.captureId === v.session.activeCaptureId,
    );
    if (c?.analysisId) await loadJob(c.analysisId);
    else if (v.session.setupAnalysisId)
      await loadJob(v.session.setupAnalysisId);
  };
  const capturedRepair =
    view?.guidanceCurrent &&
    repair &&
    boundCapture?.plan.captureId === repair.sourceCaptureId &&
    input &&
    repair.sourceInputHash === boundCapture.freshReview?.inputHash;
  // Local pixel comparisons invalidate old guidance; they do not recognize hands or verify contact.
  useEffect(() => {
    if (
      !cameraOn ||
      !boundCapture?.freshReview ||
      !photo ||
      !profile ||
      !clearView
    )
      return;
    let cancelled = false,
      running = false;
    let reference: Awaited<ReturnType<typeof imagePixels>> | null = null;
    void (async () => {
      if (
        !input ||
        (await hashBytes(new TextEncoder().encode(canonical(input)).buffer)) !==
          boundCapture.freshReview!.inputHash
      )
        return;
      const pixels = await imagePixels(photo.url);
      if (!cancelled) reference = pixels;
    })().catch(() => {});
    const check = () => {
      if (
        cancelled ||
        running ||
        !reference ||
        !video.current ||
        video.current.readyState < 2
      )
        return;
      running = true;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = reference.width;
        canvas.height = reference.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(video.current, 0, 0, canvas.width, canvas.height);
        const now = rgbPixels(
            ctx.getImageData(0, 0, canvas.width, canvas.height),
          ),
          check = checkFixedCamera(reference, now, profile.poseAnchors);
        let changed = false;
        const box = result?.objects.find(
          (o) => o.id === boundCapture?.freshReview?.wireCandidateId,
        )?.bbox;
        if (box) {
          let n = 0,
            sum = 0;
          for (
            let y = Math.max(0, box[1] - 10);
            y < Math.min(now.height, box[1] + box[3] + 10);
            y += 3
          )
            for (
              let x = Math.max(0, box[0] - 10);
              x < Math.min(now.width, box[0] + box[2] + 10);
              x += 3
            ) {
              const i = (y * now.width + x) * 3;
              sum +=
                Math.abs(reference.data[i] - now.data[i]) +
                Math.abs(reference.data[i + 1] - now.data[i + 1]) +
                Math.abs(reference.data[i + 2] - now.data[i + 2]);
              n += 3;
            }
          changed = !n || sum / n > 10;
        } else changed = true;
        const anchoredPosition = input?.terminals.find(
          (t) => t.id === profile.anchoredTerminalId,
        )?.position;
        const movingPosition = input?.terminals.find(
          (t) => t.id === profile.movingTerminalId,
        )?.position;
        const liveSize = frameSize(
          video.current.videoWidth,
          video.current.videoHeight,
        );
        changed =
          changed ||
          !movingPosition ||
          !anchoredPosition ||
          !junctionRegionsUnchanged(reference, now, [
            movingPosition,
            anchoredPosition,
          ]) ||
          liveSize.width !== reference.width ||
          liveSize.height !== reference.height;
        setLiveAlignment({
          captureId: `${photo.id}:${input?.revision}:${profile.profileHash}`,
          valid: check.valid && !changed,
        });
        setLiveReason(
          check.valid && !changed
            ? "Last-scan guidance, fixed-view match. Clear-view/contact confirmation remains manual."
            : changed
              ? "J1 region changed. Live guidance paused; scan again after the move."
              : check.reason,
        );
      } finally {
        running = false;
      }
    };
    check();
    const timer = setInterval(check, 900);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    cameraOn,
    capturedRepair,
    photo,
    profile,
    clearView,
    result,
    boundCapture,
    input,
    repair,
  ]);
  const liveAligned =
    liveAlignment.captureId ===
      `${photo?.id}:${input?.revision}:${profile?.profileHash}` &&
    liveAlignment.valid &&
    cameraOn &&
    clearView;
  const connectivityChanged = useCallback(() => {
    if (!view?.session.sessionId) return;
    setLiveAlignment({ captureId: "", valid: false });
    void api("get")
      .then(keep)
      .catch(() => {});
  }, [api, keep, view?.session.sessionId]);
  const proposal = boundCapture?.endpointResult;
  return (
    <main className="camera-shell">
      <header>
        <Link href="/">praxis.</Link>
        <div>
          <h1>Scan. Explain. Repair.</h1>
          <p>
            A fixed-camera, two-LED circuit demonstration · explicit keyframe
            scans
          </p>
        </div>
        <span className="camera-tag">Physical rehearsal pending</span>
      </header>
      <section className="camera-toolbar">
        <button
          disabled={busy}
          onClick={() =>
            work(async () => {
              keep(await api("create", undefined, undefined));
              setJob(null);
              setPhoto(null);
              setSetupView(null);
              setPending(null);
              setMapping({});
            })
          }
        >
          New circuit session
        </button>
        <label>
          Session ID
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="Paste a saved session ID"
          />
        </label>
        <button
          disabled={busy || !sessionId}
          onClick={() => work(() => openSession(sessionId))}
        >
          Open session
        </button>
        <button
          disabled={busy}
          onClick={() =>
            work(async () => {
              const id = localStorage.getItem("praxis-camera-session");
              if (!id) throw Error("No saved camera session on this browser.");
              await openSession(id);
            })
          }
        >
          Resume last session
        </button>
        {view && (
          <button
            disabled={busy}
            onClick={() =>
              work(async () => {
                const data = await json(
                  await fetch(
                    `/api/circuit-sessions/${view.session.sessionId}/evidence`,
                    { cache: "no-store", signal: abort.current.signal },
                  ),
                );
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(data, null, 2)], {
                    type: "application/json",
                  }),
                );
                urls.current.push(url);
                const link = document.createElement("a");
                link.href = url;
                link.download = "praxis-circuit-session-evidence.json";
                link.click();
              })
            }
          >
            Export session evidence
          </button>
        )}
      </section>
      {error && (
        <p role="alert" className="camera-error">
          {error}
        </p>
      )}
      {view && (
        <p role="status" className={`camera-state state-${view.session.state}`}>
          {view.session.state.replaceAll("_", " ")} ·{" "}
          {profile
            ? `${profile.name} / ${profile.qualification}`
            : "No physical profile frozen"}{" "}
          · {view.captures.filter((c) => c.analysisId).length} saved scans
        </p>
      )}
      <div className="camera-columns">
        <section>
          <div
            className="camera-video"
            style={{
              aspectRatio: String(videoAspect),
              maxWidth: `${56 * videoAspect}vh`,
            }}
          >
            <video
              ref={video}
              playsInline
              muted
              aria-label="Live circuit camera"
            />
            {!cameraOn && (
              <div className="camera-placeholder">
                Start a camera to capture the physical circuit.
              </div>
            )}
            {liveAligned && result && boundCapture?.freshReview && (
              <CameraEvidenceOverlays
                result={result}
                selected={selected}
                onSelect={setSelected}
                wireId={boundCapture.freshReview.wireCandidateId}
                status={
                  view?.session.state === "resolved"
                    ? "restored"
                    : ["fault_found", "repair_guidance"].includes(
                          view?.session.state ?? "",
                        )
                      ? "fault"
                      : null
                }
              />
            )}
            {capturedRepair && liveAligned && repair && photo && (
              <RepairArrow
                repair={repair}
                width={photo.width}
                height={photo.height}
              />
            )}
          </div>
          <p className="camera-caption">
            LIVE PREVIEW ·{" "}
            {boundCapture?.freshReview
              ? liveReason
              : "Inference runs only when you approve a captured frame."}
          </p>
          <div className="camera-controls">
            <select
              aria-label="Camera device"
              value={deviceId}
              disabled={cameraOn || busy}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              <option value="">Default rear camera</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Camera"}
                </option>
              ))}
            </select>
            <button disabled={busy || cameraOn} onClick={() => work(start)}>
              Start camera
            </button>
            <button disabled={!cameraOn} onClick={stop}>
              Stop camera
            </button>
            <button
              disabled={busy || !cameraOn || !view}
              onClick={() =>
                work(() => stageCapture(qualified ? "assessment" : "setup"))
              }
            >
              {qualified ? "Scan circuit" : "Capture setup"}
            </button>
            <button
              disabled={busy || !cameraOn || !qualified || !repair}
              onClick={() => work(() => stageCapture("verification"))}
            >
              Verify repair — capture
            </button>
          </div>
          {boundCapture?.freshReview && (
            <label>
              <input
                type="checkbox"
                checked={clearView}
                onChange={(e) => setClearView(e.target.checked)}
              />
              I can see a clear, stationary circuit. Show last-scan guidance
              while the view matches.
            </label>
          )}
        </section>
        <aside>
          <h2>Demonstration scope</h2>
          <p>
            Green LED control branch. Button → resistor → J1 → red LED branch.
            Praxis checks the intended R2-to-D2 wiring relationship. The button
            can be released during scanning.
          </p>
          <p>
            Confirm the real supply, LED roles, resistor values, switch contact
            mapping and board topology during setup. Initial values shown below
            are draft suggestions.
          </p>
          <p>
            No full-scene refresh or automatic retries. No hand tracking. The
            final button press is a separate physical functional test.
          </p>
          <label>
            Reviewer
            <input
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
            />
          </label>
          <label>
            Evidence / reason
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Describe what you verified in this photograph"
            />
          </label>
        </aside>
      </div>
      {pending && currentCapture && (
        <section className="camera-preflight">
          <h2>Review captured frame before spending</h2>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={pending.url} alt="Frozen frame awaiting scan approval" />
          <p>
            {pending.width} × {pending.height} · {currentCapture.plan.purpose} ·{" "}
            {new Date(pending.capturedAt).toLocaleTimeString()}
          </p>
          <p>
            Provider: {currentCapture.plan.providerBaseUrl}. Up to{" "}
            <strong>4 SAM requests</strong> (
            {currentCapture.plan.budget.samPixels.toLocaleString()} input pixels
            total), model {currentCapture.plan.samModel}. Zero Muse calls in
            this scan. No retries.
          </p>
          <p>
            Optional endpoint interpretation is prepared and approved
            separately: at most 1 Muse request, 4 million image pixels.
          </p>
          <button disabled={busy} onClick={() => work(upload)}>
            Approve and scan this frame
          </button>
          <button disabled={busy} onClick={() => setPending(null)}>
            Discard frame
          </button>
        </section>
      )}
      <details className="camera-setup" open={!qualified}>
        <summary>Physical setup and intended circuit profile</summary>
        <p>
          Capture a healthy assembly, or explicitly open its saved analysis. Use
          the existing image workspace below to calibrate the board, identify
          components and terminal roles, confirm contacts, and review conductive
          coverage. Map J1 role <b>a</b> to its fixed R2-side end and <b>b</b>{" "}
          to its movable LED-side end.
        </p>
        <label>
          Saved healthy analysis ID
          <input value={savedId} onChange={(e) => setSavedId(e.target.value)} />
        </label>
        <button
          disabled={busy || !savedId}
          onClick={() =>
            work(async () => {
              await loadJob(savedId);
              setSetupView(null);
            })
          }
        >
          Open saved setup analysis
        </button>
        <button disabled={busy || !job} onClick={() => work(loadSetup)}>
          Refresh reviewed setup evidence
        </button>
        {setupView?.source && (
          <>
            <div className="camera-form-grid">
              {demoPartIds.map((id) => (
                <label key={id}>
                  {id} · {partLabels[id]}
                  <select
                    value={mapping[id] ?? ""}
                    onChange={(e) =>
                      setMapping({ ...mapping, [id]: e.target.value })
                    }
                  >
                    <option value="">Choose physical object</option>
                    {setupView.source!.input.components.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} ({c.type})
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {(["supplyVolts", "r1Ohms", "r2Ohms"] as const).map((key) => (
                <label key={key}>
                  {key}
                  <input
                    type="number"
                    min="0"
                    value={parts[key]}
                    onChange={(e) =>
                      setParts({ ...parts, [key]: Number(e.target.value) })
                    }
                  />
                </label>
              ))}
              {(
                [
                  "ledSource",
                  "switchPart",
                  "switchContacts",
                  "schematicSource",
                ] as const
              ).map((key) => (
                <label key={key}>
                  {key}
                  <input
                    value={parts[key]}
                    onChange={(e) =>
                      setParts({ ...parts, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
            </div>
            <p>
              Four distinctive fixed landmarks, in original image pixels, at
              least 29 px from edges. Use unique marks outside J1; repeated
              breadboard holes and plain areas are rejected. These are
              registration landmarks, not terminals.
            </p>
            <div className="camera-form-grid">
              {anchors.map((p, i) => (
                <label key={i}>
                  Landmark {i + 1}
                  <input
                    aria-label={`Landmark ${i + 1} x`}
                    type="number"
                    value={p.x}
                    onChange={(e) =>
                      setAnchors(
                        anchors.map((v, j) =>
                          j === i ? { ...v, x: Number(e.target.value) } : v,
                        ),
                      )
                    }
                  />
                  <input
                    aria-label={`Landmark ${i + 1} y`}
                    type="number"
                    value={p.y}
                    onChange={(e) =>
                      setAnchors(
                        anchors.map((v, j) =>
                          j === i ? { ...v, y: Number(e.target.value) } : v,
                        ),
                      )
                    }
                  />
                </label>
              ))}
            </div>
            <label>
              <input
                type="checkbox"
                checked={physicalVerified}
                onChange={(e) => setPhysicalVerified(e.target.checked)}
              />
              I verified this real healthy assembly, supply, resistor values,
              LED roles, switch contacts, schematic and board topology.
            </label>
            <button
              disabled={busy || !view}
              onClick={() => work(() => saveProfile("draft"))}
            >
              Save draft profile
            </button>
            <button
              disabled={busy || !view || !physicalVerified}
              onClick={() => work(() => saveProfile("verified_human"))}
            >
              Freeze verified physical profile
            </button>
          </>
        )}
      </details>
      {boundCapture && profile && boundCapture.plan.purpose !== "setup" && (
        <section>
          <h2>Fresh J1 evidence</h2>
          <p>
            Setup facts are transferred only after a fixed-view check. Both J1
            contacts start unresolved. Nothing from the intended repair is used
            as a fresh insertion observation.
          </p>
          <button
            disabled={busy || !!input || job?.sam.status !== "succeeded"}
            onClick={() =>
              work(async () => {
                keep(
                  await api("seed-capture", {
                    captureId: boundCapture.plan.captureId,
                  }),
                );
              })
            }
          >
            Check registration and load setup facts
          </button>
          <button disabled={busy} onClick={() => work(refresh)}>
            Refresh capture evidence
          </button>
          {!!boundCapture.poseEvidence && (
            <p>
              {String((boundCapture.poseEvidence as { reason: string }).reason)}
            </p>
          )}
          {input && (
            <>
              <label>
                Observed J1 wire
                <select
                  aria-label="Observed J1 wire"
                  value={wireId}
                  onChange={(e) => {
                    setWireId(e.target.value);
                    setSelected(e.target.value);
                    setFreshConfirmed(false);
                  }}
                >
                  <option value="">Select by actual visible identity</option>
                  {result?.objects
                    .filter((o) => o.type === "jumper_wire" && o.mask)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.id}
                      </option>
                    ))}
                </select>
              </label>
              <button
                disabled={busy || !wireId || !!boundCapture.endpointPlan}
                onClick={() =>
                  work(async () =>
                    keep(
                      await api("prepare-endpoints", {
                        captureId: boundCapture.plan.captureId,
                        wireCandidateId: wireId,
                      }),
                    ),
                  )
                }
              >
                Preview optional endpoint interpretation
              </button>
              {boundCapture.endpointPlan && (
                <div className="camera-preflight">
                  <p>
                    Prepared{" "}
                    {boundCapture.endpointPlan.dimensions
                      .map((d) => `${d.width}×${d.height}`)
                      .join(" + ")}{" "}
                    · {boundCapture.endpointPlan.pixels.toLocaleString()} pixels
                    · 1 Muse request to {boundCapture.plan.providerBaseUrl}{" "}
                    using {boundCapture.plan.museModel} · no retries.
                  </p>
                  <button
                    disabled={busy || !!boundCapture.endpointRequestedAt}
                    onClick={() =>
                      work(async () => {
                        keep(
                          await api("run-endpoints", {
                            captureId: boundCapture.plan.captureId,
                            endpointPlanHash: boundCapture.endpointPlan!.hash,
                            authorize: true,
                          }),
                        );
                        await refresh();
                      })
                    }
                  >
                    Approve one endpoint Muse request
                  </button>
                </div>
              )}
              {boundCapture.endpointError && (
                <p className="camera-error">{boundCapture.endpointError}</p>
              )}
              {!!proposal && (
                <details open>
                  <summary>
                    Endpoint proposals — require physical review
                  </summary>
                  <EndpointSummary value={proposal} />
                </details>
              )}
              <div className="camera-form-grid">
                <HoleField
                  label="Observed R2-side anchored end"
                  value={anchored}
                  onChange={setAnchored}
                  holes={holes}
                />
                <HoleField
                  label="Observed LED-side movable end"
                  value={moving}
                  onChange={setMoving}
                  holes={holes}
                />
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={freshConfirmed}
                  onChange={(e) => setFreshConfirmed(e.target.checked)}
                />
                I verified this wire is J1, both visible metal
                insertions/contact positions, its intact continuity, and all
                other reviewed circuit contacts remain unchanged in this fresh
                image.
              </label>
              <button
                disabled={
                  busy || !freshConfirmed || !wireId || !anchored || !moving
                }
                onClick={() =>
                  work(async () => {
                    keep(
                      await api("review-capture", {
                        captureId: boundCapture.plan.captureId,
                        expectedInputHash: await hashBytes(
                          new TextEncoder().encode(canonical(input)).buffer,
                        ),
                        wireCandidateId: wireId,
                        anchored: target(anchored),
                        moving: target(moving),
                        staticContactsUnchanged: true,
                        bothInsertionsVisible: true,
                        wireIdentityConfirmed: true,
                        reviewer,
                        reason,
                      }),
                    );
                  })
                }
              >
                Save fresh physical review and diagnose
              </button>
            </>
          )}
        </section>
      )}
      {view?.comparison && (
        <section className="camera-finding">
          <h2>Assessment from the last scan</h2>
          {view.comparison.findings.map((f) => (
            <div key={f.ruleId}>
              <strong>{f.status.replaceAll("_", " ")}</strong>
              <p>{f.reason}</p>
              <p>
                {f.status === "confirmed_fault"
                  ? "The expected R2-to-D2 connection is missing."
                  : f.status === "no_fault"
                    ? "No missing R2-to-D2 connection found within the reviewed scope. This does not establish LED operation."
                    : "Confirm J1 identity, both insertions and conductive review coverage."}
              </p>
            </div>
          ))}
        </section>
      )}
      {view?.session.state === "fault_found" && boundCapture && input && (
        <section>
          <h2>Choose a supported repair destination</h2>
          <HoleField
            label="Visible available destination on D2 anode net"
            value={destination}
            onChange={(v) => {
              setDestination(v);
              setDestinationConfirmed(false);
            }}
            holes={holes}
          />
          <label>
            <input
              type="checkbox"
              checked={destinationConfirmed}
              onChange={(e) => setDestinationConfirmed(e.target.checked)}
            />
            This hole is visibly empty and accessible in the current capture.
          </label>
          <button
            disabled={busy || !destination || !destinationConfirmed}
            onClick={() =>
              work(async () =>
                keep(
                  await api("plan-repair", {
                    captureId: boundCapture.plan.captureId,
                    expectedInputHash: await hashBytes(
                      new TextEncoder().encode(canonical(input)).buffer,
                    ),
                    target: target(destination),
                    destinationVisibleAndEmpty: true,
                    reviewer,
                    reason,
                  }),
                ),
              )
            }
          >
            Validate single-end move and show guidance
          </button>
        </section>
      )}
      {capturedRepair && repair && photo && (
        <section>
          <h2>{repair.text}</h2>
          <div className="camera-reference-image">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.url}
              alt="Last assessed frame with supported repair arrow"
            />
            <RepairArrow
              repair={repair}
              width={photo.width}
              height={photo.height}
            />
          </div>
          <p>
            Last assessed frame. Move the physical wire, clear the view, then
            capture verification. Editing this graph cannot resolve the repair.
          </p>
        </section>
      )}
      {boundCapture?.plan.purpose === "verification" && repair && (
        <button
          disabled={busy || !boundCapture.freshReview}
          onClick={() =>
            work(async () =>
              keep(
                await api("verify-repair", {
                  captureId: boundCapture.plan.captureId,
                  repairId: repair.repairId,
                }),
              ),
            )
          }
        >
          Evaluate fresh repair capture
        </button>
      )}
      {view?.verifications.at(-1) && (
        <section className="camera-verification">
          <h2>
            {view.verifications.at(-1)!.status === "resolved"
              ? "Expected R2-to-D2 connection restored"
              : view.verifications.at(-1)!.status.replaceAll("_", " ")}
          </h2>
          <p>{view.verifications.at(-1)!.reason}</p>
          {view.verifications.at(-1)!.status === "resolved" && (
            <p>
              Now press the real button and observe the red LED. Electrical
              operation has not been automatically verified.
            </p>
          )}
        </section>
      )}
      {view?.graph && (
        <CircuitGraph
          graph={view.graph}
          selected={selected}
          onSelect={setSelected}
          faultWireId={view.profile?.mapping.J1 ?? null}
          fault={
            view.session.state === "fault_found" ||
            view.session.state === "repair_guidance"
          }
        />
      )}
      {photo && (
        <section>
          <h2>Saved image workspace</h2>
          <p>
            Immutable captured image · {job?.analysisId} · {job?.status} ·{" "}
            {job && new Date(job.updatedAt).toLocaleTimeString()}. Calibrate and
            review using the existing tools.
          </p>
          <ImagePreview
            photograph={photo}
            result={result}
            analysisJob={job}
            loading={job?.status === "segmenting" || job?.status === "queued"}
            selecting={false}
            dragging={false}
            showOverlays
            selectedId={selected}
            analysisRunId={job?.analysisId ?? null}
            onSelect={setSelected}
            onHover={setSelected}
            onConnectivityChange={connectivityChanged}
            wireAssessment={
              boundCapture?.freshReview &&
              ["fault_found", "repair_guidance", "resolved"].includes(
                view?.session.state ?? "",
              )
                ? {
                    id: boundCapture.freshReview.wireCandidateId,
                    status:
                      view?.session.state === "resolved" ? "restored" : "fault",
                  }
                : null
            }
            onChoose={() => {}}
          />
        </section>
      )}
      {view && (
        <section>
          <h2>Request accounting</h2>
          <p>
            {view.requests.length} recorded provider dispatch intents. Unknown
            usage remains spent. All graph review, planning, verification and
            exports are offline.
          </p>
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Pixels</th>
                <th>Outcome</th>
                <th>Latency</th>
              </tr>
            </thead>
            <tbody>
              {view.requests.map((r) => (
                <tr key={r.requestId}>
                  <td>{r.stage}</td>
                  <td>{r.pixels.toLocaleString()}</td>
                  <td>{r.status}</td>
                  <td>
                    {r.latencyMs === null
                      ? "unknown"
                      : `${(r.latencyMs / 1000).toFixed(2)} s`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
function HoleField({
  label,
  value,
  onChange,
  holes,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  holes: { value: string; label: string }[];
}) {
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select a registered hole</option>
        {holes.map((h) => (
          <option key={h.value} value={h.value}>
            {h.label}
          </option>
        ))}
      </select>
    </label>
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function RepairArrow({
  repair,
  width,
  height,
}: {
  repair: NonNullable<CircuitSessionView["repairs"][number]>;
  width: number;
  height: number;
}) {
  return (
    <svg
      className="camera-arrow"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-label={`Move ${repair.from.holeId} to ${repair.to.holeId}`}
    >
      <defs>
        <marker
          id={`repair-${repair.repairId}`}
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L0,6 L8,3 z" fill="#c43a35" />
        </marker>
      </defs>
      <circle
        cx={repair.fromPosition.x}
        cy={repair.fromPosition.y}
        r="10"
        fill="none"
        stroke="#c43a35"
        strokeWidth="4"
      />
      <path
        d={`M ${repair.fromPosition.x} ${repair.fromPosition.y} Q ${(repair.fromPosition.x + repair.toPosition.x) / 2 + 35} ${(repair.fromPosition.y + repair.toPosition.y) / 2 - 40} ${repair.toPosition.x} ${repair.toPosition.y}`}
        fill="none"
        stroke="#c43a35"
        strokeWidth="4"
        markerEnd={`url(#repair-${repair.repairId})`}
      />
      <circle
        cx={repair.toPosition.x}
        cy={repair.toPosition.y}
        r="12"
        fill="none"
        stroke="#2b9369"
        strokeWidth="4"
      />
    </svg>
  );
}

function EndpointSummary({ value }: { value: unknown }) {
  const result = value as {
    endpoints?: {
      role: string;
      evidence: string;
      proposedImagePosition: [number, number] | null;
    }[];
  };
  return (
    <>
      <p>
        Positions are source-image pixels. A/B labels do not identify logical
        ends or polarity. Confirm the actual holes from the photograph.
      </p>
      <table>
        <thead>
          <tr>
            <th>End</th>
            <th>Image evidence</th>
            <th>Proposed insertion</th>
          </tr>
        </thead>
        <tbody>
          {result.endpoints?.map((e) => (
            <tr key={e.role}>
              <td>{e.role}</td>
              <td>{e.evidence.replaceAll("_", " ")}</td>
              <td>
                {e.proposedImagePosition?.map((v) => v.toFixed(1)).join(", ") ??
                  "Unknown — review or abstain"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
