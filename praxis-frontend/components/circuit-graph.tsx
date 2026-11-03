"use client";
import type { CircuitSessionView } from "@/lib/circuit-session";
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
  const positions = new Map(
      graph.nodes.map((n, i) => [
        n.id,
        { x: 90 + (i % 4) * 200, y: 45 + Math.floor(i / 4) * 130 },
      ]),
    ),
    height = Math.max(180, Math.ceil(graph.nodes.length / 4) * 130 + 30);
  return (
    <section aria-label="Circuit graph">
      <h2>Observed connections</h2>
      <p>
        Conductive strips before jumper union. Device ports remain distinct.
        Hover a wire or its edge to inspect the same observation.
      </p>
      <svg
        viewBox={`0 0 800 ${height}`}
        role="img"
        aria-label="Observed circuit connection graph"
        style={{ width: "100%", maxHeight: 460 }}
      >
        {graph.wires.map((w) => {
          const a = positions.get(w.from),
            b = positions.get(w.to);
          if (!a || !b) return null;
          return (
            <g
              key={w.id}
              style={{ cursor: "pointer" }}
              pointerEvents="bounding-box"
              role="button"
              tabIndex={0}
              aria-label={`Inspect graph wire ${w.label}`}
              onMouseEnter={() =>
                onSelect(
                  w.objectRef.kind === "baseline" ? w.objectRef.id : w.id,
                )
              }
              onMouseLeave={() => onSelect(null)}
              onFocus={() =>
                onSelect(
                  w.objectRef.kind === "baseline" ? w.objectRef.id : w.id,
                )
              }
              onBlur={() => onSelect(null)}
              onClick={() =>
                onSelect(
                  w.objectRef.kind === "baseline" ? w.objectRef.id : w.id,
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(
                    w.objectRef.kind === "baseline" ? w.objectRef.id : w.id,
                  );
                }
              }}
            >
              <path
                d={
                  a === b
                    ? `M ${a.x} ${a.y} c 50 -70 70 70 0 0`
                    : `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${(a.y + b.y) / 2 - 35} ${b.x} ${b.y}`
                }
                fill="none"
                stroke={
                  selected === w.objectRef.id || selected === w.id
                    ? "#167fa4"
                    : fault && w.id === faultWireId
                      ? "#b93232"
                      : w.confirmed
                        ? "#278066"
                        : "#b58535"
                }
                strokeWidth={
                  selected === w.objectRef.id || selected === w.id ? 7 : 3
                }
                strokeDasharray={w.confirmed ? undefined : "7 5"}
              />
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 12} fontSize="13">
                {w.label}
              </text>
            </g>
          );
        })}
        {graph.nodes.map((n) => {
          const p = positions.get(n.id)!;
          return (
            <g key={n.id}>
              <circle cx={p.x} cy={p.y} r="8" fill="#4c6c64" />
              <text x={p.x} y={p.y + 24} textAnchor="middle" fontSize="12">
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="camera-device-list">
        {graph.devices.map((d) => (
          <span key={d.id}>
            {d.label} · {d.type}
            {d.state ? ` (${d.state})` : ""}
            <small>
              {d.ports
                .map(
                  (p) =>
                    `${p.role ?? "?"} → ${graph.nodes.find((n) => n.id === p.nodeId)?.label ?? "unresolved"}`,
                )
                .join(" | ")}
            </small>
          </span>
        ))}
      </div>
      <details>
        <summary>Electrical netlist after conductive union</summary>
        {graph.netlist.map((n) => (
          <p key={n.id}>
            <code>{n.id.slice(0, 16)}</code>: {n.terminals.join(", ")}
          </p>
        ))}
      </details>
    </section>
  );
}
