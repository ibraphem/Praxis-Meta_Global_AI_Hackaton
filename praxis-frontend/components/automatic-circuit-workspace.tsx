"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { measureBreadboard, measureEndpoints } from "@/lib/cv/browser";
import { confirmClearProposals, canConfirmMeasuredGrid } from "@/lib/cv/review";
import type { GeometryResult } from "@/lib/cv/geometry";
import "./circuit-camera.css";
import "./automatic-circuit.css";

type Observations = NonNullable<CircuitInspection["observations"]>;
type Picking =
  | { kind: "terminal"; id: string }
  | { kind: "landmark"; board: number; index: number }
  | { kind: "rail"; board: number; index: number; end: "first" | "last" };
type VerificationSource = {
  sourceInspectionId: string;
  goal: string;
  instruction: string;
};
function photoCalloutLayouts(
  components: { id: string; bbox: [number, number, number, number] }[],
  image: { width: number; height: number },
) {
  const radius = Math.max(12, image.width / 58),
    gap = radius * 1.65,
    clampX = (x: number) => Math.max(radius + 2, Math.min(x, image.width - radius - 2)),
    clampY = (y: number) => Math.max(radius + 2, Math.min(y, image.height - radius - 2)),
    placed: { x: number; y: number }[] = [];

  return new Map(
    components.map((component, index) => {
      const [x, y, width, height] = component.bbox,
        candidates = [
          { x: x + width / 2, y: y - gap, anchorX: x + width / 2, anchorY: y },
          {
            x: x + width + gap,
            y: y + height / 2,
            anchorX: x + width,
            anchorY: y + height / 2,
          },
          {
            x: x + width / 2,
            y: y + height + gap,
            anchorX: x + width / 2,
            anchorY: y + height,
          },
          { x: x - gap, y: y + height / 2, anchorX: x, anchorY: y + height / 2 },
        ].map((candidate) => ({
          ...candidate,
          x: clampX(candidate.x),
          y: clampY(candidate.y),
        }));
      const ranked = candidates
        .map((candidate, order) => {
          let penalty = order * 8;
          for (const other of components) {
            if (other.id === component.id) continue;
            const [ox, oy, ow, oh] = other.bbox;
            if (
              candidate.x > ox - radius * 1.2 &&
              candidate.x < ox + ow + radius * 1.2 &&
              candidate.y > oy - radius * 1.2 &&
              candidate.y < oy + oh + radius * 1.2
            )
              penalty += 1000;
          }
          for (const marker of placed)
            if (
              Math.hypot(candidate.x - marker.x, candidate.y - marker.y) <
              radius * 2.8
            )
              penalty += 800;
          return { ...candidate, penalty };
        })
        .sort((a, b) => a.penalty - b.penalty);
      const marker = ranked[0];
      placed.push(marker);
      return [
        component.id,
        { ...marker, radius, number: index + 1 },
      ] as const;
    }),
  );
}
const active = (v: CircuitInspection | null) =>
  v?.status === "queued" || v?.status === "running";
type ProcedureKind = "analyze" | "troubleshoot";
const analysisProcedureScript = [
  "01  FRAME      Locking the full-resolution circuit capture",
  "02  COMPUTER VISION  Measuring the breadboard lattice and centre channel",
  "03  OPENCV.JS   Fitting labelled holes to a perspective-corrected grid",
  "04  SAM 3.1     Segmenting visible wires, leads and component bodies",
  "05  MUSE        Reading component identity and printed board labels",
  "06  GEOMETRY    Snapping exposed endpoints to calibrated terminal holes",
].join("\n");
const troubleshootProcedureScript = [
  "01  EVIDENCE    Building the observed electrical connection graph",
  "02  COLLATING   Collecting confirmed identities and terminal insertions",
  "03  GRAPH       Rebuilding nets from reviewed topology and conductors",
  "04  INTENT      Inferring the intended circuit from confirmed parts",
  "05  COMPARE     Checking observed paths against the required connections",
  "06  SAFETY      Holding uncertain contacts for explicit evidence",
].join("\n");
function adjustedGridIssue(observations: Observations | null) {
  if (!observations?.boards.length) return "Add a board grid first.";
  for (const [index, board] of observations.boards.entries()) {
    const name = observations.boards.length > 1 ? `Board ${index + 1}: ` : "";
    if (board.landmarks.length < 6)
      return `${name}place at least six labelled holes before fitting.`;
    if (
      board.landmarks.some((landmark) =>
        landmark.position.every((v) => v === 0),
      )
    )
      return `${name}use “Place” to mark every added hole in the photograph.`;
    const labels = board.landmarks.map((landmark) => landmark.hole),
      valid = labels.every((label) => {
        const match = /^([a-j])([1-9][0-9]?)$/.exec(label);
        return !!match && Number(match[2]) <= board.rows;
      });
    if (!valid)
      return `${name}use hole labels a1–j${board.rows} that match the printed board.`;
    if (new Set(labels).size !== labels.length)
      return `${name}each landmark must identify a different hole.`;
    const columns = labels.map((label) => {
        const column = "abcdefghij".indexOf(label[0]);
        return column < 5 ? column : column + 2;
      }),
      rows = labels.map((label) => Number(label.slice(1)));
    if (Math.max(...columns) - Math.min(...columns) < 7)
      return `${name}place landmarks on both sides of the centre channel.`;
    if (Math.max(...rows) - Math.min(...rows) < board.rows / 4)
      return `${name}spread landmarks across at least a quarter of the board length.`;
  }
  return null;
}
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
    [saveMessage, setSaveMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [cameraOn, setCameraOn] = useState(false),
    [photo, setPhoto] = useState<string | null>(null),
    [photoDimensions, setPhotoDimensions] = useState<{
      width: number;
      height: number;
    } | null>(null),
    [pending, setPending] = useState<File | null>(null);
  const [dirty, setDirty] = useState(false),
    [gridDirty, setGridDirty] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [picking, setPicking] = useState<Picking | null>(null),
    [gridVisible, setGridVisible] = useState(true),
    [confirmClearChecked, setConfirmClearChecked] = useState(false);
  const [localStage, setLocalStage] = useState(""),
    [localBusy, setLocalBusy] = useState(false),
    [localGeometry, setLocalGeometry] = useState<GeometryResult | null>(null),
    [showAllParts, setShowAllParts] = useState(false),
    [intentGoal, setIntentGoal] = useState(""),
    [diagnosing, setDiagnosing] = useState(false),
    [procedure, setProcedure] = useState<ProcedureKind | null>(null),
    [verificationSource, setVerificationSource] =
      useState<VerificationSource | null>(null);
  const video = useRef<HTMLVideoElement>(null),
    graphSection = useRef<HTMLElement>(null),
    faultSection = useRef<HTMLElement>(null),
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
      setConfirmClearChecked(
        v.status !== "reviewed" &&
          !!v.hybrid?.endpoints.some(
            (endpoint) => endpoint.status === "supported",
          ),
      );
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
    const restoreGeneration = generation.current;
    const id = localStorage.getItem("praxis-automatic-inspection");
    queueMicrotask(() => {
      if (mounted.current) {
        const verification = localStorage.getItem(
          "praxis-repair-verification",
        );
        if (verification) {
          try {
            setVerificationSource(JSON.parse(verification));
          } catch {
            localStorage.removeItem("praxis-repair-verification");
          }
        }
      }
    });
    if (id)
      fetch(`/api/circuit-inspections/${id}`, { cache: "no-store" })
        .then(json)
        .then((v) => {
          if (mounted.current && generation.current === restoreGeneration)
            accept(parseInspection(v, id));
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
  useEffect(() => {
    if (
      !view?.hybrid ||
      active(view) ||
      !view.input ||
      view.hybrid.localStatus !== "pending"
    )
      return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setLocalBusy(true);
        setLocalStage("Matching wire shapes to measured holes on this device");
      }
    });
    void measureEndpoints(view, controller.signal)
      .then(async (endpoints) => {
        const response = await fetch(
          `/api/circuit-inspections/${view.id}/localize`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expectedRevision: view.revision,
              imageHash: view.imageHash,
              endpoints,
            }),
            signal: controller.signal,
          },
        );
        if (response.status === 409) {
          const current = await json(
            await fetch(`/api/circuit-inspections/${view.id}`, {
              signal: controller.signal,
              cache: "no-store",
            }),
          );
          if (!controller.signal.aborted)
            accept(parseInspection(current, view.id));
          return;
        }
        const next = parseInspection(await json(response), view.id);
        if (!controller.signal.aborted) accept(next);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (mounted.current) {
          setLocalBusy(false);
          setLocalStage("");
        }
      });
    return () => controller.abort();
  }, [view, accept]);
  const work = async (fn: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setLocalStage("");
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
    setLocalGeometry(null);
    setLocalStage("");
    setPhotoDimensions(null);
    setSaveMessage("");
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
    setConfirmClearChecked(false);
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
    setProcedure("analyze");
    try {
      setLocalStage("Measuring hole geometry on this device");
      const geometry = await measureBreadboard(pending);
      setLocalGeometry(geometry);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await pending.arrayBuffer(),
      );
      const sourceHash = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const form = new FormData();
      form.append("image", pending);
      form.append("geometry", JSON.stringify({ sourceHash, geometry }));
      setLocalStage("Identifying components and printed labels");
      const v = parseInspection(
        await json(
          await fetch("/api/circuit-inspections", {
            method: "POST",
            body: form,
          }),
        ),
      );
      accept(v);
      setPending(null);
    } finally {
      setProcedure(null);
      setLocalStage("");
    }
  };
  const edit = (fn: (v: CircuitInput) => void) => {
    if (!draft) return;
    const next = structuredClone(draft);
    fn(next);
    setDraft(next);
    setDirty(true);
    setSaveMessage("");
  };
  const post = async (
    action: "review" | "calibrate" | "diagnose",
    body: unknown,
    inspection = view,
  ) => {
    if (!inspection) throw Error("There is no active circuit inspection.");
    const v = parseInspection(
      await json(
        await fetch(`/api/circuit-inspections/${inspection.id}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
      inspection.id,
    );
    accept(v);
    return v;
  };
  const diagnoseSaved = async (saved: CircuitInspection, goal: string) => {
    setProcedure("troubleshoot");
    setDiagnosing(true);
    setLocalStage(
      verificationSource
        ? "Checking the fresh capture against the intended repair"
        : "Inferring circuit intent and validating one safe lead move",
    );
    try {
      const next = await post(
        "diagnose",
        {
          expectedRevision: saved.revision,
          goal,
          verificationOf: verificationSource?.sourceInspectionId ?? null,
        },
        saved,
      );
      if (next.diagnosis?.status === "no_fault" && verificationSource) {
        localStorage.removeItem("praxis-repair-verification");
        setVerificationSource(null);
      }
      if (next.diagnosis?.status === "repair_ready")
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            faultSection.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            }),
          ),
        );
      return next;
    } finally {
      setDiagnosing(false);
      setLocalStage("");
      setProcedure(null);
    }
  };
  const saveReview = async (input: CircuitInput) => {
    setProcedure("troubleshoot");
    try {
      const next = await post("review", {
          expectedRevision: view!.revision,
          reviewer: "Anonymous operator",
          input,
        }),
        confirmedCount =
          next.input?.associations.filter(
            (association) => association.state === "confirmed_manual",
          ).length ?? 0,
        associationCount = next.input?.associations.length ?? 0,
        unresolvedCount = associationCount - confirmedCount;
      setSaveMessage(
        `Review saved. Observed connections rebuilt below: ${confirmedCount} confirmed, ${unresolvedCount} unresolved.`,
      );
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          graphSection.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          }),
        ),
      );
      await diagnoseSaved(next, intentGoal);
    } finally {
      setProcedure(null);
    }
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
  const reset = (preserveVerification = false) => {
    setLocalGeometry(null);
    setLocalStage("");
    setPhotoDimensions(null);
    stop();
    replacePhoto("");
    setPhoto(null);
    setView(null);
    setDraft(null);
    setPending(null);
    setPicking(null);
    setError("");
    setSaveMessage("");
    setProcedure(null);
    localStorage.removeItem("praxis-automatic-inspection");
    if (!preserveVerification) {
      localStorage.removeItem("praxis-repair-verification");
      setVerificationSource(null);
    }
  };
  const beginVerification = () => {
    const repair = view?.diagnosis?.repair;
    if (!view || !repair || !view.diagnosis) return;
    const source = {
      sourceInspectionId: view.id,
      goal:
        view.diagnosis.requestedGoal || view.diagnosis.intendedBehavior,
      instruction: repair.instruction,
    };
    localStorage.setItem("praxis-repair-verification", JSON.stringify(source));
    setVerificationSource(source);
    reset(true);
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
    ready = !!draft && !running && !cameraOn && !localBusy;
  const adjustedGridProblem = adjustedGridIssue(observations);
  const clearCount =
    view?.hybrid?.endpoints.filter((e) => e.status === "supported").length ?? 0;
  const externalCount =
    view?.hybrid?.endpoints.filter((e) => e.status === "external").length ?? 0;
  const autoSelectedTerminalIds = new Set(
      confirmClearChecked
        ? (view?.hybrid?.endpoints
            .filter((endpoint) => endpoint.status === "supported")
            .map((endpoint) => endpoint.terminalId) ?? [])
        : [],
    ),
    confirmed =
      draft?.associations.filter(
        (association) =>
          association.state === "confirmed_manual" ||
          autoSelectedTerminalIds.has(association.terminalId),
      ).length ?? 0,
    total = draft?.terminals.length ?? 0;
  const reviewCurrent =
    view?.status === "reviewed" && !dirty && !gridDirty;
  const faultRepair =
    view?.diagnosis?.status === "repair_ready"
      ? view.diagnosis.repair
      : null;
  const scanning =
    procedure !== null ||
    (!!photo &&
      (running ||
        localBusy ||
        (busy && !!pending) ||
        diagnosing ||
        (!!localStage && !view?.diagnosis)));
  const troubleshooting =
    procedure === "troubleshoot" || diagnosing;
  const displayImage = view?.image ?? localGeometry?.image ?? photoDimensions;
  const imageFrameStyle = displayImage
    ? {
        aspectRatio: `${displayImage.width} / ${displayImage.height}`,
        width: `min(100%, ${(displayImage.width / displayImage.height) * 68}vh)`,
        maxHeight: "68vh",
      }
    : undefined;
  const flowStep = verificationSource
    ? 4
    : faultRepair
      ? 3
      : view?.status === "reviewed"
        ? 3
        : view
          ? 2
          : pending || cameraOn
            ? 1
            : 0;
  const clearAlreadyConfirmed =
    !!view?.hybrid &&
    !!draft &&
    draft.boards.every((board) => board.topologyState === "confirmed_manual") &&
    draft.components
      .filter((component) => component.state !== "rejected")
      .every((component) => component.state === "confirmed_manual") &&
    view.hybrid.endpoints
      .filter((endpoint) => endpoint.status === "supported")
      .every((endpoint) =>
        draft.associations.some(
          (association) =>
            association.terminalId === endpoint.terminalId &&
            association.state === "confirmed_manual",
        ),
      );
  const targetValue = (a: CircuitInput["associations"][number]) =>
    a.target?.kind === "hole"
      ? `${a.target.boardId}/${a.target.holeId}`
      : a.target?.kind === "terminal"
        ? `terminal/${a.target.terminalId}`
        : "";
  const labelledComponents =
      draft?.components.filter(
        (
          component,
        ): component is typeof component & {
          bbox: [number, number, number, number];
        } => component.state !== "rejected" && component.bbox !== null,
      ) ?? [],
    photoCallouts = view
      ? photoCalloutLayouts(labelledComponents, view.image)
      : null;
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
          <span className="ai-eyebrow">
            CAPTURE · INSPECT · CONFIRM · REPAIR · VERIFY
          </span>
          {/* <h1>Your circuit, mapped from the photo.</h1>
          <p>
            Computer vision measures the grid and connections. AI identifies the
            parts. Confirm clear proposals together, then review the exceptions.
          </p> */}
        </div>
        {view && (
          <button
            className="bench-button bench-button-quiet"
            disabled={busy || running}
            onClick={() => reset()}
          >
            New inspection
          </button>
        )}
      </div>
      <ol className="ai-demo-progress" aria-label="Circuit workflow progress">
        {["Capture", "Map", "Review", "Repair", "Verify"].map(
          (label, index) => (
            <li
              key={label}
              className={
                index < flowStep
                  ? "is-complete"
                  : index === flowStep
                    ? "is-active"
                    : ""
              }
            >
              <i>{index < flowStep ? "✓" : index + 1}</i>
              <span>{label}</span>
            </li>
          ),
        )}
      </ol>
      {verificationSource && !view && (
        <section className="ai-card ai-next-stage" role="status">
          <span className="ai-eyebrow">VERIFY THE PHYSICAL MOVE</span>
          <h2>Capture the circuit again after moving the lead.</h2>
          <p>{verificationSource.instruction}</p>
          <p>
            Keep the board and every terminal visible. Praxis will recalibrate
            the fresh photograph and check the intended connection again.
          </p>
          <button
            className="bench-link-button"
            onClick={() => reset()}
          >
            Cancel verification
          </button>
        </section>
      )}
      {faultRepair && view?.diagnosis && (
        <section
          ref={faultSection}
          className="ai-fault-hero"
          aria-labelledby="ai-fault-title"
          role="alert"
        >
          <div className="ai-fault-beacon" aria-hidden="true">
            <span />
            <BenchIcon name="bolt" size={25} />
          </div>
          <div className="ai-fault-copy">
            <span className="ai-eyebrow">FAULT LOCATED · SAFE MOVE VALIDATED</span>
            <h2 id="ai-fault-title">{faultRepair.instruction}</h2>
            <p>{view.diagnosis.explanation}</p>
          </div>
          <div className="ai-fault-route" aria-label="Validated correction">
            <span>
              Current <strong>{faultRepair.from.holeId.toUpperCase()}</strong>
            </span>
            <i aria-hidden="true">→</i>
            <span>
              Correct <strong>{faultRepair.to.holeId.toUpperCase()}</strong>
            </span>
          </div>
          <button
            className="bench-button bench-button-dark"
            onClick={beginVerification}
          >
            I moved the lead — verify with a new photo
          </button>
        </section>
      )}
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
          <div className="ai-card-heading ai-workspace-heading">
            <div className="ai-workspace-title">
              <BenchIcon name="camera" size={17} />
              <strong>Workspace</strong>
              <i aria-hidden="true">/</i>
              <span>{cameraOn ? "Live camera" : "Still image"}</span>
            </div>
            <span
              className={`ai-status-pill ${scanning ? "is-live" : ""}`}
            >
              {scanning
                ? "Analyzing"
                : faultRepair
                  ? "Fault located"
                  : reviewCurrent
                    ? "Review saved"
                    : pending
                      ? "Ready to analyze"
                      : view
                        ? "Scene mapped"
                      : cameraOn
                        ? "Camera live"
                        : "Ready for capture"}
            </span>
          </div>
          <div
            className={`ai-photo ${picking ? "is-picking" : ""} ${!cameraOn && !photo ? "is-empty" : ""} ${photo ? "has-image" : ""}`}
          >
            <video
              ref={video}
              muted
              playsInline
              style={{ display: cameraOn ? "block" : "none" }}
            />
            {!cameraOn && photo ? (
              <div className="ai-image-wrap" style={imageFrameStyle}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo}
                  alt="Captured breadboard circuit for connection review"
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    setPhotoDimensions({
                      width: image.naturalWidth,
                      height: image.naturalHeight,
                    });
                  }}
                />
                {!draft && localGeometry?.fit && (
                  <svg
                    viewBox={`0 0 ${localGeometry.image.width} ${localGeometry.image.height}`}
                    aria-label="Locally measured hole centres"
                  >
                    {localGeometry.fit.holes.map((p, i) => (
                      <circle
                        key={i}
                        cx={p.x}
                        cy={p.y}
                        r={localGeometry.image.width / 500}
                        stroke="#00b9a9"
                        fill="none"
                        strokeWidth={localGeometry.image.width / 1500}
                      />
                    ))}
                  </svg>
                )}
                {view && draft && (
                  <svg
                    viewBox={`0 0 ${view.image.width} ${view.image.height}`}
                    onClick={pick}
                    aria-label="Proposed grid and terminals"
                    style={{ cursor: picking ? "crosshair" : "default" }}
                  >
                    {view.hybrid?.wireMasks
                      .filter(
                        (m) =>
                          m.componentId &&
                          (selected === m.componentId ||
                            faultRepair?.componentId === m.componentId),
                      )
                      .map((m) => (
                        <g
                          key={`mask-${m.id}`}
                          className={
                            faultRepair?.componentId === m.componentId
                              ? "ai-fault-mask"
                              : undefined
                          }
                          transform={`translate(${m.bbox[0]} ${m.bbox[1]}) scale(${m.bbox[2] / m.mask.width} ${m.bbox[3] / m.mask.height})`}
                        >
                          <path
                            d={m.mask.path}
                            fill={
                              faultRepair?.componentId === m.componentId
                                ? "#ff554d"
                                : "#5fc6aa"
                            }
                            fillOpacity=".2"
                            stroke={
                              faultRepair?.componentId === m.componentId
                                ? "#ff3d36"
                                : "#23a787"
                            }
                            strokeWidth="3"
                            vectorEffect="non-scaling-stroke"
                          />
                        </g>
                      ))}
                    {labelledComponents.map((component) => {
                        const [x, y, width, height] = component.bbox,
                          callout = photoCallouts!.get(component.id)!;
                        return (
                          <g
                            key={`box-${component.id}`}
                            className={`ai-photo-component ${selected === component.id ? "is-selected" : ""}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelected(component.id);
                            }}
                          >
                            <rect
                              x={x}
                              y={y}
                              width={width}
                              height={height}
                              rx={view.image.width / 300}
                            />
                            <line
                              className="ai-photo-component-leader"
                              x1={callout.anchorX}
                              y1={callout.anchorY}
                              x2={callout.x}
                              y2={callout.y}
                            />
                            <circle
                              className="ai-photo-component-marker"
                              cx={callout.x}
                              cy={callout.y}
                              r={callout.radius}
                            />
                            <text
                              className="ai-photo-component-number"
                              x={callout.x}
                              y={callout.y}
                              fontSize={callout.radius * 0.9}
                            >
                              {callout.number}
                            </text>
                            <title>{component.label}</title>
                          </g>
                        );
                      })}
                    {view.hybrid?.endpoints
                      .filter(
                        (e) =>
                          e.position &&
                          !draft.terminals.find((t) => t.id === e.terminalId)
                            ?.position,
                      )
                      .map((e) => (
                        <g
                          key={`cv-${e.terminalId}`}
                          onClick={() => setSelected(e.componentId)}
                        >
                          <circle
                            cx={e.position!.x}
                            cy={e.position!.y}
                            r={view.image.width / 140}
                            fill="none"
                            stroke={
                              e.status === "supported"
                                ? "#dc9729"
                                : e.status === "external"
                                  ? "#4c8fbf"
                                  : "#bd6857"
                            }
                            strokeWidth={view.image.width / 700}
                            strokeDasharray={
                              e.basis === "exposed_lead" ? undefined : "9 5"
                            }
                          />
                          <title>{e.reason}</title>
                        </g>
                      ))}
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
                    {faultRepair && (
                      <RepairGuidanceOverlay
                        repair={faultRepair}
                        imageWidth={view.image.width}
                      />
                    )}
                  </svg>
                )}
                {scanning && (
                  <div className="ai-scan-overlay" aria-live="polite">
                    <div className="ai-scan-line" />
                    <span>
                      <i className="bench-spinner" />
                      {localStage || view?.stage || "Mapping your circuit…"}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              !cameraOn && (
                <div className="ai-camera-empty">
                  <div className="ai-camera-empty-mark">
                    <BenchIcon name="camera" size={37} />
                  </div>
                  <div>
                    <span className="ai-eyebrow">SHOW US THE REAL CIRCUIT</span>
                    <h2>Start with the actual wiring.</h2>
                    <p>
                      Use an overhead photo with readable hole labels. Keep wire
                      ends and component legs visible.
                    </p>
                  </div>
                </div>
              )
            )}
          </div>
          {view && labelledComponents.length > 0 && (
            <div className="ai-component-key" aria-label="Identified components">
              <span className="ai-component-key-title">
                IDENTIFIED COMPONENTS
              </span>
              <div>
                {labelledComponents.map((component, index) => (
                  <button
                    type="button"
                    key={`key-${component.id}`}
                    className={selected === component.id ? "is-selected" : ""}
                    aria-pressed={selected === component.id}
                    onClick={() => setSelected(component.id)}
                  >
                    <i>{index + 1}</i>
                    <span>{component.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
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
                {busy ? "Inspecting…" : "Analyze circuit"}
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
          {localStage && !scanning && (
            <p className="ai-help" role="status">
              {localStage}
            </p>
          )}
          {pending && (
            <p className="ai-help">
              Grid detection runs on this device. The photo goes to Meta for
              component identification and wire segmentation.
            </p>
          )}
          {view && (
            <div className="ai-photo-legend">
              <span>
                <i />
                Unconfirmed proposal
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
          <div className="ai-card-heading ai-scene-heading">
            <div>
              <span className="ai-scene-kicker">SCENE UNDERSTANDING</span>
              <strong>
                {scanning
                  ? troubleshooting
                    ? "Praxis is checking connections"
                    : "Praxis is reading the board"
                  : ready
                    ? "What Praxis sees"
                    : "Awaiting circuit"}
              </strong>
            </div>
            <span>
              {scanning
                ? troubleshooting
                  ? "Review pipeline"
                  : "Live pipeline"
                : ready
                  ? `${confirmed}/${total} ${reviewCurrent ? "connections confirmed" : "proposals selected"}`
                  : "Standby"}
            </span>
          </div>
          {scanning ? (
            <AnalysisProcedureConsole
              script={
                troubleshooting
                  ? troubleshootProcedureScript
                  : analysisProcedureScript
              }
              title={
                troubleshooting
                  ? "PRAXIS / TROUBLESHOOT"
                  : "PRAXIS / LIVE OPERATIONS"
              }
              stage={
                localStage ||
                view?.stage ||
                (troubleshooting
                  ? "Building the observed electrical connection graph"
                  : "Initializing scene analysis")
              }
              requestCount={view?.requestCount ?? 0}
            />
          ) : !ready ? (
            <div className="ai-intro">
              <ol>
                <li>Capture or upload your circuit.</li>
                <li>
                  Local computer vision measures the grid; AI identifies the
                  parts.
                </li>
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
              {view?.hybrid && (
                <section className="ai-review-section ai-quick-review">
                  <h2>Review the exceptions</h2>
                  <div className="ai-clear-parts">
                    {draft.components
                      .filter(
                        (c) =>
                          c.terminalIds.length > 0 &&
                          c.terminalIds.every((id) =>
                            view.hybrid!.endpoints.some(
                              (e) =>
                                e.terminalId === id && e.status === "supported",
                            ),
                          ),
                      )
                      .map((c) => (
                        <button
                          key={c.id}
                          className="bench-link-button"
                          onClick={() => setSelected(c.id)}
                        >
                          {c.label} ·{" "}
                          {view
                            .hybrid!.endpoints.filter(
                              (e) =>
                                e.componentId === c.id &&
                                e.status === "supported",
                            )
                            .map((e) => e.candidates[0]?.holeId.toUpperCase())
                            .filter(Boolean)
                            .join(" ↔ ")}
                        </button>
                      ))}
                  </div>
                  <label className="ai-check">
                    <input
                      type="checkbox"
                      checked={
                        draft.boards.length > 0 &&
                        draft.boards.every(
                          (b) => b.topologyState === "confirmed_manual",
                        ) &&
                        draft.components
                          .filter((c) => c.state !== "rejected")
                          .every((c) => c.state === "confirmed_manual")
                      }
                      onChange={(e) =>
                        edit((input) => {
                          for (const b of input.boards)
                            b.topologyState = e.target.checked
                              ? "confirmed_manual"
                              : "unresolved";
                          for (const c of input.components)
                            if (c.state !== "rejected") {
                              c.state = e.target.checked
                                ? "confirmed_manual"
                                : "unresolved";
                              if (!e.target.checked)
                                c.continuity = "unresolved";
                            }
                          if (!e.target.checked)
                            for (const a of input.associations)
                              a.state = "unresolved";
                        })
                      }
                    />
                    The identified parts and printed grid labels look correct
                  </label>
                  <p>
                    {view.hybrid.geometry.fit?.holes.length ?? 0} measured holes
                    · {clearCount} clear board-contact proposals
                    {externalCount ? ` · ${externalCount} external wire ends` : ""}.
                    Printed labels and physical contact remain subject to your
                    confirmation.
                  </p>
                  <label className="ai-check">
                    <input
                      type="checkbox"
                      checked={showAllParts}
                      onChange={(e) => setShowAllParts(e.target.checked)}
                    />
                    Show every component
                  </label>
                  <p>
                    Select “Confirm clear proposals” below to approve the marked
                    grid, identified parts and clear connections together, then
                    troubleshoot the circuit.
                  </p>
                </section>
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
                      <p
                        className={
                          b.landmarks.length < 6 ? "ai-warning" : "ai-help"
                        }
                      >
                        {b.landmarks.length} labelled hole
                        {b.landmarks.length === 1 ? "" : "s"} placed · minimum 6
                      </p>
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
                    disabled={busy || !gridDirty || !!adjustedGridProblem}
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
                  {gridDirty && adjustedGridProblem && (
                    <p className="ai-warning" role="status">
                      {adjustedGridProblem}
                    </p>
                  )}
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
                {draft.components
                  .filter(
                    (c) =>
                      !view?.hybrid ||
                      showAllParts ||
                      selected === c.id ||
                      !c.terminalIds.length ||
                      c.terminalIds.some(
                        (id) =>
                          !view.hybrid!.endpoints.some(
                            (e) =>
                              e.terminalId === id &&
                              ["supported", "external"].includes(e.status),
                          ),
                      ),
                  )
                  .map((c) => (
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
                                v.components.find((x) => x.id === c.id)!.state =
                                  e.target.checked
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
                                v.components.find((x) => x.id === c.id)!.state =
                                  e.target.checked ? "rejected" : "unresolved";
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
                            )!,
                            autoSelected = autoSelectedTerminalIds.has(tid);
                          return (
                            <div className="ai-terminal" key={tid}>
                              <div className="ai-terminal-title">
                                <strong>{t.label}</strong>
                                <span>
                                  {a.state === "confirmed_manual"
                                    ? "Confirmed"
                                    : autoSelected
                                      ? "Auto-selected · supported"
                                    : t.position
                                      ? "Proposed · check insertion"
                                      : "Unresolved · position hidden"}
                                </span>
                              </div>
                              {view?.hybrid?.endpoints.find(e=>e.terminalId===tid)?.status==='unresolved'&&<p className="ai-help">{view.hybrid.endpoints.find(e=>e.terminalId===tid)!.reason}</p>}
                              {view?.hybrid?.endpoints.find(
                                (e) => e.terminalId === tid,
                              )?.status === "external" && (
                                <p className="ai-help">
                                  External wire end · retained as visible
                                  evidence, not assigned to a breadboard hole.
                                </p>
                              )}
                              {view?.hybrid?.endpoints.find(
                                (e) => e.terminalId === tid,
                              )?.status === "ambiguous" && (
                                <div className="ai-candidate-options">
                                  <p className="ai-help">
                                    {
                                      view.hybrid.endpoints.find(
                                        (e) => e.terminalId === tid,
                                      )!.reason
                                    }
                                  </p>
                                  {view.hybrid.endpoints
                                    .find((e) => e.terminalId === tid)!
                                    .candidates.filter(
                                      (candidate) =>
                                        candidate.distancePitch <= 0.85,
                                    )
                                    .map((candidate) => (
                                      <button
                                        key={`${candidate.boardId}/${candidate.holeId}`}
                                        className="bench-button bench-button-quiet"
                                        disabled={
                                          c.state !== "confirmed_manual" ||
                                          draft.boards.find(
                                            (b) => b.id === candidate.boardId,
                                          )?.topologyState !==
                                            "confirmed_manual"
                                        }
                                        onClick={() =>
                                          edit((input) => {
                                            const board = input.boards.find(
                                                (b) =>
                                                  b.id === candidate.boardId,
                                              )!,
                                              hole = allHoles(
                                                board.calibration as Calibration,
                                                board.rails as Rail[],
                                              ).find(
                                                (h) =>
                                                  h.id === candidate.holeId,
                                              )!;
                                            const association =
                                              input.associations.find(
                                                (x) => x.terminalId === tid,
                                              )!;
                                            association.target = {
                                              kind: "hole",
                                              boardId: board.id,
                                              holeId: hole.id,
                                              calibrationRevision:
                                                board.revision,
                                            };
                                            association.type = "insertion";
                                            association.state =
                                              "confirmed_manual";
                                            input.terminals.find(
                                              (x) => x.id === tid,
                                            )!.position = project(
                                              board.calibration as Calibration,
                                              hole.grid,
                                            );
                                          })
                                        }
                                      >
                                        Confirm {candidate.holeId.toUpperCase()}
                                      </button>
                                    ))}
                                </div>
                              )}
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
                                              calibrationRevision:
                                                v.boards.find(
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
                                  checked={
                                    a.state === "confirmed_manual" ||
                                    autoSelected
                                  }
                                  disabled={
                                    autoSelected ||
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
                                  Role checked against marking or part
                                  information
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
                {view?.hybrid && clearCount > 0 && (
                  <label className="ai-check ai-confirm-clear">
                    <input
                      type="checkbox"
                      checked={clearAlreadyConfirmed || confirmClearChecked}
                      disabled={busy || clearAlreadyConfirmed || gridDirty}
                      onChange={(event) =>
                        setConfirmClearChecked(event.target.checked)
                      }
                    />
                    <span>
                      <strong>Confirm clear proposals</strong>
                      Approve the measured grid, recognized parts and supported
                      terminal contacts together.
                    </span>
                  </label>
                )}
                <button
                  className="bench-button bench-button-dark ai-troubleshoot-button"
                  disabled={
                    busy ||
                    reviewCurrent ||
                    gridDirty ||
                    (confirmClearChecked &&
                      !canConfirmMeasuredGrid(view!, draft!))
                  }
                  onClick={() =>
                    work(() =>
                      saveReview(
                        confirmClearChecked && view!.hybrid
                          ? confirmClearProposals(view!, draft!)
                          : draft!,
                      ),
                    )
                  }
                >
                  {busy
                    ? "Troubleshooting…"
                    : reviewCurrent
                      ? "Troubleshooting complete"
                      : "Troubleshoot circuit"}
                </button>
                <p className="ai-help">
                  Unconfirmed contacts stay unresolved. Troubleshooting saves
                  the review, rebuilds the graph and starts one diagnosis
                  request; it does not establish that the circuit operates.
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
      <section ref={graphSection} className="ai-card ai-graph">
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
        {saveMessage && (
          <div className="ai-success" role="status" tabIndex={-1}>
            <strong>Saved successfully</strong>
            <span>{saveMessage}</span>
          </div>
        )}
        {view?.graph && !dirty && !gridDirty && !cameraOn ? (
          <CircuitGraph
            graph={view.graph}
            selected={selected}
            onSelect={setSelected}
            fault={view.diagnosis?.status === "repair_ready"}
            faultWireId={view.diagnosis?.repair?.componentId ?? null}
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
      {view?.status === "reviewed" && !faultRepair && !troubleshooting && (
        <section className="ai-card ai-diagnosis" aria-label="Diagnosis and repair">
          <div className="ai-card-heading">
            <strong>
              {view.diagnosis?.verificationOf
                ? "4. Verify the repair"
                : "3. Diagnose and repair"}
            </strong>
            <span>{view.stage}</span>
          </div>
          {diagnosing ? (
            <div className="ai-progress" role="status">
              <i className="bench-spinner" />
              <h2>{localStage}</h2>
              <p>
                AI proposes intent using terminal IDs only. The server chooses
                and electrically validates any destination hole.
              </p>
            </div>
          ) : view.diagnosis?.status === "repair_ready" &&
            view.diagnosis.repair ? (
            <div className="ai-repair-result">
              <span className="ai-eyebrow">
                {view.diagnosis.verificationOf
                  ? "REPAIR NOT YET VERIFIED"
                  : "VALIDATED SINGLE-LEAD MOVE"}
              </span>
              <h2>{view.diagnosis.repair.instruction}</h2>
              <p>{view.diagnosis.repair.rationale}</p>
              <div className="ai-repair-holes" aria-label="Repair holes">
                <span>
                  From <strong>{view.diagnosis.repair.from.holeId.toUpperCase()}</strong>
                </span>
                <span aria-hidden="true">→</span>
                <span>
                  To <strong>{view.diagnosis.repair.to.holeId.toUpperCase()}</strong>
                </span>
              </div>
              <p className="ai-warning">{view.diagnosis.repair.safety}</p>
              {view.diagnosis.assumptions.length > 0 && (
                <details>
                  <summary>Assumptions used for this diagnosis</summary>
                  <ul>
                    {view.diagnosis.assumptions.map((assumption) => (
                      <li key={assumption}>{assumption}</li>
                    ))}
                  </ul>
                </details>
              )}
              <button
                className="bench-button bench-button-dark"
                onClick={beginVerification}
              >
                I moved the lead — capture verification
              </button>
            </div>
          ) : view.diagnosis?.status === "no_fault" ? (
            <div className="ai-repair-result is-resolved" role="status">
              <span className="ai-eyebrow">
                {view.diagnosis.verificationOf
                  ? "REPAIR VERIFIED"
                  : "NO MISMATCH FOUND"}
              </span>
              <h2>
                {view.diagnosis.verificationOf
                  ? "The fresh capture matches the intended connection."
                  : "The reviewed wiring matches the inferred intent."}
              </h2>
              <p>{view.diagnosis.explanation}</p>
              <p className="ai-help">
                Photograph agreement does not prove voltage, polarity or that
                the circuit operates. Apply power only after normal electrical
                safety checks.
              </p>
            </div>
          ) : (
            <div className="ai-intent-form">
              <h2>
                {view.diagnosis?.status === "no_safe_repair"
                  ? "No safe single-lead move was validated."
                  : "Tell Praxis what this circuit should do."}
              </h2>
              <p>
                {view.diagnosis?.explanation ??
                  "Praxis will first try to infer the likely intent. Add one short sentence only when several circuits are plausible."}
              </p>
              {view.diagnosis && (
                <div className="ai-intent-summary">
                  <p>
                    <strong>Inferred intent:</strong>{" "}
                    {view.diagnosis.intendedBehavior}
                  </p>
                  {view.diagnosis.relationships.length > 0 && (
                    <ul>
                      {view.diagnosis.relationships.map((relationship) => (
                        <li
                          key={`${relationship.fromTerminalId}:${relationship.toTerminalId}`}
                        >
                          {relationship.satisfied ? "Connected" : "Missing"}: {" "}
                          {relationship.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <label>
                Intended behavior
                <textarea
                  aria-label="Intended circuit behavior"
                  maxLength={500}
                  value={intentGoal}
                  onChange={(event) => setIntentGoal(event.target.value)}
                  placeholder="Example: Power one red LED through the resistor from the 9V battery."
                />
              </label>
              <button
                className="bench-button bench-button-dark"
                disabled={busy || diagnosing}
                onClick={() =>
                  work(() => diagnoseSaved(view, intentGoal))
                }
              >
                {view.diagnosis
                  ? "Diagnose again with this intent"
                  : "Infer intent and diagnose"}
              </button>
            </div>
          )}
        </section>
      )}
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

function AnalysisProcedureConsole({
  script,
  title,
  stage,
  requestCount,
}: {
  script: string;
  title: string;
  stage: string;
  requestCount: number;
}) {
  const [typedLength, setTypedLength] = useState(0);

  useEffect(() => {
    setTypedLength(0);
    const timer = window.setInterval(() => {
      setTypedLength((length) => {
        if (length >= script.length) {
          window.clearInterval(timer);
          return length;
        }
        return length + 1;
      });
    }, 12);
    return () => window.clearInterval(timer);
  }, [script]);

  return (
    <div
      className="ai-procedure-console"
      role="status"
      aria-label={`Praxis scene analysis: ${stage}`}
    >
      <div className="ai-procedure-bar">
        <span aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <code>{title}</code>
        <em>RUNNING</em>
      </div>
      <pre aria-hidden="true">
        <span>{script.slice(0, typedLength)}</span>
        <b>▋</b>
      </pre>
      <div className="ai-procedure-status">
        <span>{stage}</span>
        <span>MODEL REQUESTS {requestCount}</span>
      </div>
    </div>
  );
}

function RepairGuidanceOverlay({
  repair,
  imageWidth,
}: {
  repair: NonNullable<
    NonNullable<CircuitInspection["diagnosis"]>["repair"]
  >;
  imageWidth: number;
}) {
  const radius = Math.max(10, imageWidth / 85),
    bend = Math.max(28, imageWidth / 24),
    midX = (repair.from.position.x + repair.to.position.x) / 2 + bend,
    midY = (repair.from.position.y + repair.to.position.y) / 2 - bend;
  return (
    <g
      className="ai-repair-guidance"
      aria-label={`Move ${repair.from.holeId} to ${repair.to.holeId}`}
    >
      <defs>
        <marker
          id="ai-correction-arrow"
          markerWidth="10"
          markerHeight="10"
          refX="8"
          refY="4"
          orient="auto"
        >
          <path d="M0,0 L0,8 L9,4 z" fill="#55e39c" />
        </marker>
      </defs>
      <circle
        className="ai-fault-ring ai-fault-ring-outer"
        cx={repair.from.position.x}
        cy={repair.from.position.y}
        r={radius * 1.55}
      />
      <circle
        className="ai-fault-ring"
        cx={repair.from.position.x}
        cy={repair.from.position.y}
        r={radius}
      />
      <path
        className="ai-correction-path"
        d={`M ${repair.from.position.x} ${repair.from.position.y} Q ${midX} ${midY} ${repair.to.position.x} ${repair.to.position.y}`}
        markerEnd="url(#ai-correction-arrow)"
      />
      <circle
        className="ai-correction-target"
        cx={repair.to.position.x}
        cy={repair.to.position.y}
        r={radius * 1.15}
      />
      <g
        className="ai-fault-label"
        transform={`translate(${repair.from.position.x + radius * 1.4} ${repair.from.position.y - radius * 2.6})`}
      >
        <rect
          x="0"
          y="0"
          width={imageWidth / 7.6}
          height={imageWidth / 34}
          rx={imageWidth / 180}
        />
        <text
          x={imageWidth / 110}
          y={imageWidth / 51}
          fontSize={imageWidth / 85}
        >
          WRONG · {repair.from.holeId.toUpperCase()}
        </text>
      </g>
      <g
        className="ai-correction-label"
        transform={`translate(${repair.to.position.x + radius * 1.35} ${repair.to.position.y + radius * 1.2})`}
      >
        <rect
          x="0"
          y="0"
          width={imageWidth / 8.4}
          height={imageWidth / 34}
          rx={imageWidth / 180}
        />
        <text
          x={imageWidth / 110}
          y={imageWidth / 51}
          fontSize={imageWidth / 85}
        >
          MOVE TO · {repair.to.holeId.toUpperCase()}
        </text>
      </g>
    </g>
  );
}
