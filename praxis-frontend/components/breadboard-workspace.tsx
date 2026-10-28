"use client";
/* Blob photographs must be rendered directly, without an image optimizer. */
/* eslint-disable @next/next/no-img-element */

import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
} from "react";
import {
  allHoles,
  boardOrientation,
  calibrateBoard,
  clientPointToImage,
  pickHole,
  registerRail,
  selectHole,
  type HoleSelection,
  type ImageSize,
  type Point,
  type Rail,
  type Rows,
} from "@/lib/breadboard/calibration";
import { BreadboardOverlay } from "./breadboard-overlay";
import { CalibrationGuide } from "./calibration-guide";
import { CalibrationLoupe } from "./calibration-loupe";
import {
  WireAssignmentPanel,
  type EndpointCapture,
} from "./wire-assignment-panel";
import { WireEndpointOverlay } from "./wire-endpoint-overlay";
import {
  assignEndpoint,
  assignmentValidity,
  createAssignment,
  MAX_ASSIGNMENTS,
  replaceBoard,
  reviseRails,
  sameImage,
  wireCandidate,
  type AssignmentContext,
  type CalibratedBoard as Board,
  type WireAssignment,
} from "@/lib/wires/assignments";
import {
  placeReference,
  referenceInstruction,
  referenceNames,
  referenceTarget,
} from "@/lib/breadboard/references";

interface Draft {
  id: string;
  rows: Rows;
  anchors: Point[];
}
type RailSettings = Omit<Rail, "first" | "last">;
const initialRail: RailSettings = {
  id: "R1",
  label: "unmarked",
  count: 25,
  layout: "groups-of-five",
  connectivity: "unknown",
  splitAfter: null,
};
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Calibration could not be completed.";

/** All calibration stays in memory for this photograph. No extra image/API transmission. */
export function BreadboardWorkspace({
  image,
  imageUrl,
  disabled,
  children,
  assignmentContext,
  selectedWireId = null,
  onSelectWire,
  overlaysVisible = true,
}: {
  image: ImageSize;
  imageUrl: string;
  disabled: boolean;
  children?: ReactNode;
  assignmentContext?: AssignmentContext;
  selectedWireId?: string | null;
  onSelectWire?: (id: string) => void;
  overlaysVisible?: boolean;
}) {
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const nextBoard = useRef(1);
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rows, setRows] = useState<Rows>(30);
  const [railPoints, setRailPoints] = useState<Point[] | null>(null);
  const [railSettings, setRailSettings] = useState<RailSettings>(initialRail);
  const [selected, setSelected] = useState<HoleSelection | null>(null);
  const [notice, setNotice] = useState("");
  const [lookup, setLookup] = useState("");
  const [pixelX, setPixelX] = useState("");
  const [pixelY, setPixelY] = useState("");
  const [zoom, setZoom] = useState(1);
  const [assignments, setAssignments] = useState<WireAssignment[]>([]);
  const [capture, setCapture] = useState<EndpointCapture | null>(null);
  const nextAssignment = useRef(1);
  const [editingReference, setEditingReference] = useState<number | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const photoRef = useRef<HTMLImageElement>(null);
  const pointerRef = useRef<Point | null>(null);
  const pointerFrame = useRef<number | null>(null);
  const clearPointer = useCallback(() => {
    if (pointerFrame.current !== null)
      cancelAnimationFrame(pointerFrame.current);
    pointerFrame.current = null;
    pointerRef.current = null;
    setPointer(null);
  }, []);
  useEffect(() => {
    // A stationary cursor refers to a different pixel after scrolling/resizing.
    window.addEventListener("scroll", clearPointer, true);
    window.addEventListener("resize", clearPointer);
    return () => {
      window.removeEventListener("scroll", clearPointer, true);
      window.removeEventListener("resize", clearPointer);
      if (pointerFrame.current !== null)
        cancelAnimationFrame(pointerFrame.current);
    };
  }, [clearPointer]);
  const board =
    boards.find((board) => board.calibration.breadboardId === activeId) ?? null;
  const pausedReason =
    draft || railPoints
      ? "Finish or cancel calibration before assigning endpoints."
      : !overlaysVisible
        ? "Show component overlays before picking wire endpoints."
        : !assignmentContext?.analysis || !assignmentContext.analysisRunId
          ? "Analyze this photograph to select a current wire candidate."
          : !sameImage(assignmentContext.analysis.image, image)
            ? "Image dimensions differ from the analysis. Endpoint picking is disabled."
            : "";
  const capturedRecord = assignments.find(
    (record) => record.id === capture?.assignmentId,
  );
  const picking = !!(
    capture &&
    capturedRecord &&
    assignmentContext &&
    !disabled &&
    !pausedReason &&
    board &&
    selectedWireId === capturedRecord.wireCandidateId &&
    assignmentValidity(capturedRecord, assignmentContext, boards).status !==
      "stale"
  );
  const visibleAssignment =
    assignmentContext && overlaysVisible
      ? [...assignments]
          .reverse()
          .find(
            (record) =>
              record.wireCandidateId === selectedWireId &&
              assignmentValidity(record, assignmentContext, boards).status !==
                "stale",
          )
      : undefined;
  const preview = useMemo(() => {
    if (!draft || draft.anchors.length !== 4)
      return { calibration: null, error: "" };
    try {
      return {
        calibration: calibrateBoard(draft.id, draft.rows, image, draft.anchors),
        error: "",
      };
    } catch (error) {
      return { calibration: null, error: message(error) };
    }
  }, [draft, image]);
  const railPreview = useMemo(() => {
    if (!board || !railPoints || railPoints.length !== 2)
      return { rail: null, error: "" };
    try {
      return {
        rail: registerRail(
          board.calibration,
          railSettings,
          railPoints[0],
          railPoints[1],
        ),
        error: "",
      };
    } catch (error) {
      return { rail: null, error: message(error) };
    }
  }, [board, railPoints, railSettings]);
  const calibration = draft
    ? preview.calibration
    : (board?.calibration ?? null);
  const rails = draft
    ? []
    : [
        ...(board?.rails ?? []),
        ...(railPreview.rail ? [railPreview.rail] : []),
      ];
  const anchors = draft?.anchors ?? railPoints ?? [];
  const target = draft
    ? referenceTarget(draft.anchors, editingReference)
    : null;
  const anchorLabels = draft
    ? referenceNames(draft.rows)
    : ["Rail first", "Rail last"];
  const nextAnchor = target === null ? null : anchorLabels[target];
  const instruction = draft
    ? referenceInstruction(
        draft.rows,
        draft.anchors,
        editingReference,
        !!preview.calibration,
        preview.error,
      )
    : railPoints
      ? railPoints.length === 0
        ? "Click the first hole center of ONE power-rail lane."
        : railPoints.length === 1
          ? "Click the last hole center of the SAME rail lane."
          : railPreview.error
            ? "Correct the rail reference points or spacing. No valid rail overlay is available."
            : "Check every projected rail hole before saving."
      : board
        ? "Click a visible hole near its center. Its electrical group will be highlighted."
        : "Calibrate a board to start mapping holes.";
  const photoInstruction = picking
    ? `Pick endpoint ${capture!.index + 1} of ${capturedRecord!.wireCandidateId} on ${activeId}. Manual location only; contact remains unknown.`
    : instruction;

  function startBoard(replace = false) {
    setCapture(null);
    setEditingReference(null);
    clearPointer();
    const id =
      replace && board
        ? board.calibration.breadboardId
        : `board_${nextBoard.current++}`;
    setDraft({
      id,
      rows: replace && board ? board.calibration.rows : rows,
      anchors: [],
    });
    setActiveId(id);
    setRailPoints(null);
    setSelected(null);
    setNotice("");
    setEnabled(true);
  }
  function changeBoard(id: string) {
    setEditingReference(null);
    clearPointer();
    setActiveId(id);
    setDraft(null);
    setRailPoints(null);
    setSelected(null);
    setNotice("");
  }
  function acceptPoint(
    point: Point,
    source: "image_click" | "pixel_entry" = "image_click",
  ) {
    if (disabled) return;
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= image.width ||
      point.y >= image.height
    ) {
      setNotice("Enter a point inside the image.");
      return;
    }
    setNotice("");
    if (picking && capturedRecord && capture && assignmentContext && board) {
      try {
        const updated = assignEndpoint(
          capturedRecord,
          capture.index,
          point,
          source,
          board,
          assignmentContext,
          boards,
        );
        setAssignments((current) =>
          current.map((record) =>
            record.id === updated.id ? updated : record,
          ),
        );
        const resolved =
          updated.endpoints[capture.index]?.resolution.status === "resolved";
        if (resolved)
          setCapture(
            capture.index === 0 ? { assignmentId: updated.id, index: 1 } : null,
          );
        else
          setNotice(
            "Endpoint recorded as manually selected, but its hole is unknown. Pick a clearer position or choose the other endpoint in the record.",
          );
      } catch (error) {
        setNotice(message(error));
      }
      return;
    }
    if (draft) {
      if (target !== null)
        setDraft({
          ...draft,
          anchors: placeReference(draft.anchors, editingReference, point),
        });
      else setNotice("Choose the named reference you want to replace.");
      setEditingReference(null);
      return;
    }
    if (railPoints) {
      if (railPoints.length < 2) setRailPoints([...railPoints, point]);
      return;
    }
    if (board) {
      const found = pickHole(board.calibration, board.rails, point, source);
      setSelected(found);
      if (!found)
        setNotice(
          "No unambiguous hole near that point. Check alignment or zoom in.",
        );
    }
  }
  function confirmGrid() {
    if (!preview.calibration || editingReference !== null) return;
    const calibration = preview.calibration;
    setBoards((current) => [
      ...current.filter((item) => item.calibration.breadboardId !== draft!.id),
      replaceBoard(
        current.find((item) => item.calibration.breadboardId === draft!.id),
        calibration,
      ),
    ]);
    setDraft(null);
    setEditingReference(null);
    clearPointer();
    setSelected(null);
    setNotice(
      "Grid confirmed by you. Rail registration must be added separately.",
    );
  }
  function startRail() {
    setCapture(null);
    clearPointer();
    const id = ["R1", "R2", "R3", "R4"].find(
      (id) => !board?.rails.some((rail) => rail.id === id),
    );
    if (!id) return;
    setRailSettings({
      ...initialRail,
      id,
      count: board?.calibration.rows === 63 ? 50 : 25,
    });
    setRailPoints([]);
    setSelected(null);
    setNotice("");
  }
  function confirmRail() {
    if (!railPreview.rail || !board) return;
    setBoards((current) =>
      current.map((item) =>
        item === board
          ? reviseRails(item, [...item.rails, railPreview.rail!])
          : item,
      ),
    );
    setRailPoints(null);
    setNotice(
      "Rail geometry confirmed. Continuity uses only your explicit declaration.",
    );
  }
  function lookupHole() {
    if (!board || draft || railPoints) return;
    const hole = allHoles(board.calibration, board.rails).find(
      (hole) => hole.id.toLowerCase() === lookup.trim().toLowerCase(),
    );
    setSelected(
      hole
        ? selectHole(board.calibration, board.rails, hole, "coordinate_lookup")
        : null,
    );
    setNotice(
      hole
        ? "Coordinate lookup shows a template location; it does not establish visibility."
        : "No such hole on this calibrated board.",
    );
  }
  function selectReference(index: number) {
    if (!draft || index >= draft.anchors.length) return;
    setEditingReference(index);
    setNotice("");
    clearPointer();
    setPixelX(String(draft.anchors[index].x));
    setPixelY(String(draft.anchors[index].y));
  }
  function imagePoint(client: Point) {
    const rect = photoRef.current?.getBoundingClientRect();
    return rect ? clientPointToImage(client, rect, image) : null;
  }
  function movePointer(event: PointerEvent<HTMLButtonElement>) {
    if (!draft && !railPoints) return;
    pointerRef.current = imagePoint({ x: event.clientX, y: event.clientY });
    if (pointerFrame.current === null)
      pointerFrame.current = requestAnimationFrame(() => {
        setPointer(pointerRef.current);
        pointerFrame.current = null;
      });
  }
  function pickEndpoint(id: string, index: 0 | 1) {
    const record = assignments.find((record) => record.id === id);
    if (
      !record ||
      !assignmentContext ||
      disabled ||
      pausedReason ||
      !boards.length ||
      assignmentValidity(record, assignmentContext, boards).status === "stale"
    )
      return;
    setCapture({ assignmentId: id, index });
    setEnabled(false);
    setSelected(null);
    setNotice("");
    setActiveId(
      board?.calibration.breadboardId ?? boards[0].calibration.breadboardId,
    );
    onSelectWire?.(record.wireCandidateId);
    clearPointer();
  }
  function beginAssignment() {
    if (
      !assignmentContext ||
      !selectedWireId ||
      disabled ||
      pausedReason ||
      !boards.length ||
      !wireCandidate(assignmentContext, selectedWireId)
    )
      return;
    const existing = assignments.find(
      (record) =>
        record.wireCandidateId === selectedWireId &&
        assignmentValidity(record, assignmentContext, boards).status !==
          "stale",
    );
    if (existing) {
      pickEndpoint(
        existing.id,
        existing.endpoints[0]?.resolution.status === "resolved" ? 1 : 0,
      );
      return;
    }
    if (assignments.length >= MAX_ASSIGNMENTS) {
      setNotice("Remove an old assignment before creating another.");
      return;
    }
    const record = createAssignment(
      `connection_${nextAssignment.current++}`,
      assignmentContext,
      selectedWireId,
    );
    setAssignments((current) => [...current, record]);
    setCapture({ assignmentId: record.id, index: 0 });
    setEnabled(false);
    setSelected(null);
    setNotice("");
    setActiveId(
      board?.calibration.breadboardId ?? boards[0].calibration.breadboardId,
    );
    clearPointer();
  }

  return (
    <>
      <div className="breadboard-toolbar">
        <div>
          <strong>Breadboard coordinates</strong>
          <span>Manual calibration · standard 10-column grid</span>
        </div>
        <div className="spatial-buttons">
          {boards.length > 0 && (
            <button
              type="button"
              className="button button-secondary"
              disabled={disabled || !!draft || !!railPoints}
              aria-pressed={enabled}
              onClick={() => {
                setCapture(null);
                setEnabled(!enabled);
              }}
            >
              {enabled ? "Inspect components" : "Inspect holes"}
            </button>
          )}
          {!draft && !railPoints && (
            <button
              type="button"
              className="button button-secondary"
              disabled={disabled || boards.length >= 4}
              onClick={() => startBoard()}
            >
              Calibrate {boards.length ? "another board" : "a board"}
            </button>
          )}
          <label className="zoom-control">
            Photo zoom{" "}
            <select
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            >
              <option value={1}>100%</option>
              <option value={2}>200%</option>
              <option value={3}>300%</option>
            </select>
          </label>
        </div>
      </div>
      {enabled && !disabled && (draft || railPoints) && (
        <div className="calibration-assist">
          {draft && <CalibrationGuide rows={draft.rows} active={target} />}
          <div className="calibration-step">
            <strong>
              {nextAnchor
                ? `Target: ${nextAnchor}`
                : preview.error
                  ? "References need correction"
                  : "Review alignment"}
            </strong>
            <p role="status" aria-live="polite">
              {instruction}
            </p>
          </div>
          <CalibrationLoupe
            imageUrl={imageUrl}
            image={image}
            point={
              pointer ??
              (editingReference !== null
                ? anchors[editingReference]
                : anchors.at(-1)) ??
              null
            }
            label={
              pointer
                ? nextAnchor
                  ? `Place ${nextAnchor} here`
                  : "Pointer detail"
                : editingReference !== null
                  ? `${anchorLabels[editingReference]} reference`
                  : "Last reference"
            }
          />
        </div>
      )}
      <div className="spatial-viewport" onScroll={clearPointer}>
        <div
          className="photo-frame"
          style={{
            aspectRatio: `${image.width} / ${image.height}`,
            width: `${zoom * 100}%`,
            maxWidth:
              zoom === 1
                ? `min(100%, ${(560 * image.width) / image.height}px)`
                : "none",
          }}
        >
          <img
            ref={photoRef}
            src={imageUrl}
            alt="Your uploaded electronics workspace"
            width={image.width}
            height={image.height}
            className="workspace-photo"
            draggable="false"
          />
          {children}
          {(enabled || picking) && !disabled && (
            <>
              <BreadboardOverlay
                calibration={calibration}
                rails={rails}
                selected={selected}
                anchors={anchors}
                anchorLabels={anchorLabels}
                activeAnchor={editingReference}
                image={image}
              />
              <button
                type="button"
                className="hole-hit-surface"
                aria-label={
                  photoInstruction +
                  " Keyboard users can enter pixel coordinates or a hole coordinate below."
                }
                onClick={(event) => {
                  if (event.detail === 0) {
                    setNotice(
                      "Use the coordinate entry below for keyboard selection.",
                    );
                    return;
                  }
                  const point = imagePoint({
                    x: event.clientX,
                    y: event.clientY,
                  });
                  if (point) acceptPoint(point);
                }}
                onPointerMove={movePointer}
                onPointerLeave={clearPointer}
              />
            </>
          )}
          {visibleAssignment && !disabled && (
            <WireEndpointOverlay
              assignment={visibleAssignment}
              image={image}
              validity={assignmentValidity(
                visibleAssignment,
                assignmentContext!,
                boards,
              )}
            />
          )}
        </div>
      </div>
      {assignmentContext &&
        (assignmentContext.analysis || assignments.length > 0) && (
          <>
            <WireAssignmentPanel
              context={assignmentContext}
              selectedWireId={selectedWireId}
              boards={boards}
              records={assignments}
              capture={capture}
              activeBoardId={activeId}
              picking={picking}
              disabled={disabled}
              pausedReason={pausedReason}
              onStart={beginAssignment}
              onPick={pickEndpoint}
              onStop={() => setCapture(null)}
              onBoard={changeBoard}
              onPoint={acceptPoint}
              onRemove={(id) => {
                setAssignments((current) =>
                  current.filter((record) => record.id !== id),
                );
                if (capture?.assignmentId === id) setCapture(null);
              }}
            />
            {notice && !enabled && (
              <p className="calibration-notice" role="status">
                {notice}
              </p>
            )}
          </>
        )}
      {enabled && (
        <section
          className="calibration-panel"
          aria-label="Breadboard calibration"
        >
          <fieldset disabled={disabled}>
            <legend>Map the hole grid</legend>
            <p
              role={!draft && !railPoints ? "status" : undefined}
              aria-live={!draft && !railPoints ? "polite" : undefined}
            >
              {instruction}
            </p>
            <p className="calibration-hint">
              Use hole centers, not plastic corners. Follow printed a–j letters
              and row numbers. If unmarked, your chosen a1 → j1 → jN → aN order
              defines orientation. Keep all four reference holes visible. Zoom
              and scroll for precision.
            </p>
            {boards.length > 0 && !draft && !railPoints && (
              <div className="calibration-controls">
                <label>
                  Board{" "}
                  <select
                    value={activeId ?? ""}
                    onChange={(event) => changeBoard(event.target.value)}
                  >
                    {boards.map((item) => (
                      <option
                        key={item.calibration.breadboardId}
                        value={item.calibration.breadboardId}
                      >
                        {item.calibration.breadboardId} ·{" "}
                        {item.calibration.rows} rows
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => startBoard(true)}
                >
                  Recalibrate grid
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setBoards(boards.filter((item) => item !== board));
                    changeBoard(
                      boards.find((item) => item !== board)?.calibration
                        .breadboardId ?? "",
                    );
                  }}
                >
                  Remove board
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!board || board.rails.length >= 4}
                  onClick={startRail}
                >
                  Register rail lane
                </button>
              </div>
            )}
            {draft && (
              <div className="calibration-controls">
                <label>
                  Terminal rows{" "}
                  <select
                    value={draft.rows}
                    onChange={(event) => {
                      const value = Number(event.target.value) as Rows;
                      setRows(value);
                      setDraft({ ...draft, rows: value, anchors: [] });
                      setEditingReference(null);
                      clearPointer();
                      setNotice("");
                    }}
                  >
                    <option value={30}>30 rows</option>
                    <option value={63}>63 rows</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!draft.anchors.length}
                  onClick={() => {
                    setDraft({ ...draft, anchors: draft.anchors.slice(0, -1) });
                    setEditingReference(null);
                    clearPointer();
                    setNotice("");
                  }}
                >
                  Undo point
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={!preview.calibration || editingReference !== null}
                  onClick={confirmGrid}
                >
                  Grid aligns — confirm
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setDraft(null);
                    setEditingReference(null);
                    clearPointer();
                    setActiveId(boards[0]?.calibration.breadboardId ?? null);
                    setEnabled(boards.length > 0);
                  }}
                >
                  Cancel calibration
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!draft.anchors.length}
                  onClick={() => {
                    setDraft({ ...draft, anchors: [] });
                    setEditingReference(null);
                    clearPointer();
                    setNotice("");
                    setPixelX("");
                    setPixelY("");
                  }}
                >
                  Reset all points
                </button>
                {editingReference !== null && (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      setEditingReference(null);
                      clearPointer();
                      setNotice("");
                    }}
                  >
                    Cancel replacement
                  </button>
                )}
              </div>
            )}
            {!!draft && (
              <ol className="anchor-order">
                {["a1", "j1", `j${draft.rows}`, `a${draft.rows}`].map(
                  (id, index) => (
                    <li
                      key={id}
                      aria-current={target === index ? "step" : undefined}
                    >
                      <button
                        type="button"
                        disabled={!draft.anchors[index]}
                        aria-pressed={editingReference === index}
                        aria-label={`Replace ${id} reference`}
                        onClick={() => selectReference(index)}
                      >
                        {id}
                        {draft.anchors[index]
                          ? ` (${draft.anchors[index].x.toFixed(1)}, ${draft.anchors[index].y.toFixed(1)})`
                          : " — not set"}
                      </button>
                    </li>
                  ),
                )}
              </ol>
            )}
            {railPoints && (
              <>
                <div className="calibration-controls">
                  <label>
                    Lane label{" "}
                    <select
                      value={railSettings.label}
                      onChange={(event) =>
                        setRailSettings({
                          ...railSettings,
                          label: event.target.value as Rail["label"],
                        })
                      }
                    >
                      <option value="unmarked">Unmarked</option>
                      <option value="positive">+ marking</option>
                      <option value="negative">− marking</option>
                    </select>
                  </label>
                  <label>
                    Hole count{" "}
                    <select
                      value={railSettings.count}
                      onChange={(event) =>
                        setRailSettings({
                          ...railSettings,
                          count: Number(event.target.value) as Rail["count"],
                          splitAfter: null,
                          connectivity: "unknown",
                        })
                      }
                    >
                      <option value={25}>25</option>
                      <option value={50}>50</option>
                    </select>
                  </label>
                  <label>
                    Spacing{" "}
                    <select
                      value={railSettings.layout}
                      onChange={(event) =>
                        setRailSettings({
                          ...railSettings,
                          layout: event.target.value as Rail["layout"],
                        })
                      }
                    >
                      <option value="groups-of-five">
                        Five holes, one pitch gap
                      </option>
                      <option value="uniform">Uniform hole pitch</option>
                    </select>
                  </label>
                  <label>
                    Continuity from board documentation{" "}
                    <select
                      value={railSettings.connectivity}
                      onChange={(event) =>
                        setRailSettings({
                          ...railSettings,
                          connectivity: event.target
                            .value as Rail["connectivity"],
                          splitAfter:
                            event.target.value === "split"
                              ? Math.floor(railSettings.count / 2)
                              : null,
                        })
                      }
                    >
                      <option value="unknown">Unknown</option>
                      <option value="continuous">Declared continuous</option>
                      <option value="split">Declared split</option>
                    </select>
                  </label>
                  {railSettings.connectivity === "split" && (
                    <label>
                      Split after hole{" "}
                      <input
                        type="number"
                        min={1}
                        max={railSettings.count - 1}
                        value={railSettings.splitAfter ?? ""}
                        onChange={(event) =>
                          setRailSettings({
                            ...railSettings,
                            splitAfter: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                  )}
                </div>
                <p className="calibration-hint">
                  {railSettings.id} numbers from the first point to the last. A
                  +/− marking does not establish voltage or continuity.
                  Unsupported rail patterns must remain unregistered.
                </p>
                <div className="spatial-buttons">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={!railPoints.length}
                    onClick={() => setRailPoints(railPoints.slice(0, -1))}
                  >
                    Undo rail point
                  </button>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={!railPreview.rail}
                    onClick={confirmRail}
                  >
                    Rail aligns — save
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setRailPoints(null)}
                  >
                    Cancel rail
                  </button>
                </div>
              </>
            )}
            {(draft || railPoints || board) && (
              <form
                className="pixel-entry"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!pixelX.trim() || !pixelY.trim()) {
                    setNotice("Enter both image pixel coordinates.");
                    return;
                  }
                  acceptPoint(
                    { x: Number(pixelX), y: Number(pixelY) },
                    "pixel_entry",
                  );
                }}
              >
                <span>Or enter original-image pixels:</span>
                <label>
                  X{" "}
                  <input
                    type="number"
                    min={0}
                    max={image.width - 1}
                    step="any"
                    value={pixelX}
                    onChange={(event) => setPixelX(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Y{" "}
                  <input
                    type="number"
                    min={0}
                    max={image.height - 1}
                    step="any"
                    value={pixelY}
                    onChange={(event) => setPixelY(event.target.value)}
                    required
                  />
                </label>
                <button
                  className="button button-secondary"
                  disabled={
                    draft ? target === null : (railPoints?.length ?? 0) >= 2
                  }
                >
                  {draft
                    ? `${editingReference !== null ? "Replace" : "Set"} ${nextAnchor ?? "reference"}`
                    : railPoints
                      ? "Add rail reference"
                      : "Inspect image position"}
                </button>
              </form>
            )}
            {board && !draft && !railPoints && (
              <>
                <form
                  className="hole-lookup"
                  onSubmit={(event) => {
                    event.preventDefault();
                    lookupHole();
                  }}
                >
                  <label>
                    Hole coordinate{" "}
                    <input
                      value={lookup}
                      maxLength={12}
                      placeholder="a12 or R1:5"
                      onChange={(event) => setLookup(event.target.value)}
                      required
                    />
                  </label>
                  <button className="button button-secondary">
                    Show coordinate
                  </button>
                </form>
                <ul className="registered-rails">
                  {board.rails.map((rail) => (
                    <li key={rail.id}>
                      {rail.id}: {rail.count} holes · {rail.label} ·{" "}
                      {rail.connectivity === "unknown"
                        ? "continuity unknown"
                        : `user-declared ${rail.connectivity}`}
                      {rail.connectivity === "split"
                        ? ` after ${rail.splitAfter}`
                        : ""}
                      <button
                        type="button"
                        onClick={() => {
                          setBoards(
                            boards.map((item) =>
                              item === board
                                ? reviseRails(
                                    item,
                                    item.rails.filter(
                                      (other) => other.id !== rail.id,
                                    ),
                                  )
                                : item,
                            ),
                          );
                          setSelected(null);
                        }}
                      >
                        Remove {rail.id}
                      </button>
                    </li>
                  ))}
                </ul>
                {selected && (
                  <div className="hole-result" aria-live="polite">
                    <strong>{selected.hole}</strong>
                    <p>
                      Electrical group: {selected.electricalGroup ?? "unknown"}{" "}
                      · {selected.groupBasis.replaceAll("_", " ")}
                    </p>
                    <p>
                      {selected.groupMembers.length
                        ? `Same group: ${selected.groupMembers.join(", ")}`
                        : "No rail continuity assumed."}
                    </p>
                    <details>
                      <summary>Inspect hole JSON</summary>
                      <pre>{JSON.stringify(selected, null, 2)}</pre>
                    </details>
                  </div>
                )}
                <details className="calibration-data">
                  <summary>Inspect calibration JSON</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        calibration: board.calibration,
                        revision: board.revision,
                        orientation: boardOrientation(board.calibration),
                        rails: board.rails,
                        confirmation: "user_confirmed",
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </>
            )}
            {(notice || preview.error || railPreview.error) && (
              <p className="calibration-notice" role="status">
                {preview.error || railPreview.error || notice}
              </p>
            )}
            <p className="calibration-hint">
              Blue outlines mark terminal strips; amber marks the center gap;
              brown dots mark registered rails. Terminal groups follow the
              selected template: a–e and f–j connect within each numbered row;
              the center gap separates them. Confirm the overlay against your
              board. Geometry is user calibrated; hole visibility, contact, and
              actual continuity are not verified. Recalibrating clears
              registered rails. Nothing is saved after this photograph is
              replaced or the page is reloaded.
            </p>
          </fieldset>
        </section>
      )}
    </>
  );
}
