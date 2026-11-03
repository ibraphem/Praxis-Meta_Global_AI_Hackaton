"use client";
import { useEffect, useRef, useState, useId, type ReactNode } from "react";
export function BenchIcon({
  name,
  size = 20,
}: {
  name:
    | "camera"
    | "circuit"
    | "settings"
    | "chevron"
    | "arrow"
    | "check"
    | "close"
    | "scan"
    | "download"
    | "history"
    | "bolt"
    | "eye";
  size?: number;
}) {
  const paths = {
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    camera: (
      <>
        <path d="M4 7h4l2-3h4l2 3h4v13H4z" />
        <circle cx="12" cy="13" r="4" />
      </>
    ),
    circuit: (
      <>
        <path d="M3 6h6v12h12M9 12h7V5" />
        <circle cx="3" cy="6" r="2" />
        <circle cx="16" cy="4" r="2" />
        <circle cx="21" cy="18" r="2" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    arrow: <path d="M3 12h17m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    scan: (
      <>
        <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5M6 12h12" />
      </>
    ),
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    history: (
      <>
        <path d="M3 11a9 9 0 1 1 3 8M3 4v7h7" />
        <path d="M12 7v6l4 2" />
      </>
    ),
    bolt: <path d="m13 2-8 12h6l-1 8 9-13h-7z" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function BenchDialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const before = document.activeElement as HTMLElement | null,
      overflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      if (before?.isConnected) before.focus();
      else
        document
          .querySelector<HTMLButtonElement>(
            '[aria-label="Open workbench settings"]',
          )
          ?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`bench-dialog ${wide ? "bench-dialog-wide" : ""}`}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="bench-dialog-heading">
        <div>
          <span className="bench-eyebrow">PRAXIS / WORKBENCH</span>
          <h2 id={id}>{title}</h2>
        </div>
        <button
          className="bench-icon-button"
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
          <BenchIcon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function BenchViewport({
  aspect,
  children,
}: {
  aspect: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [size, setSize] = useState({ width: 960, height: 600 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  const width = Math.min(size.width, size.height * aspect);
  return (
    <div className="bench-monitor" ref={ref}>
      <div
        className="bench-image-plane"
        style={{ width, height: width / aspect }}
      >
        {children}
      </div>
    </div>
  );
}
export function CircuitBlueprint() {
  return (
    <svg
      className="bench-blueprint"
      viewBox="0 0 400 152"
      role="img"
      aria-label="Expected circuit: a green indicator branch and a button-controlled red indicator branch"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M35 75h25V38h35m45 0h50m35 0h115v74H225m-30 0h-25m-40 0h-25m-30 0H60V75" />
        <path d="M95 30h45v16H95zM130 104h40v16h-40zM75 112h10m10 0 20-12" />
        <path d="M190 28v20l20-10zM215 28v20M195 102v20l20-10zM225 102v20" />
        <path d="m208 23 8-8m-4 0h4v4m-5 79 8-8m-4 0h4v4" />
        <circle cx="60" cy="75" r="3" fill="currentColor" />
        <path d="M340 75h22m-12 0v10m-7 0h14m-11 4h8m-6 4h4" />
      </g>
      <g fill="currentColor" fontSize="11" fontFamily="monospace">
        <text x="8" y="79">
          5V
        </text>
        <text x="107" y="21">
          R1
        </text>
        <text x="190" y="62">
          D1
        </text>
        <text x="80" y="140">
          S1
        </text>
        <text x="141" y="140">
          R2
        </text>
        <text x="174" y="99">
          J1
        </text>
        <text x="208" y="140">
          D2
        </text>
      </g>
    </svg>
  );
}
export function LandmarkPicker({
  url,
  width,
  height,
  points,
  onChange,
}: {
  url: string;
  width: number;
  height: number;
  points: { x: number; y: number }[];
  onChange: (v: { x: number; y: number }[]) => void;
}) {
  return (
    <div className="bench-landmarks">
      <p>
        Click four unique, fixed marks around your circuit. Keep them away from
        the movable wire and at least 29 image pixels from the edges.
      </p>
      <div className="bench-landmark-photo">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt="Circuit setup: select four fixed registration marks"
          onClick={(e) => {
            if (points.length >= 4) return;
            const rect = e.currentTarget.getBoundingClientRect();
            onChange([
              ...points,
              {
                x: Math.round(((e.clientX - rect.left) / rect.width) * width),
                y: Math.round(((e.clientY - rect.top) / rect.height) * height),
              },
            ]);
          }}
        />
        {points.map((p, i) => (
          <span
            key={i}
            style={{
              left: `${(p.x / width) * 100}%`,
              top: `${(p.y / height) * 100}%`,
            }}
          >
            {i + 1}
          </span>
        ))}
      </div>
      <div className="bench-inline">
        <span>{points.length} of 4 marks selected</span>
        <button
          className="bench-link-button"
          disabled={!points.length}
          onClick={() => onChange(points.slice(0, -1))}
        >
          Undo mark
        </button>
      </div>
      <details>
        <summary>Enter precise coordinates</summary>
        <div className="bench-form-grid">
          {Array.from({ length: 4 }, (_, i) => (
            <fieldset key={i}>
              <legend>Mark {i + 1}</legend>
              {(["x", "y"] as const).map((axis) => (
                <label key={axis}>
                  {axis.toUpperCase()}
                  <input
                    aria-label={`Mark ${i + 1} ${axis}`}
                    type="number"
                    min={0}
                    max={axis === "x" ? width - 1 : height - 1}
                    value={points[i]?.[axis] ?? ""}
                    onChange={(e) => {
                      const copy = [...points];
                      copy[i] = {
                        x: copy[i]?.x ?? 0,
                        y: copy[i]?.y ?? 0,
                        [axis]: Number(e.target.value),
                      };
                      onChange(copy);
                    }}
                  />
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </details>
    </div>
  );
}
