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
  pickHole,
  project,
  type Calibration,
  type Rail,
} from "@/lib/breadboard/calibration";
import {
  BenchDialog,
  BenchIcon,
  BenchViewport,
  CircuitBlueprint,
  LandmarkPicker,
} from "./bench-ui";
import { destinationHoles, friendlyCameraError } from "@/lib/camera-flow";
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
    [capturing, setCapturing] = useState(false),
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
    [anchors, setAnchors] = useState<{ x: number; y: number }[]>([]),
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
    [clearView, setClearView] = useState(false),
    [drawer, setDrawer] = useState<"setup" | "settings" | null>(null),
    [setupStep, setSetupStep] = useState(0),
    [displayMode, setDisplayMode] = useState<"live" | "capture">("live"),
    [picking, setPicking] = useState<
      "anchored" | "moving" | "destination" | null
    >(null),
    [circuitTab, setCircuitTab] = useState<"observed" | "reference">(
      "observed",
    ),
    [cannotSee, setCannotSee] = useState(false);
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
    const restoreName = () => {
      if (alive.current)
        setReviewer(localStorage.getItem("praxis-reviewer") ?? "");
    };
    queueMicrotask(restoreName);
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
    if (!window.isSecureContext) {
      const secureUrl = new URL(window.location.href);
      secureUrl.protocol = "https:";
      throw Error(
        `Your browser blocks the camera over HTTP on this network address. Start Praxis with HTTPS, then open ${secureUrl.origin} using a certificate trusted by your phone.`,
      );
    }
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error(
        "Camera access is unavailable in this browser. Open Praxis directly in Safari or Chrome and allow camera access.",
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
    session: CircuitSessionView,
  ) => {
    if (!video.current) throw Error("Start the camera.");
    const captured = await captureCamera(video.current),
      url = URL.createObjectURL(captured.file);
    urls.current.push(url);
    const frameHash = await hashBytes(await captured.file.arrayBuffer());
    const next = await api(
      "prepare-capture",
      {
        expectedRevision: session.session.revision,
        frameHash,
        width: captured.width,
        height: captured.height,
        capturedAt: captured.capturedAt,
        cameraFrame: captured.cameraFrame,
        purpose,
      },
      session.session.sessionId,
    );
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
        reviewer: reviewer.trim(),
        reason:
          reason.trim().length >= 8
            ? reason.trim()
            : "Reviewer checked the healthy physical assembly, component roles and intended circuit before saving this setup.",
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
  const preparedWire = (
    boundCapture?.endpointPlan?.context as
      { wire?: { id?: string } } | undefined
  )?.wire?.id;
  const endpointMatches =
    !boundCapture?.endpointPlan || preparedWire === wireId;
  const proposal =
    (boundCapture?.endpointResult as { wireCandidateId?: string } | null)
      ?.wireCandidateId === wireId
      ? boundCapture?.endpointResult
      : null;
  const analyzing =
    !!job &&
    (["queued", "segmenting", "interpreting"].includes(job.status) ||
      job.sam.status === "running");
  const endpointRunning =
    job?.scene?.status === "queued" || job?.scene?.status === "running";
  const currentVerification = view?.verifications
    .filter((v) => v.captureId === boundCapture?.plan.captureId)
    .at(-1);
  const finding = view?.comparison?.findings[0];
  const isFault = finding?.status === "confirmed_fault";
  const isVerification = boundCapture?.plan.purpose === "verification";
  const poseFailed =
    (boundCapture?.poseEvidence as { valid?: boolean } | null)?.valid === false;
  const phase =
    pending || analyzing || !photo
      ? 0
      : !boundCapture?.freshReview || !qualified
        ? 1
        : 2;
  const hasName = !!reviewer.trim();
  const note = (fallback: string) =>
    reason.trim().length >= 8 ? reason.trim() : fallback;
  const wireAssessment =
    boundCapture?.freshReview &&
    ["fault_found", "repair_guidance", "resolved"].includes(
      view?.session.state ?? "",
    )
      ? {
          id: boundCapture.freshReview.wireCandidateId,
          status:
            view?.session.state === "resolved"
              ? ("restored" as const)
              : ("fault" as const),
        }
      : null;
  const selectWire = (id: string | null) => {
    setSelected(id);
    if (
      id &&
      result?.objects.some(
        (o) => o.id === id && o.type === "jumper_wire" && o.mask,
      )
    ) {
      setWireId(id);
      setFreshConfirmed(false);
    }
  };
  const photoShown = pending ?? photo;
  const showCapture = displayMode === "capture" && !!photoShown;
  const captureAspect = photoShown
    ? photoShown.width / photoShown.height
    : videoAspect;
  const endChoices =
    view?.graph && profile ? destinationHoles(view, holes) : [];
  const begin = async () => {
    await start();
    setDisplayMode("live");
    if (!view) keep(await api("create"));
  };
  const takeFrame = async (verify = false) => {
    setCapturing(true);
    try {
      if (!cameraOn) await start();
      const session = view ?? (await api("create"));
      if (!view) keep(session);
      await stageCapture(
        verify ? "verification" : qualified ? "assessment" : "setup",
        session,
      );
      setDisplayMode("capture");
      setCannotSee(false);
    } finally {
      if (alive.current) setCapturing(false);
    }
  };
  const reviewCapture = async () => {
    if (!boundCapture || !input) return;
    const v = await api("review-capture", {
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
      reviewer: reviewer.trim(),
      reason: note(
        `Reviewer confirmed J1 identity, intact continuity and visible insertions at ${anchored} and ${moving}; the other circuit contacts remain unchanged in this captured image.`,
      ),
    });
    keep(v);
    if (isVerification && repair)
      keep(
        await api("verify-repair", {
          captureId: boundCapture.plan.captureId,
          repairId: repair.repairId,
        }),
      );
  };
  const exportInspection = async () => {
    if (!view) return;
    const data = await json(
      await fetch(`/api/circuit-sessions/${view.session.sessionId}/evidence`, {
        cache: "no-store",
        signal: abort.current.signal,
      }),
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    urls.current.push(url);
    const link = document.createElement("a");
    link.href = url;
    link.download = "praxis-circuit-session-evidence.json";
    link.click();
  };
  const chooseImageHole = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!picking || !input || !photo || !showCapture || pending) return;
    const r = event.currentTarget.getBoundingClientRect(),
      point = {
        x: ((event.clientX - r.left) / r.width) * photo.width,
        y: ((event.clientY - r.top) / r.height) * photo.height,
      };
    const matches = input.boards
      .map((b) =>
        pickHole(
          b.calibration as Calibration,
          b.rails as Rail[],
          point,
          "image_click",
        ),
      )
      .filter((v) => !!v);
    if (matches.length !== 1) {
      setError(
        "That point does not identify one clear hole. Zoom in through Circuit setup, or choose its printed coordinate.",
      );
      return;
    }
    const match = matches[0]!,
      value = `${match.breadboardId}/${match.hole}`;
    if (picking === "anchored") setAnchored(value);
    else if (picking === "moving") setMoving(value);
    else {
      setDestination(value);
      setDestinationConfirmed(false);
    }
    setFreshConfirmed(false);
    setPicking(null);
  };
  const choosePoint = (field: "anchored" | "moving" | "destination") => {
    setPicking(field);
    setDisplayMode("capture");
  };
  const saveSetup = async (qualification: "draft" | "verified_human") => {
    await saveProfile(qualification);
    if (qualification === "verified_human") setDrawer(null);
  };
  const clearSession = async () => {
    keep(await api("create"));
    setPhoto(null);
    setJob(null);
    setPending(null);
    setSetupView(null);
    setMapping({});
    setAnchors([]);
    setParts(emptyParts);
    setPhysicalVerified(false);
    setDisplayMode("live");
    setDrawer(null);
  };
  return (
    <main className="bench-app">
      <header className="bench-header">
        <Link href="/" className="bench-brand" aria-label="Praxis home">
          <span className="bench-brand-mark">
            <BenchIcon name="circuit" size={23} />
          </span>
          praxis<span>.</span>
        </Link>
        <span className="bench-header-divider" />
        <span className="bench-product-label">CIRCUIT WORKBENCH</span>
        <div className="bench-header-actions">
          <span
            className={`bench-profile-status ${qualified ? "is-ready" : ""}`}
          >
            <i />
            {profile?.validationScope === "synthetic_fixture"
              ? "Synthetic fixture"
              : qualified
                ? "Circuit ready"
                : "Setup required"}
          </span>
          <button
            className="bench-icon-button"
            aria-label="Open workbench settings"
            onClick={() => setDrawer("settings")}
          >
            <BenchIcon name="settings" />
          </button>
        </div>
      </header>
      <div className="bench-heading">
        <div>
          <span className="bench-eyebrow">FROM CIRCUIT TO CLARITY</span>
          <h1>Your circuit. In focus.</h1>
          <p>See the connections. Find the break. Make the fix.</p>
        </div>
        <ol className="bench-steps" aria-label="Inspection progress">
          {["Capture", "Review", "Repair & verify"].map((label, i) => (
            <li
              key={label}
              className={
                phase === i ? "is-current" : phase > i ? "is-complete" : ""
              }
              aria-current={phase === i ? "step" : undefined}
            >
              <span>
                {phase > i ? (
                  <BenchIcon name="check" size={14} />
                ) : (
                  String(i + 1).padStart(2, "0")
                )}
              </span>
              {label}
            </li>
          ))}
        </ol>
      </div>
      {error && !drawer && (
        <div className="bench-alert" role="alert">
          <BenchIcon name="bolt" />
          <span>{friendlyCameraError(error)}</span>
          <button
            className="bench-icon-button"
            aria-label="Dismiss message"
            onClick={() => setError("")}
          >
            <BenchIcon name="close" size={16} />
          </button>
        </div>
      )}
      <div className="bench-layout">
        <section className="bench-camera-panel" aria-label="Circuit camera">
          <div className="bench-panel-bar">
            <div>
              <span className={`bench-live-dot ${cameraOn ? "is-on" : ""}`} />
              <span>
                {showCapture
                  ? "CAPTURED FRAME"
                  : cameraOn
                    ? "LIVE CAMERA"
                    : "CAMERA"}
              </span>
              {showCapture && (
                <span className="bench-frame-index">
                  {pending
                    ? "Preview"
                    : `Scan ${view?.captures.filter((c) => c.analysisId).length ?? 1}`}
                </span>
              )}
            </div>
            <div className="bench-view-toggle" aria-label="Camera view">
              <button
                aria-pressed={!showCapture}
                onClick={() => setDisplayMode("live")}
              >
                Live
              </button>
              <button
                disabled={!photoShown}
                aria-pressed={showCapture}
                onClick={() => setDisplayMode("capture")}
              >
                Capture
              </button>
            </div>
          </div>
          <BenchViewport aspect={showCapture ? captureAspect : videoAspect}>
            <div
              className={`bench-image-content ${picking && showCapture ? "is-picking" : ""}`}
              onClick={chooseImageHole}
            >
              <video
                ref={video}
                playsInline
                muted
                aria-label="Live circuit camera"
                style={{
                  visibility: showCapture || !cameraOn ? "hidden" : "visible",
                }}
              />
              {showCapture && photoShown && (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photoShown.url}
                    alt={
                      pending
                        ? "Frozen frame awaiting scan approval"
                        : "Captured circuit for inspection"
                    }
                  />
                  {!pending && result && (
                    <CameraEvidenceOverlays
                      result={result}
                      selected={selected}
                      onSelect={selectWire}
                      onHover={setSelected}
                      wireId={
                        boundCapture?.freshReview?.wireCandidateId ?? wireId
                      }
                      status={wireAssessment?.status ?? null}
                    />
                  )}
                </>
              )}
              {!showCapture &&
                liveAligned &&
                result &&
                boundCapture?.freshReview && (
                  <CameraEvidenceOverlays
                    result={result}
                    selected={selected}
                    onSelect={selectWire}
                    onHover={setSelected}
                    wireId={boundCapture.freshReview.wireCandidateId}
                    status={wireAssessment?.status ?? null}
                  />
                )}{" "}
              {capturedRepair &&
                repair &&
                photo &&
                ((showCapture && !pending) ||
                  (!showCapture && liveAligned)) && (
                  <RepairArrow
                    repair={repair}
                    width={photo.width}
                    height={photo.height}
                  />
                )}{" "}
              {showCapture && !pending && input && photo && (
                <ContactMarkers
                  input={input}
                  image={photo}
                  values={[anchored, moving]}
                />
              )}
            </div>
            {!cameraOn && !showCapture && (
              <div className="bench-camera-empty">
                <div className="bench-reticle">
                  <BenchIcon name="camera" size={35} />
                </div>
                <span className="bench-eyebrow">
                  A CLEAR VIEW IS THE FIRST CONNECTION
                </span>
                <h2>Bring your circuit into view.</h2>
                <p>
                  Position your breadboard under a fixed camera.
                  <br />
                  We’ll take it one connection at a time.
                </p>
                <button
                  className="bench-button bench-button-lime"
                  disabled={busy}
                  onClick={() => work(begin)}
                >
                  <BenchIcon name="camera" />
                  {busy ? "Connecting…" : "Start camera"}
                  <BenchIcon name="arrow" size={17} />
                </button>
                <button
                  className="bench-text-light"
                  disabled={busy}
                  onClick={() =>
                    work(async () => {
                      const id = localStorage.getItem("praxis-camera-session");
                      if (!id)
                        throw Error(
                          "No saved inspection on this browser yet. Start your camera to begin.",
                        );
                      await openSession(id);
                      setDisplayMode("capture");
                    })
                  }
                >
                  <BenchIcon name="history" size={14} />
                  Continue previous inspection
                </button>
              </div>
            )}
            {analyzing && (
              <div className="bench-scan-overlay" aria-live="polite">
                <div className="bench-scan-line" />
                <span>
                  <i className="bench-spinner" />
                  Inspecting your circuit…
                </span>
              </div>
            )}
            {picking && showCapture && (
              <div className="bench-picking-note">
                Click the{" "}
                {picking === "anchored"
                  ? "R2-side insertion"
                  : picking === "moving"
                    ? "LED-side insertion"
                    : "empty destination hole"}
                <button onClick={() => setPicking(null)}>Cancel</button>
              </div>
            )}
          </BenchViewport>
          <div className="bench-camera-status">
            <span>
              <i className={cameraOn ? "bench-indicator-on" : ""} />
              {showCapture
                ? pending
                  ? "Review this frame before analysis"
                  : "Results belong to this captured frame"
                : cameraOn
                  ? "Camera connected · scans run on request"
                  : "Camera is off"}
            </span>
            {cameraOn && (
              <button className="bench-link-button" onClick={stop}>
                Disconnect
              </button>
            )}
          </div>
          <div className="bench-capture-controls">
            <div>
              <BenchIcon name="scan" />
              <span>
                {qualified
                  ? "Keep the board fixed and both jumper ends visible."
                  : "Start with your healthy two-LED circuit."}
              </span>
            </div>
            <button
              className="bench-button bench-button-dark"
              disabled={busy || !cameraOn || !!pending || analyzing}
              aria-busy={capturing}
              onClick={() => work(() => takeFrame())}
            >
              <BenchIcon name="camera" />
              {capturing
                ? "Preparing capture…"
                : qualified
                  ? "Capture circuit"
                  : "Capture setup"}
            </button>
          </div>
          {boundCapture?.freshReview && cameraOn && (
            <label className="bench-live-guidance">
              <input
                type="checkbox"
                checked={clearView}
                onChange={(e) => setClearView(e.target.checked)}
              />
              Show last-scan overlays while the circuit is clear and stationary.
              <span>
                {clearView
                  ? liveAligned
                    ? "View aligned"
                    : liveReason
                  : "Live guidance pauses when the view changes."}
              </span>
            </label>
          )}
        </section>
        <aside className="bench-inspector" aria-label="Inspection guidance">
          <div className="bench-inspector-heading">
            <span className="bench-eyebrow">YOUR NEXT CONNECTION</span>
            <BenchIcon name="circuit" />
          </div>
          {pending && currentCapture ? (
            <div className="bench-task">
              <span className="bench-task-index">01 / CAPTURE</span>
              <h2>Ready to inspect?</h2>
              <p>
                Check that the board, component legs and wire ends are sharp and
                unobscured.
              </p>
              <div className="bench-scan-consent">
                <BenchIcon name="scan" />
                <div>
                  <strong>Send this frame to Meta</strong>
                  <span>
                    Up to 4 detection requests ·{" "}
                    {(currentCapture.plan.budget.samPixels / 1000000).toFixed(
                      2,
                    )}{" "}
                    MP total · no automatic retries.
                  </span>
                </div>
              </div>
              <details className="bench-disclosure">
                <summary>Processing details</summary>
                <p>
                  {currentCapture.plan.providerBaseUrl} ·{" "}
                  {currentCapture.plan.samModel}. This scan makes no Muse
                  requests. Optional wire-end assistance is approved separately.
                </p>
              </details>
              <button
                className="bench-button bench-button-dark bench-full"
                disabled={busy}
                onClick={() => work(upload)}
              >
                {busy ? "Sending frame…" : "Analyze frame"}
                <BenchIcon name="arrow" size={17} />
              </button>
              <button
                className="bench-button bench-button-quiet bench-full"
                disabled={busy}
                onClick={() => {
                  setPending(null);
                  setDisplayMode("live");
                }}
              >
                Retake frame
              </button>
            </div>
          ) : analyzing ? (
            <div className="bench-task">
              <span className="bench-task-index">01 / INSPECTING</span>
              <h2>Tracing the details.</h2>
              <p>
                Keep your circuit in place. We’re identifying the components and
                wire regions in this frame.
              </p>
              <div className="bench-analysis-steps">
                <span className="is-active">
                  <i className="bench-spinner" />
                  Finding components
                </span>
                <span>
                  <span className="bench-step-dot" />
                  Preparing your review
                </span>
              </div>
            </div>
          ) : !cameraOn && !photo ? (
            <div className="bench-task">
              <span className="bench-task-index">01 / GET STARTED</span>
              <h2>
                A good view.
                <br />A better diagnosis.
              </h2>
              <p>
                Connect your camera, frame the breadboard, then capture a clear
                image to begin.
              </p>
              <ul className="bench-checklist">
                <li>
                  <BenchIcon name="check" size={15} />
                  Camera directly above the board
                </li>
                <li>
                  <BenchIcon name="check" size={15} />
                  Even light, visible insertion points
                </li>
                <li>
                  <BenchIcon name="check" size={15} />A fixed view throughout
                  the repair
                </li>
              </ul>
            </div>
          ) : job?.sam.status === "failed" ||
            job?.sam.status === "interrupted" ||
            job?.sam.status === "timed_out" ? (
            <div className="bench-task">
              <span className="bench-task-index">SCAN INCOMPLETE</span>
              <h2>Let’s get a clearer capture.</h2>
              <p>
                This scan did not finish. It will not retry automatically. Check
                your connection, then capture and approve a new frame.
              </p>
              <button
                className="bench-button bench-button-dark bench-full"
                disabled={busy}
                onClick={() => work(() => takeFrame())}
              >
                Capture again
              </button>
            </div>
          ) : !qualified ? (
            <div className="bench-task">
              <span className="bench-task-index">
                {photo ? "02 / ONE-TIME SETUP" : "01 / FRAME YOUR CIRCUIT"}
              </span>
              <h2>
                {photo
                  ? "Give your circuit a reference."
                  : "Frame the healthy circuit."}
              </h2>
              <p>
                {photo
                  ? "Before diagnosing a fault, identify the healthy circuit’s parts, contacts and breadboard grid. You only need to do this once for a fixed setup."
                  : "Keep the entire breadboard in view, with the green and red LED branches clearly separated."}
              </p>
              {photo && (
                <button
                  className="bench-button bench-button-dark bench-full"
                  disabled={busy}
                  onClick={() => {
                    setSetupStep(0);
                    setDrawer("setup");
                  }}
                >
                  Set up circuit
                  <BenchIcon name="arrow" size={17} />
                </button>
              )}
              <div className="bench-reference-card">
                <div>
                  <BenchIcon name="circuit" />
                  <strong>Two-LED indicator</strong>
                </div>
                <CircuitBlueprint />
                <span>Green: power indicator · Red: button-controlled</span>
              </div>
            </div>
          ) : !boundCapture || boundCapture.plan.purpose === "setup" ? (
            <div className="bench-task">
              <span className="bench-task-index">01 / READY TO CAPTURE</span>
              <h2>Your workbench is ready.</h2>
              <p>
                Capture the circuit as it is now. Praxis will compare the
                reviewed connections with your saved reference.
              </p>
              <div className="bench-reference-badge">
                <BenchIcon name="check" />
                <span>Two-LED circuit setup verified</span>
              </div>
              <button
                className="bench-button bench-button-dark bench-full"
                disabled={busy}
                onClick={() => work(() => takeFrame())}
              >
                {cameraOn ? "Capture circuit" : "Connect camera & capture"}
                <BenchIcon name="arrow" size={17} />
              </button>
            </div>
          ) : !input ? (
            <div className="bench-task">
              <span className="bench-task-index">02 / ALIGNMENT</span>
              <h2>
                {poseFailed ? "The view has changed." : "Check the fixed view."}
              </h2>
              <p>
                {poseFailed
                  ? "Return the camera and board to their setup positions. Make sure the four fixed marks are visible, then capture again."
                  : "Match this capture to the saved setup before reusing the board grid. Jumper contacts still need a fresh review."}
              </p>
              <button
                className="bench-button bench-button-dark bench-full"
                disabled={busy}
                onClick={() =>
                  work(async () =>
                    keep(
                      await api("seed-capture", {
                        captureId: boundCapture.plan.captureId,
                      }),
                    ),
                  )
                }
              >
                {busy ? "Checking alignment…" : "Check camera alignment"}
              </button>
              {poseFailed && (
                <button
                  className="bench-button bench-button-quiet bench-full"
                  disabled={busy}
                  onClick={() => work(() => takeFrame(isVerification))}
                >
                  Retake frame
                </button>
              )}
            </div>
          ) : !boundCapture.freshReview ? (
            <div className="bench-task">
              <span className="bench-task-index">02 / REVIEW CONTACTS</span>
              <h2>Follow the jumper.</h2>
              <p>
                Select J1 in the capture, then identify where its two metal ends
                enter the board. Confirm what you can actually see.
              </p>
              <label>
                J1 · the movable jumper
                <select
                  aria-label="Observed J1 wire"
                  value={wireId}
                  onChange={(e) => selectWire(e.target.value)}
                >
                  <option value="">Select a wire in the image</option>
                  {result?.objects
                    .filter((o) => o.type === "jumper_wire" && o.mask)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.id.replace("jumper_wire_", "Wire ")}
                        {selected === o.id ? " · selected" : ""}
                      </option>
                    ))}
                </select>
              </label>
              <div className="bench-endpoints">
                <HoleField
                  label="R2-side end"
                  value={anchored}
                  onChange={(v) => {
                    setAnchored(v);
                    setFreshConfirmed(false);
                  }}
                  holes={holes}
                  onPick={() => choosePoint("anchored")}
                />
                <HoleField
                  label="LED-side end"
                  value={moving}
                  onChange={(v) => {
                    setMoving(v);
                    setFreshConfirmed(false);
                  }}
                  holes={holes}
                  onPick={() => choosePoint("moving")}
                />
              </div>
              <label className="bench-confirmation">
                <input
                  type="checkbox"
                  checked={freshConfirmed}
                  onChange={(e) => setFreshConfirmed(e.target.checked)}
                />
                <span>
                  I checked J1’s identity, intact wire and both visible
                  contacts. The other circuit contacts are unchanged.
                </span>
              </label>
              <ReviewerField
                value={reviewer}
                onChange={(v) => {
                  setReviewer(v);
                  localStorage.setItem("praxis-reviewer", v);
                }}
              />
              {cannotSee && (
                <div className="bench-uncertain">
                  <p role="status">
                    Connection unconfirmed. Clear the contact areas and retake
                    the frame; hidden insertions cannot be verified.
                  </p>
                  <button
                    className="bench-link-button"
                    disabled={busy}
                    onClick={() => work(() => takeFrame(isVerification))}
                  >
                    Retake with a clear view
                  </button>
                </div>
              )}
              <button
                className="bench-button bench-button-dark bench-full"
                disabled={
                  busy ||
                  !freshConfirmed ||
                  !hasName ||
                  !wireId ||
                  !anchored ||
                  !moving
                }
                onClick={() => work(reviewCapture)}
              >
                {isVerification
                  ? "Confirm & verify repair"
                  : "Confirm contacts & inspect"}
                <BenchIcon name="arrow" size={17} />
              </button>
              <button
                className="bench-link-button bench-full"
                onClick={() => {
                  setFreshConfirmed(false);
                  setCannotSee(true);
                }}
              >
                I can’t see both contacts
              </button>
              <details className="bench-disclosure">
                <summary>Help locate the wire ends</summary>
                <p>
                  Request visual suggestions for this selected wire. You will
                  still review the actual contacts.
                </p>
                {!boundCapture.endpointPlan ? (
                  <button
                    className="bench-button bench-button-quiet bench-full"
                    disabled={busy || !wireId}
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
                    Prepare wire-end assistance
                  </button>
                ) : (
                  <>
                    {!endpointMatches && (
                      <p>
                        Assistance was prepared for{" "}
                        {preparedWire?.replace("jumper_wire_", "Wire ") ??
                          "another wire"}
                        . Select that wire to use the prepared request.
                      </p>
                    )}
                    <p>
                      One Muse request to Meta ·{" "}
                      {boundCapture.endpointPlan.pixels.toLocaleString()} image
                      pixels · no retries.
                    </p>
                    <button
                      className="bench-button bench-button-quiet bench-full"
                      disabled={
                        busy ||
                        !!boundCapture.endpointRequestedAt ||
                        !endpointMatches
                      }
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
                      {endpointRunning
                        ? "Locating ends…"
                        : boundCapture.endpointRequestedAt
                          ? "Request already used"
                          : "Approve wire-end assistance"}
                    </button>
                  </>
                )}
                {!!proposal && <EndpointSummary value={proposal} />}{" "}
                {boundCapture.endpointError && (
                  <p>{boundCapture.endpointError}</p>
                )}
              </details>
            </div>
          ) : currentVerification ? (
            <div
              className={`bench-task bench-result is-${currentVerification.status}`}
            >
              <span className="bench-result-icon">
                <BenchIcon
                  name={
                    currentVerification.status === "resolved" ? "check" : "bolt"
                  }
                  size={27}
                />
              </span>
              <span className="bench-task-index">03 / VERIFICATION</span>
              <h2>
                {currentVerification.status === "resolved"
                  ? "Connection restored."
                  : currentVerification.status === "not_resolved"
                    ? "The break is still there."
                    : "Let’s check that again."}
              </h2>
              <p>
                {currentVerification.status === "resolved"
                  ? "The fresh capture supports the expected R2-to-D2 connection. Now press the button and check that the red LED lights."
                  : currentVerification.status === "not_resolved"
                    ? "J1 still misses the required connection. Check its LED-side insertion and capture another clear view."
                    : "We do not have enough clear, current evidence to confirm this repair. Review the contacts before trying again."}
              </p>
              {currentVerification.status === "resolved" && (
                <div className="bench-success-note">
                  Wiring verified from reviewed image evidence. LED operation is
                  checked physically.
                </div>
              )}
              <button
                className="bench-button bench-button-dark bench-full"
                disabled={busy}
                onClick={() =>
                  work(() =>
                    takeFrame(currentVerification.status !== "resolved"),
                  )
                }
              >
                Capture again
              </button>
            </div>
          ) : isVerification && repair ? (
            <div className="bench-task">
              <span className="bench-task-index">03 / VERIFY</span>
              <h2>Check the new connection.</h2>
              <p>
                This is a fresh, reviewed capture. Compare it with the original
                fault to verify the repair.
              </p>
              <button
                className="bench-button bench-button-dark bench-full"
                disabled={busy}
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
                Verify connection
                <BenchIcon name="check" />
              </button>
            </div>
          ) : capturedRepair && repair ? (
            <div className="bench-task bench-result is-fault">
              <span className="bench-task-index">03 / MAKE THE FIX</span>
              <h2>
                One end.
                <br />
                One move.
              </h2>
              <p>
                Move J1’s LED-side end to the highlighted hole. Keep its R2-side
                end in place.
              </p>
              <div className="bench-hole-route">
                <div>
                  <span>FROM</span>
                  <strong>{repair.from.holeId.toUpperCase()}</strong>
                </div>
                <BenchIcon name="arrow" size={25} />
                <div>
                  <span>TO</span>
                  <strong>{repair.to.holeId.toUpperCase()}</strong>
                </div>
              </div>
              <p className="bench-small">
                The arrow belongs to this captured frame. Clear the view after
                moving the wire, then capture the repair.
              </p>
              <button
                className="bench-button bench-button-dark bench-full"
                disabled={busy}
                onClick={() => work(() => takeFrame(true))}
              >
                Capture repair
                <BenchIcon name="camera" />
              </button>
            </div>
          ) : isFault ? (
            <div className="bench-task bench-result is-fault">
              <span className="bench-task-index">02 / CONNECTION MISSING</span>
              <h2>Found the break.</h2>
              <p>
                The expected R2-to-D2 connection is missing. J1’s LED-side end
                is on a different strip from the red LED’s anode.
              </p>
              <HoleField
                label="Available hole on the LED anode strip"
                value={destination}
                onChange={(v) => {
                  setDestination(v);
                  setDestinationConfirmed(false);
                }}
                holes={endChoices}
                onPick={() => choosePoint("destination")}
              />
              {!endChoices.length && (
                <p className="bench-uncertain">
                  No clear destination is available. Review the LED’s terminal
                  mapping in Circuit setup.
                </p>
              )}
              <label className="bench-confirmation">
                <input
                  type="checkbox"
                  checked={destinationConfirmed}
                  onChange={(e) => setDestinationConfirmed(e.target.checked)}
                />
                <span>
                  This destination hole is visibly empty and accessible.
                </span>
              </label>
              <button
                className="bench-button bench-button-dark bench-full"
                disabled={
                  busy || !destination || !destinationConfirmed || !hasName
                }
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
                        reviewer: reviewer.trim(),
                        reason: note(
                          `Reviewer confirmed ${destination} is visibly empty and accessible for the single-end J1 repair.`,
                        ),
                      }),
                    ),
                  )
                }
              >
                Show repair
                <BenchIcon name="arrow" />
              </button>
            </div>
          ) : (
            <div className="bench-task bench-result">
              <span className="bench-task-index">02 / INSPECTION</span>
              <h2>
                {finding?.status === "no_fault"
                  ? "This connection checks out."
                  : "A closer look is needed."}
              </h2>
              <p>
                {finding?.status === "no_fault"
                  ? "The reviewed R2-to-D2 connection matches your reference. This check covers the selected connection; it does not establish full circuit operation."
                  : "Confirm the wire identity and contact positions before attributing a fault. Unclear contacts stay unconfirmed."}
              </p>
              <button
                className="bench-button bench-button-dark bench-full"
                disabled={busy}
                onClick={() => work(() => takeFrame())}
              >
                Capture another view
              </button>
            </div>
          )}
          <div className="bench-inspector-foot">
            <BenchIcon name="eye" />
            <span>Evidence first. Unclear contacts stay unconfirmed.</span>
          </div>
        </aside>
      </div>
      <section className="bench-circuit-strip">
        <div className="bench-tabs" role="tablist" aria-label="Circuit views">
          <button
            role="tab"
            id="connections-tab"
            aria-controls="connections-panel"
            aria-selected={circuitTab === "observed"}
            onClick={() => setCircuitTab("observed")}
          >
            Observed connections
            {view?.graph && <span>{view.graph.wires.length}</span>}
          </button>
          <button
            role="tab"
            id="reference-tab"
            aria-controls="reference-panel"
            aria-selected={circuitTab === "reference"}
            onClick={() => setCircuitTab("reference")}
          >
            Expected circuit
          </button>
        </div>
        {circuitTab === "observed" ? (
          <div
            role="tabpanel"
            id="connections-panel"
            aria-labelledby="connections-tab"
          >
            {view?.graph ? (
              <CircuitGraph
                graph={view.graph}
                selected={selected}
                onSelect={setSelected}
                faultWireId={profile?.mapping.J1 ?? null}
                fault={isFault}
              />
            ) : (
              <div className="bench-graph-empty">
                <BenchIcon name="circuit" size={26} />
                <div>
                  <strong>Your connections will appear here.</strong>
                  <p>
                    Capture and review the circuit to explore its observed
                    wiring.
                  </p>
                </div>
                <span>WIRE ↔ GRAPH</span>
              </div>
            )}
          </div>
        ) : (
          <div
            className="bench-expected"
            role="tabpanel"
            id="reference-panel"
            aria-labelledby="reference-tab"
          >
            <CircuitBlueprint />
            <div>
              <strong>Two-LED button indicator</strong>
              <p>
                Green stays on with power. Red lights while the normally-open
                button is pressed.
              </p>
              <span>
                Intended design ·{" "}
                {qualified
                  ? "physical setup reviewed"
                  : "physical setup not yet verified"}
              </span>
            </div>
          </div>
        )}
      </section>
      <footer className="bench-footer">
        <span>
          <i />
          PRAXIS · SEE THE CIRCUIT, UNDERSTAND THE CONNECTION
        </span>
        <button
          className="bench-link-button"
          onClick={() => setDrawer("setup")}
        >
          Circuit setup
          <BenchIcon name="settings" size={14} />
        </button>
      </footer>
      {drawer === "setup" && (
        <BenchDialog
          title="Set up your circuit"
          onClose={() => setDrawer(null)}
          wide
        >
          <p className="bench-dialog-intro">
            Create a trusted healthy reference once. Each later scan reviews
            J1’s current contacts.
          </p>
          <nav className="bench-setup-steps" aria-label="Circuit setup steps">
            {["Map the board", "Identify the parts", "Save the reference"].map(
              (name, i) => (
                <button
                  key={name}
                  aria-current={setupStep === i ? "step" : undefined}
                  disabled={!photo || (i > 0 && !setupView?.source)}
                  onClick={() => setSetupStep(i)}
                >
                  <span>{i + 1}</span>
                  {name}
                </button>
              ),
            )}
          </nav>
          {error && (
            <p role="alert" className="bench-inline-error">
              {friendlyCameraError(error)}
            </p>
          )}
          {!photo ? (
            <div className="bench-dialog-body">
              <h3>Start with a healthy capture.</h3>
              <p>
                Connect your camera and capture the complete board before
                mapping its parts.
              </p>
              <button
                className="bench-button bench-button-dark"
                onClick={() => setDrawer(null)}
              >
                Return to camera
              </button>
            </div>
          ) : setupStep === 0 ? (
            <div className="bench-dialog-body">
              <h3>Give every contact a place.</h3>
              <p>
                Calibrate the breadboard, identify component terminals and
                confirm the healthy wiring using the mapping tools. J1 contact{" "}
                <b>a</b> is the fixed R2-side end; <b>b</b> is the movable
                LED-side end.
              </p>
              <details className="bench-mapping-tools" open>
                <summary>Board and contact mapping</summary>
                <ImagePreview
                  setupOnly
                  photograph={photo}
                  result={result}
                  analysisJob={job}
                  loading={analyzing}
                  selecting={false}
                  dragging={false}
                  showOverlays
                  selectedId={selected}
                  analysisRunId={job?.analysisId ?? null}
                  onSelect={setSelected}
                  onHover={setSelected}
                  onConnectivityChange={connectivityChanged}
                  onChoose={() => {}}
                />
              </details>
              <button
                className="bench-button bench-button-dark"
                disabled={busy || !job}
                onClick={() =>
                  work(async () => {
                    await loadSetup();
                    setSetupStep(1);
                  })
                }
              >
                Continue to parts
                <BenchIcon name="arrow" />
              </button>
            </div>
          ) : setupStep === 1 ? (
            <div className="bench-dialog-body">
              <h3>Match the reference to your components.</h3>
              <p>
                Use seven distinct reviewed objects. These names link the real
                board to its intended circuit.
              </p>
              <div className="bench-form-grid">
                {demoPartIds.map((id) => (
                  <label key={id}>
                    <span className="bench-part-id">{id}</span>
                    {partLabels[id]}
                    <select
                      value={mapping[id] ?? ""}
                      onChange={(e) =>
                        setMapping({ ...mapping, [id]: e.target.value })
                      }
                    >
                      <option value="">Choose reviewed component</option>
                      {setupView?.source?.input.components.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label} · {c.type.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <h3>Verify the actual parts.</h3>
              <div className="bench-form-grid">
                {(
                  [
                    { key: "supplyVolts", label: "Supply voltage (V)" },
                    { key: "r1Ohms", label: "Green LED resistor (Ω)" },
                    { key: "r2Ohms", label: "Red LED resistor (Ω)" },
                  ] as const
                ).map(({ key, label }) => (
                  <label key={key}>
                    {label}
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
                    {
                      key: "ledSource",
                      label: "LED polarity and specification source",
                    },
                    { key: "switchPart", label: "Pushbutton part" },
                    {
                      key: "switchContacts",
                      label: "Verified pushbutton contact mapping",
                    },
                    {
                      key: "schematicSource",
                      label: "Reference schematic source",
                    },
                  ] as const
                ).map(({ key, label }) => (
                  <label key={key}>
                    {label}
                    <input
                      value={parts[key]}
                      onChange={(e) =>
                        setParts({ ...parts, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="bench-small">
                Values shown initially are suggestions. Enter the values and
                contact mapping verified on this physical assembly.
              </p>
              <button
                className="bench-button bench-button-dark"
                disabled={
                  demoPartIds.some((id) => !mapping[id]) ||
                  new Set(Object.values(mapping)).size !== 7
                }
                onClick={() => setSetupStep(2)}
              >
                Continue to reference
                <BenchIcon name="arrow" />
              </button>
            </div>
          ) : (
            <div className="bench-dialog-body">
              <h3>Keep the camera reference fixed.</h3>
              <LandmarkPicker
                url={photo.url}
                width={photo.width}
                height={photo.height}
                points={anchors}
                onChange={setAnchors}
              />
              <ReviewerField
                value={reviewer}
                onChange={(v) => {
                  setReviewer(v);
                  localStorage.setItem("praxis-reviewer", v);
                }}
              />
              <label className="bench-confirmation">
                <input
                  type="checkbox"
                  checked={physicalVerified}
                  onChange={(e) => setPhysicalVerified(e.target.checked)}
                />
                <span>
                  I checked this healthy physical assembly, the supply, resistor
                  values, LED polarity, switch contacts and board topology
                  against the reference.
                </span>
              </label>
              <div className="bench-inline">
                <button
                  className="bench-button bench-button-dark"
                  disabled={
                    busy ||
                    !physicalVerified ||
                    !hasName ||
                    anchors.length !== 4
                  }
                  onClick={() => work(() => saveSetup("verified_human"))}
                >
                  Save verified setup
                  <BenchIcon name="check" />
                </button>
                <button
                  className="bench-link-button"
                  disabled={busy || !hasName || anchors.length !== 4}
                  onClick={() => work(() => saveSetup("draft"))}
                >
                  Save draft
                </button>
              </div>
            </div>
          )}
        </BenchDialog>
      )}
      {drawer === "settings" && (
        <BenchDialog title="Workbench settings" onClose={() => setDrawer(null)}>
          <div className="bench-dialog-body">
            {error && (
              <p role="alert" className="bench-inline-error">
                {friendlyCameraError(error)}
              </p>
            )}
            <h3>Camera</h3>
            <label>
              Video input
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
            </label>
            <p className="bench-small">
              Disconnect the camera before changing its input.
            </p>
            <button
              className="bench-button bench-button-quiet"
              disabled={busy}
              onClick={() => {
                setDrawer("setup");
                setSetupStep(0);
              }}
            >
              Edit circuit setup
            </button>
            <h3>Saved inspections</h3>
            <button
              className="bench-button bench-button-quiet"
              disabled={busy}
              onClick={() =>
                work(async () => {
                  const id = localStorage.getItem("praxis-camera-session");
                  if (!id)
                    throw Error("No saved inspection on this browser yet.");
                  await openSession(id);
                  setDisplayMode("capture");
                  setDrawer(null);
                })
              }
            >
              <BenchIcon name="history" />
              Resume previous inspection
            </button>
            <details className="bench-disclosure">
              <summary>Open an inspection by its saved ID</summary>
              <label>
                Inspection ID
                <input
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                />
              </label>
              <button
                className="bench-button bench-button-quiet"
                disabled={busy || !sessionId}
                onClick={() =>
                  work(async () => {
                    await openSession(sessionId);
                    setDisplayMode("capture");
                    setDrawer(null);
                  })
                }
              >
                Open inspection
              </button>
            </details>
            <details className="bench-disclosure">
              <summary>Use an existing healthy setup capture</summary>
              <label>
                Saved analysis ID
                <input
                  value={savedId}
                  onChange={(e) => setSavedId(e.target.value)}
                />
              </label>
              <button
                className="bench-button bench-button-quiet"
                disabled={busy || !savedId}
                onClick={() =>
                  work(async () => {
                    if (!view) keep(await api("create"));
                    await loadJob(savedId);
                    setSetupView(null);
                    setDisplayMode("capture");
                    setDrawer("setup");
                    setSetupStep(0);
                  })
                }
              >
                Open setup capture
              </button>
            </details>
            <h3>Inspection record</h3>
            <p>
              Download the captures, reviewed connections, repair decisions and
              processing record for this inspection.
            </p>
            <button
              className="bench-button bench-button-quiet"
              disabled={busy || !view}
              onClick={() => work(exportInspection)}
            >
              <BenchIcon name="download" />
              Export inspection
            </button>
            <details className="bench-disclosure">
              <summary>Processing record</summary>
              <p>
                {view?.requests.length ?? 0} provider requests recorded.
                Interrupted requests are not silently repeated.
              </p>
              {view?.requests.map((r) => (
                <div className="bench-record" key={r.requestId}>
                  <span>{r.stage.replaceAll(".", " / ")}</span>
                  <span>
                    {r.status === "unknown"
                      ? "Usage uncertain"
                      : r.status === "response_received"
                        ? "Response received"
                        : "Not sent"}
                    {r.latencyMs !== null
                      ? ` · ${(r.latencyMs / 1000).toFixed(1)} s`
                      : ""}
                  </span>
                </div>
              ))}
            </details>
            <label>
              Optional review note
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Add context to the next review"
              />
            </label>
            <div className="bench-settings-bottom">
              <button
                className="bench-link-button"
                disabled={busy}
                onClick={() => work(clearSession)}
              >
                Start a new inspection
              </button>
            </div>
          </div>
        </BenchDialog>
      )}
    </main>
  );
}
function HoleField({
  label,
  value,
  onChange,
  holes,
  onPick,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  holes: { value: string; label: string }[];
  onPick?: () => void;
}) {
  return (
    <div className="bench-hole-field">
      <label>
        {label}
        <select
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose a hole</option>
          {holes.map((h) => (
            <option key={h.value} value={h.value}>
              {h.label.replace(/^.* \/ /, "").toUpperCase()}
            </option>
          ))}
        </select>
      </label>
      {onPick && (
        <button className="bench-link-button" onClick={onPick}>
          <BenchIcon name="scan" size={14} />
          Pick on image
        </button>
      )}
    </div>
  );
}
function ReviewerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="bench-reviewer">
      Reviewed by
      <input
        aria-label="Your name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="name"
        placeholder="Your name"
      />
    </label>
  );
}
function ContactMarkers({
  input,
  image,
  values,
}: {
  input: NonNullable<CircuitSessionView["input"]>;
  image: { width: number; height: number };
  values: string[];
}) {
  return (
    <svg
      className="bench-contact-markers"
      viewBox={`0 0 ${image.width} ${image.height}`}
      aria-label="Selected insertion points"
    >
      {values.map((v, i) => {
        const split = v.indexOf("/"),
          b = input.boards.find((b) => b.id === v.slice(0, split)),
          h =
            b &&
            allHoles(b.calibration as Calibration, b.rails as Rail[]).find(
              (h) => h.id === v.slice(split + 1),
            );
        if (!b || !h) return null;
        const p = project(b.calibration as Calibration, h.grid);
        return (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="10" />
            <text x={p.x} y={p.y - 16}>
              {i === 0 ? "A" : "B"}
            </text>
          </g>
        );
      })}
    </svg>
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
