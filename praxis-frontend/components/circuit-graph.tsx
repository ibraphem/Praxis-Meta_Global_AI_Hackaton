"use client";
import { useId } from "react";
import type { CircuitSessionView } from "@/lib/circuit-session";
import { BenchIcon } from "./bench-ui";
/** Shows observed strip/contact groups before wire union. Device ports remain separate. */
export function CircuitGraph({
  graph,
  selected,
  onSelect,
  fault,
  faultWireId,
}: {
  graph: NonNullable<CircuitSessionView["graph"]>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  fault: boolean;
  faultWireId: string | null;
}) {
  const grid = useId(),
    positions = new Map(
      graph.nodes.map((n, i) => [
        n.id,
        { x: 82 + (i % 4) * 205, y: 45 + Math.floor(i / 4) * 110 },
      ]),
    ),
    height = Math.max(140, Math.ceil(graph.nodes.length / 4) * 110 + 15);
  const label = (node: (typeof graph.nodes)[number], i: number) => {
    const holes = node.members
      .map((m) => m.match(/:([a-j]\d+)$/)?.[1])
      .filter((h): h is string => !!h);
    return holes.length
      ? `${holes[0]?.toUpperCase()}${holes.length > 1 ? `–${holes.at(-1)?.toUpperCase()}` : ""}`
      : node.members.some((m) => /:R[1-4]:\d+$/.test(m))
        ? "POWER RAIL"
        : `CONTACT ${i + 1}`;
  };
  return (
    <section className="bench-graph" aria-label="Circuit graph">
      <div className="bench-graph-caption">
        <span>
          <i />
          REVIEWED WIRING
        </span>
        <p>Hover a wire to highlight its connection in the capture.</p>
        <div>
          <span className="bench-legend">
            <i />
            Connected
          </span>
          <span className="bench-legend is-unknown">
            <i />
            Unconfirmed
          </span>
          {fault && (
            <span className="bench-legend is-fault">
              <i />
              Missing connection
            </span>
          )}
        </div>
      </div>
      <svg
        viewBox={`0 0 800 ${height}`}
        role="img"
        aria-label="Observed circuit connection graph"
      >
        <defs>
          <pattern
            id={grid}
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r=".6" fill="#dde7d5" />
          </pattern>
        </defs>
        <rect width="800" height={height} fill={`url(#${grid})`} />
        {graph.wires.map((w) => {
          const a = positions.get(w.from),
            b = positions.get(w.to);
          if (!a || !b) return null;
          const active = selected === w.objectRef.id || selected === w.id,
            isFault = fault && w.id === faultWireId,
            color = active
              ? "#3b8c8b"
              : isFault
                ? "#b9684d"
                : w.confirmed
                  ? "#789b6a"
                  : "#b6a36b",
            id = w.objectRef.kind === "baseline" ? w.objectRef.id : w.id;
          const midX = (a.x + b.x) / 2,
            midY = a.y === b.y ? a.y - 24 : (a.y + b.y) / 2;
          const d =
            a === b
              ? `M ${a.x} ${a.y} c 38 -60 60 60 0 0`
              : `M ${a.x} ${a.y} V ${midY} H ${b.x} V ${b.y}`;
          return (
            <g
              key={w.id}
              role="button"
              tabIndex={0}
              pointerEvents="bounding-box"
              style={{ cursor: "pointer" }}
              aria-label={`Inspect graph wire ${w.label}`}
              onMouseEnter={() => onSelect(id)}
              onMouseLeave={() => onSelect(null)}
              onFocus={() => onSelect(id)}
              onBlur={() => onSelect(null)}
              onClick={() => onSelect(id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(id);
                }
              }}
            >
              <title>
                {w.label}:{" "}
                {w.confirmed ? "reviewed conductor" : "unconfirmed conductor"}
              </title>
              <path
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={active ? 5 : 2.2}
                strokeDasharray={w.confirmed ? undefined : "5 5"}
                strokeLinejoin="round"
              />
              <rect
                x={midX - 19}
                y={midY - 10}
                width="38"
                height="20"
                rx="4"
                fill={isFault ? "#fbefdf" : "#f6f9ee"}
                stroke={color}
              />
              <text
                x={midX}
                y={midY + 4}
                textAnchor="middle"
                fill={color}
                fontSize="10"
                fontFamily="monospace"
              >
                {w.label.length > 10 ? "WIRE" : w.label}
              </text>
            </g>
          );
        })}
        {graph.nodes.map((n, i) => {
          const p = positions.get(n.id)!;
          return (
            <g key={n.id}>
              <circle
                cx={p.x}
                cy={p.y}
                r="6"
                stroke="#91aa83"
                strokeWidth="1.5"
                fill="#fcfdf8"
              />
              <circle cx={p.x} cy={p.y} r="2" fill="#91aa83" />
              <text
                x={p.x}
                y={p.y + 24}
                textAnchor="middle"
                fontSize="9"
                fontFamily="monospace"
                fill="#839678"
              >
                {label(n, i)}
              </text>
              <title>{n.label}</title>
            </g>
          );
        })}
      </svg>
      <div className="bench-device-row">
        {graph.devices.map((d) => (
          <span key={d.id}>
            <BenchIcon name={d.type === "led" ? "bolt" : "circuit"} size={13} />
            <strong>{d.label}</strong>
            <span>
              {d.type.replaceAll("_", " ")}
              {d.state ? ` · ${d.state}` : ""}
            </span>
          </span>
        ))}
      </div>
      <details className="bench-netlist">
        <summary>View electrical netlist</summary>
        <p>
          Device ports stay distinct. Wires may join contacts within one
          electrical net.
        </p>
        {graph.netlist.map((n, i) => (
          <div key={n.id}>
            <span>NET {String(i + 1).padStart(2, "0")}</span>
            <span>{n.terminals.join(" · ")}</span>
          </div>
        ))}
      </details>
    </section>
  );
}
