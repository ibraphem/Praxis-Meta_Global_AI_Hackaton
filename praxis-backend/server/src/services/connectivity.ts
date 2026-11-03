import { canonicalHash } from '../lib/canonical-json.js';
import {
  allHoles,
  calibrateBoard,
  project,
  registerRail,
  type Calibration,
  type Rail,
} from '../shared/calibration.js';
import {
  circuitInputSchema,
  circuitReferenceSchema,
  confirmed,
  type CircuitInput,
  type CircuitReference,
} from '../schemas/connectivity.js';

export const conductiveTypes = new Set(['jumper_wire', 'conductor']);
export const deviceTypes = new Set([
  'led',
  'resistor',
  'ldr',
  'npn_transistor',
  'power_source',
  'battery',
  'dc_power_source',
  'switch',
  'button',
]);
const sorted = <T extends { id: string }>(v: T[]) =>
  [...v].sort((a, b) => a.id.localeCompare(b.id));
export const holeKey = (board: string, hole: string) => `hole:${board}:${hole}`;
export const terminalKey = (terminal: string) => `terminal:${terminal}`;
export function validateCircuitInput(raw: unknown): CircuitInput {
  const input = circuitInputSchema.parse(raw);
  for (const values of [
    input.boards,
    input.components,
    input.terminals,
    input.associations,
  ])
    if (new Set(values.map((v) => v.id)).size !== values.length)
      throw Error('Duplicate circuit identity.');
  const components = new Map(input.components.map((c) => [c.id, c])),
    terminals = new Map(input.terminals.map((t) => [t.id, t]));
  for (const c of input.components) {
    if (
      new Set(c.terminalIds).size !== c.terminalIds.length ||
      c.terminalIds.some((id) => terminals.get(id)?.componentId !== c.id)
    )
      throw Error('Invalid component terminal ownership.');
    if (conductiveTypes.has(c.type) && c.terminalIds.length !== 2)
      throw Error('A conductor must have exactly two terminals.');
    if (['switch', 'button'].includes(c.type)) {
      const aliases = c.contactAliases ?? [],
        aliasIds = new Set(aliases.map((a) => a.terminalId));
      if (
        aliasIds.size !== aliases.length ||
        c.terminalIds.filter((id) => !aliasIds.has(id)).length !== 2
      )
        throw Error(
          'A switch must have exactly two effective contacts with unique physical-leg aliases.',
        );
      for (const a of aliases)
        if (
          !c.terminalIds.includes(a.terminalId) ||
          !c.terminalIds.includes(a.contactTerminalId) ||
          aliasIds.has(a.contactTerminalId) ||
          a.terminalId === a.contactTerminalId ||
          terminals.get(a.terminalId)?.role !== null
        )
          throw Error(
            'Switch aliases must map a separate physical leg directly to one effective contact, never another alias.',
          );
    } else if (c.contactAliases?.length)
      throw Error('Contact aliases require a switch device.');
  }
  for (const t of input.terminals)
    if (!components.get(t.componentId)?.terminalIds.includes(t.id))
      throw Error('Orphan terminal.');
  for (const board of input.boards) {
    if (
      board.id !== board.calibration.breadboardId ||
      new Set(board.rails.map((r) => r.id)).size !== board.rails.length
    )
      throw Error('Invalid board identity.');
    const recalculated = calibrateBoard(
      board.id,
      board.calibration.rows,
      board.calibration.image,
      board.calibration.anchors,
    );
    if (
      ['forward', 'inverse'].some((key) =>
        recalculated[key as 'forward'].some(
          (v, i) =>
            Math.abs(v - board.calibration[key as 'forward'][i]!) > 1e-8,
        ),
      )
    )
      throw Error('Calibration transform is inconsistent with its anchors.');
    for (const rail of board.rails) {
      const checked = registerRail(
        recalculated,
        rail,
        project(recalculated, rail.first),
        project(recalculated, rail.last),
      );
      if (
        checked.connectivity !== rail.connectivity ||
        checked.splitAfter !== rail.splitAfter
      )
        throw Error('Invalid rail declaration.');
    }
  }
  const active = new Set<string>();
  for (const a of input.associations) {
    if (!terminals.has(a.terminalId))
      throw Error('Unknown association terminal.');
    if (
      a.target?.kind === 'terminal' &&
      (!terminals.has(a.target.terminalId) ||
        a.target.terminalId === a.terminalId)
    )
      throw Error('Invalid target terminal.');
    if (confirmed(a.state) && !a.evidence.length)
      throw Error('Confirmed association requires provenance.');
    if (
      confirmed(a.state) &&
      ['insertion', 'conductive_contact'].includes(a.type)
    ) {
      if (active.has(a.terminalId) || !a.target)
        throw Error('Conflicting or absent confirmed terminal association.');
      active.add(a.terminalId);
    }
  }
  return input;
}
export function buildConnectivity(raw: unknown) {
  const input = validateCircuitInput(raw),
    parent = new Map<string, string>();
  const pointRecords: Array<{
    id: string;
    kind: 'hole' | 'terminal';
    boardId: string | null;
    holeId: string | null;
    terminalId: string | null;
    position: { x: number; y: number } | null;
    positionBasis:
      | 'calibrated_hole_projection'
      | 'unverified_terminal_observation'
      | 'unlocated'
      | 'confirmed_hole_projection';
  }> = [];
  const warnings: string[] = [],
    unresolved: Array<{
      id: string;
      terminalId: string | null;
      reason: string;
      blocksConductiveCompleteness: boolean;
    }> = [];
  const edges: Array<{
    id: string;
    from: string;
    to: string;
    type:
      | 'topology'
      | 'wire'
      | 'insertion'
      | 'conductive_contact'
      | 'switch_contact_alias';
    state: 'confirmed_auto' | 'confirmed_manual';
    evidenceIds: string[];
    componentId: string | null;
  }> = [];
  const proofMap = new Map<
    string,
    CircuitInput['components'][number]['evidence'][number]
  >();
  for (const v of [
    ...input.boards,
    ...input.components,
    ...input.terminals,
    ...input.associations,
    ...input.components.flatMap((c) => c.contactAliases ?? []),
    ...input.components.map((c) => ({ evidence: c.switchStateEvidence ?? [] })),
  ])
    for (const p of v.evidence) {
      const prior = proofMap.get(p.id);
      if (prior && canonicalHash(prior) !== canonicalHash(p))
        throw Error('Conflicting evidence identity.');
      proofMap.set(p.id, p);
    }
  for (const p of input.coverage.evidence) {
    const existing = proofMap.get(p.id);
    if (existing && canonicalHash(existing) !== canonicalHash(p))
      throw Error('Conflicting coverage evidence identity.');
    proofMap.set(p.id, p);
  }
  if (!confirmed(input.coverage.state) || !input.coverage.evidence.length)
    unresolved.push({
      id: 'conductive-review-coverage',
      terminalId: null,
      reason:
        'All relevant conductive paths have not been explicitly reviewed; missing paths cannot establish a confirmed fault.',
      blocksConductiveCompleteness: true,
    });
  const find = (x: string): string => {
    const p = parent.get(x);
    if (!p) throw Error('Unknown conductive point.');
    if (p !== x) parent.set(x, find(p));
    return parent.get(x)!;
  };
  const join = (a: string, b: string) => {
    const x = find(a),
      y = find(b);
    if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
  };
  const add = (p: (typeof pointRecords)[number]) => {
    parent.set(p.id, p.id);
    pointRecords.push(p);
  };
  const edge = (e: (typeof edges)[number]) => {
    edges.push(e);
    join(e.from, e.to);
  };
  for (const board of sorted(input.boards)) {
    const calibration = board.calibration as Calibration,
      groups = new Map<string, string[]>();
    for (const hole of allHoles(calibration, board.rails as Rail[])) {
      const key = holeKey(board.id, hole.id);
      add({
        id: key,
        kind: 'hole',
        boardId: board.id,
        holeId: hole.id,
        terminalId: null,
        position: project(calibration, hole.grid),
        positionBasis: 'calibrated_hole_projection',
      });
      if (
        hole.electricalGroup &&
        confirmed(board.topologyState) &&
        board.evidence.length
      ) {
        const members = groups.get(hole.electricalGroup) ?? [];
        members.push(key);
        groups.set(hole.electricalGroup, members);
      } else if (hole.kind === 'rail' && hole.groupBasis === 'unknown')
        unresolved.push({
          id: key,
          terminalId: null,
          reason: 'Power rail continuity is undeclared.',
          blocksConductiveCompleteness: true,
        });
    }
    if (!confirmed(board.topologyState) || !board.evidence.length)
      unresolved.push({
        id: board.id,
        terminalId: null,
        reason: 'Breadboard topology requires explicit confirmation.',
        blocksConductiveCompleteness: true,
      });
    for (const [group, members] of [...groups].sort())
      for (const member of members.slice(1))
        edge({
          id: `topology:${group}:${member}`,
          from: members[0]!,
          to: member,
          type: 'topology',
          state: 'confirmed_manual',
          evidenceIds: board.evidence.map((p) => p.id).sort(),
          componentId: null,
        });
  }
  for (const t of sorted(input.terminals))
    add({
      id: terminalKey(t.id),
      kind: 'terminal',
      boardId: null,
      holeId: null,
      terminalId: t.id,
      position: t.position,
      positionBasis: t.position
        ? 'unverified_terminal_observation'
        : 'unlocated',
    });
  const attached = new Set<string>();
  for (const a of sorted(input.associations)) {
    if (
      a.state === 'rejected' ||
      input.components.find(
        (c) =>
          c.id ===
          input.terminals.find((t) => t.id === a.terminalId)?.componentId,
      )?.state === 'rejected'
    )
      continue;
    let reason: string | null = null,
      target: string | null = null;
    if (
      !confirmed(a.state) ||
      !a.target ||
      !['insertion', 'conductive_contact'].includes(a.type)
    )
      reason = 'Physical proposal does not establish electrical contact.';
    else if (a.target.kind === 'hole') {
      const b = input.boards.find(
        (b) => b.id === (a.target?.kind === 'hole' ? a.target.boardId : null),
      );
      if (!b || b.revision !== a.target.calibrationRevision)
        reason = 'Association calibration is stale or absent.';
      else {
        target = holeKey(a.target.boardId, a.target.holeId);
        if (!parent.has(target)) reason = 'Associated hole is not registered.';
      }
    } else {
      const targetTerminal = input.terminals.find(
        (t) =>
          t.id === (a.target?.kind === 'terminal' ? a.target.terminalId : null),
      );
      if (
        input.components.find((c) => c.id === targetTerminal?.componentId)
          ?.state === 'rejected'
      )
        reason =
          'Target component hypothesis was excluded from electrical reasoning.';
      else target = terminalKey(a.target.terminalId);
    }
    if (reason)
      unresolved.push({
        id: a.id,
        terminalId: a.terminalId,
        reason,
        blocksConductiveCompleteness: conductiveTypes.has(
          input.components.find(
            (c) =>
              c.id ===
              input.terminals.find((t) => t.id === a.terminalId)?.componentId,
          )?.type ?? '',
        ),
      });
    else if (target) {
      edge({
        id: a.id,
        from: terminalKey(a.terminalId),
        to: target,
        type: a.type as 'insertion' | 'conductive_contact',
        state: a.state as 'confirmed_manual' | 'confirmed_auto',
        evidenceIds: a.evidence.map((p) => p.id).sort(),
        componentId: null,
      });
      attached.add(a.terminalId);
      if (a.target?.kind === 'terminal') attached.add(a.target.terminalId);
    }
  }
  for (const c of sorted(input.components)) {
    if (c.state === 'rejected') continue;
    if (['switch', 'button'].includes(c.type))
      for (const alias of c.contactAliases ?? []) {
        if (
          confirmed(c.state) &&
          confirmed(alias.state) &&
          alias.evidence.some((p) =>
            ['human_review', 'synthetic_fixture'].includes(p.source),
          )
        ) {
          edge({
            id: `switch-alias:${alias.terminalId}`,
            from: terminalKey(alias.terminalId),
            to: terminalKey(alias.contactTerminalId),
            type: 'switch_contact_alias',
            state: 'confirmed_manual',
            evidenceIds: alias.evidence.map((p) => p.id),
            componentId: c.id,
          });
        } else
          unresolved.push({
            id: `switch-alias:${alias.terminalId}`,
            terminalId: alias.terminalId,
            reason: 'The physical switch leg/contact mapping is unverified.',
            blocksConductiveCompleteness: true,
          });
      }
    if (
      ['switch', 'button'].includes(c.type) &&
      c.switchState === 'closed' &&
      !c.switchStateEvidence?.some((p) =>
        ['human_review', 'synthetic_fixture'].includes(p.source),
      )
    )
      warnings.push(
        `Switch ${c.id} has an unsupported closed-state claim; treat its state as unknown.`,
      );
    if (conductiveTypes.has(c.type)) {
      if (confirmed(c.state) && confirmed(c.continuity) && c.evidence.length)
        edge({
          id: `wire:${c.id}`,
          from: terminalKey(c.terminalIds[0]!),
          to: terminalKey(c.terminalIds[1]!),
          type: 'wire',
          state: 'confirmed_manual',
          evidenceIds: c.evidence.map((p) => p.id).sort(),
          componentId: c.id,
        });
      else
        unresolved.push({
          id: c.id,
          terminalId: null,
          reason:
            'Same-conductor identity and intact conductive path require confirmation.',
          blocksConductiveCompleteness: true,
        });
    } else if (!deviceTypes.has(c.type) && c.type !== 'breadboard') {
      warnings.push(`Component ${c.id} has an unknown device model.`);
      unresolved.push({
        id: c.id,
        terminalId: null,
        reason: 'Unknown device conductivity.',
        blocksConductiveCompleteness: true,
      });
    }
    for (const id of c.terminalIds)
      if (!attached.has(id))
        unresolved.push({
          id: `unplaced:${id}`,
          terminalId: id,
          reason: 'Terminal has no current confirmed electrical association.',
          blocksConductiveCompleteness: conductiveTypes.has(c.type),
        });
  }
  for (const e of edges.filter((e) => e.type === 'insertion')) {
    const terminal = pointRecords.find((p) => p.id === e.from),
      hole = pointRecords.find((p) => p.id === e.to);
    if (terminal && hole?.position) {
      terminal.position = hole.position;
      terminal.positionBasis = 'confirmed_hole_projection';
    }
  }
  const groups = new Map<string, string[]>();
  for (const key of [...parent.keys()].sort()) {
    const root = find(key),
      group = groups.get(root) ?? [];
    group.push(key);
    groups.set(root, group);
  }
  const nodes = [...groups.values()]
    .map((members) => ({
      id: `net:${canonicalHash(members).slice(0, 24)}`,
      members,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const membership = new Map(
    nodes.flatMap((n) => n.members.map((m) => [m, n.id] as const)),
  );
  const terminals = sorted(input.terminals).map((t) => ({
    ...t,
    nodeId: membership.get(terminalKey(t.id))!,
    associationConfirmed: attached.has(t.id),
  }));
  const devices = sorted(input.components)
    .filter((c) => c.state !== 'rejected' && deviceTypes.has(c.type))
    .map((c) => ({
      id: `device:${c.id}`,
      componentId: c.id,
      type: c.type,
      terminals: c.terminalIds
        .filter((id) => !c.contactAliases?.some((a) => a.terminalId === id))
        .map((id) => ({
          terminalId: id,
          nodeId: membership.get(terminalKey(id))!,
        })),
      behavior: 'typed_device_not_a_short' as const,
      switchState: ['switch', 'button'].includes(c.type)
        ? c.switchState === 'closed' &&
          !c.switchStateEvidence?.some((p) =>
            ['human_review', 'synthetic_fixture'].includes(p.source),
          )
          ? 'unknown'
          : (c.switchState ?? 'unknown')
        : null,
      switchStateEvidence: c.switchStateEvidence ?? [],
    }));
  const graph = {
    schemaVersion: 'praxis-electrical-graph-v1' as const,
    algorithmVersion: 'conductive-union-v1',
    analysisId: input.analysisId,
    imageHash: input.imageHash,
    boards: sorted(input.boards),
    validationScope: input.validationScope,
    associations: sorted(input.associations),
    components: sorted(input.components),
    terminals,
    nodes,
    points: sorted(pointRecords),
    connections: sorted(edges),
    devices,
    unresolved: sorted(unresolved),
    provenance: sorted([...proofMap.values()]),
    warnings: warnings.sort(),
    conductiveCompleteness: !unresolved.some(
      (u) => u.blocksConductiveCompleteness,
    ),
  };
  return { ...graph, graphHash: canonicalHash(graph) };
}
export type ElectricalGraph = ReturnType<typeof buildConnectivity>;
export function validateCircuitReference(raw: unknown): CircuitReference {
  const ref = circuitReferenceSchema.parse(raw),
    ports = new Set<string>(),
    parts = new Set<string>();
  for (const c of ref.components) {
    if (parts.has(c.id)) throw Error('Duplicate reference component.');
    parts.add(c.id);
    if (
      ref.qualification === 'verified_human' &&
      c.type === 'npn_transistor' &&
      (!c.partNumber || !c.package || !c.pinoutSource)
    )
      throw Error('Verified transistor part/package pinout is required.');
    for (const role of c.terminalRoles) {
      const id = `${c.id}:${role}`;
      if (ports.has(id)) throw Error('Duplicate reference terminal.');
      ports.add(id);
    }
  }
  if (
    new Set(ref.nets.map((n) => n.id)).size !== ref.nets.length ||
    new Set(ref.rules.map((r) => r.id)).size !== ref.rules.length
  )
    throw Error('Duplicate reference net or rule identity.');
  const used = new Set<string>();
  for (const n of ref.nets)
    for (const t of n.terminals) {
      if (!ports.has(t) || used.has(t))
        throw Error(
          'Reference terminal has invalid or multiple net membership.',
        );
      used.add(t);
    }
  for (const r of ref.rules)
    if (
      !ports.has(r.from) ||
      !ports.has(r.to) ||
      !ref.components.some(
        (c) => c.id === r.jumper && conductiveTypes.has(c.type),
      ) ||
      !ref.nets.some(
        (n) => n.terminals.includes(r.from) && n.terminals.includes(r.to),
      )
    )
      throw Error('Fault rule is inconsistent with reference nets.');
  return ref;
}
export function compareConnectivity(
  graph: ElectricalGraph,
  raw: unknown,
  mapping: Record<string, string>,
) {
  const reference = validateCircuitReference(raw),
    values = Object.values(mapping);
  if (new Set(values).size !== values.length)
    throw Error('Reference mapping must be one-to-one.');
  const resolve = (port: string) => {
    const i = port.lastIndexOf(':'),
      part = reference.components.find((c) => c.id === port.slice(0, i)),
      c = graph.components.find((c) => c.id === mapping[port.slice(0, i)]);
    if (!part || !c || part.type !== c.type || !confirmed(c.state))
      return undefined;
    const matches = graph.terminals.filter(
      (t) =>
        t.componentId === c.id &&
        t.role === port.slice(i + 1) &&
        confirmed(t.roleState) &&
        t.evidence.length,
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  const findings = reference.rules.map((rule) => {
    const from = resolve(rule.from),
      to = resolve(rule.to),
      wire = graph.components.find((c) => c.id === mapping[rule.jumper]);
    const ends = wire?.terminalIds.map((id) =>
      graph.terminals.find((t) => t.id === id),
    );
    const ready =
      from?.associationConfirmed &&
      to?.associationConfirmed &&
      wire &&
      conductiveTypes.has(wire.type) &&
      confirmed(wire.state) &&
      confirmed(wire.continuity) &&
      ends?.length === 2 &&
      ends.every((t) => t?.associationConfirmed);
    let status:
        | 'confirmed_fault'
        | 'possible_fault'
        | 'insufficient_evidence'
        | 'no_fault',
      reason: string;
    if (!ready || reference.qualification === 'draft') {
      status = 'insufficient_evidence';
      reason =
        'Confirm reference mapping, terminal roles, contact associations and the selected jumper before diagnosing.';
    } else if (from.nodeId === to.nodeId) {
      status = 'no_fault';
      reason =
        'The required terminals share a confirmed conductive node. This does not establish full circuit operation.';
    } else if (!ends!.some((t) => t!.nodeId === from.nodeId)) {
      status = 'insufficient_evidence';
      reason =
        'The selected jumper is not confirmed on the source net; the missing relationship cannot be attributed to this jumper.';
    } else {
      status = graph.conductiveCompleteness
        ? 'confirmed_fault'
        : 'possible_fault';
      reason = graph.conductiveCompleteness
        ? 'The selected jumper is confirmed on the source net but its other endpoint is on a different node from the required destination.'
        : 'The confirmed selected jumper misses the required destination node, but unresolved conductive evidence may change connectivity.';
    }
    const endpointIds = ends?.map((t) => t!.id) ?? [],
      related = new Set([from?.id, to?.id, ...endpointIds].filter(Boolean));
    const observed = graph.connections.filter(
      (e) =>
        related.has(e.from.replace(/^terminal:/, '')) ||
        related.has(e.to.replace(/^terminal:/, '')),
    );
    const endpointLocations = endpointIds.map((terminalId) => ({
      terminalId,
      associations: graph.associations
        .filter(
          (a) =>
            a.terminalId === terminalId &&
            confirmed(a.state) &&
            ['insertion', 'conductive_contact'].includes(a.type),
        )
        .map((a) => a.target),
    }));
    const componentLabel = (id: string | undefined) =>
      graph.components.find((c) => c.id === id)?.label ?? id ?? 'unknown';
    if (ready && (status === 'confirmed_fault' || status === 'possible_fault'))
      reason += ` Source: ${componentLabel(from!.componentId)} ${from!.role}; required destination: ${componentLabel(to!.componentId)} ${to!.role}. ${componentLabel(wire!.id)} endpoints: ${endpointLocations.map((e) => e.associations.map((a) => (a?.kind === 'hole' ? `${a.boardId}/${a.holeId}` : a?.kind === 'terminal' ? a.terminalId : 'unknown')).join(', ')).join(' ↔ ')}.`;

    return {
      id: `finding:${rule.id}`,
      ruleId: rule.id,
      status,
      reason,
      scope:
        graph.validationScope === 'synthetic_fixture' ||
        reference.qualification === 'synthetic_fixture'
          ? 'synthetic_fixture'
          : reference.qualification === 'verified_human'
            ? 'reviewed_photograph'
            : 'draft',
      expected: {
        from: rule.from,
        to: rule.to,
        relationship: 'same_conductive_node',
      },
      observed: {
        fromTerminalId: from?.id ?? null,
        toTerminalId: to?.id ?? null,
        fromNodeId: from?.nodeId ?? null,
        toNodeId: to?.nodeId ?? null,
        jumperId: wire?.id ?? null,
        endpointIds,
        endpointLocations,
      },
      highlight: {
        componentIds: [
          ...new Set(
            [from?.componentId, to?.componentId, wire?.id].filter(
              (x): x is string => !!x,
            ),
          ),
        ],
        connectionIds: observed.map((e) => e.id),
        destinationNodeId: to?.associationConfirmed ? to.nodeId : null,
      },
      evidenceIds: [...new Set(observed.flatMap((e) => e.evidenceIds))].sort(),
      electricalOperationVerified: false,
    };
  });
  const comparison = {
    schemaVersion: 'praxis-connectivity-comparison-v1',
    graphHash: graph.graphHash,
    referenceHash: canonicalHash(reference),
    mapping,
    findings,
  };
  return { ...comparison, comparisonHash: canonicalHash(comparison) };
}
export type ConnectivityComparison = ReturnType<typeof compareConnectivity>;
