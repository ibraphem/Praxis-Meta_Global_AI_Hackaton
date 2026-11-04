import {
  conductiveTypes,
  terminalKey,
  type ElectricalGraph,
} from './connectivity.js';

export function connectionProjection(graph: ElectricalGraph) {
  const parent = new Map(graph.points.map((p) => [p.id, p.id]));
  const find = (x: string): string => {
    const p = parent.get(x)!;
    if (p !== x) parent.set(x, find(p));
    return parent.get(x)!;
  };
  for (const e of graph.connections.filter((e) => e.type !== 'wire')) {
    const a = find(e.from),
      b = find(e.to);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const groups = new Map<string, string[]>();
  for (const p of graph.points) {
    const root = find(p.id),
      members = groups.get(root) ?? [];
    members.push(p.id);
    groups.set(root, members);
  }
  const relevant = new Set(graph.terminals.map((t) => find(terminalKey(t.id))));
  const nodes = [...groups]
    .filter(([id]) => relevant.has(id))
    .map(([id, members]) => ({
      id,
      members: members.sort(),
      label:
        members
          .filter((m) => m.startsWith('hole:'))
          .slice(0, 2)
          .map((m) => m.replace(/^hole:/, ''))
          .join(' / ') ||
        members
          .find((m) => m.startsWith('terminal:'))
          ?.replace(/^terminal:/, '') ||
        id,
      netId: graph.nodes.find((n) => n.members.includes(id))?.id ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const wires = graph.components
    .filter(
      (c) =>
        conductiveTypes.has(c.type) &&
        c.state !== 'rejected' &&
        c.terminalIds.length === 2,
    )
    .map((c) => ({
      id: c.id,
      label: c.label,
      from: find(terminalKey(c.terminalIds[0]!)),
      to: find(terminalKey(c.terminalIds[1]!)),
      kind: 'wire' as const,
      confirmed:
        graph.connections.some(
          (e) => e.type === 'wire' && e.componentId === c.id,
        ) &&
        c.terminalIds.every(
          (id) =>
            graph.terminals.find((t) => t.id === id)?.associationConfirmed,
        ),
      objectRef: c.objectRef,
      bbox: c.bbox,
    }));
  const devices = graph.devices.map((d) => ({
    id: d.componentId,
    label: graph.components.find((c) => c.id === d.componentId)!.label,
    kind: 'device' as const,
    type: d.type,
    state: d.switchState,
    ports: d.terminals.map((t) => ({
      terminalId: t.terminalId,
      nodeId: find(terminalKey(t.terminalId)),
      role: graph.terminals.find((v) => v.id === t.terminalId)?.role ?? null,
    })),
  }));
  return {
    nodes,
    wires,
    devices,
    netlist: graph.nodes
      .filter((n) => n.members.some((m) => m.startsWith('terminal:')))
      .map((n) => ({
        id: n.id,
        terminals: n.members
          .filter((m) => m.startsWith('terminal:'))
          .map((m) => m.slice(9)),
      })),
  };
}
