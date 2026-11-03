import { canonicalHash } from '../lib/canonical-json.js';
import {
  buildConnectivity,
  compareConnectivity,
  holeKey,
  terminalKey,
  conductiveTypes,
  type ElectricalGraph,
} from './connectivity.js';
import {
  confirmed,
  type CircuitInput,
  type CircuitReference,
} from '../schemas/connectivity.js';
import {
  demoPartIds,
  repairInstructionSchema,
  type CircuitProfile,
  type RepairInstruction,
  type VerificationResult,
} from '../schemas/circuit-session.js';
import {
  allHoles,
  project,
  type Calibration,
  type Rail,
} from '../shared/calibration.js';
export const demoTypes = {
  P1: 'power_source',
  R1: 'resistor',
  D1: 'led',
  S1: 'switch',
  R2: 'resistor',
  J1: 'jumper_wire',
  D2: 'led',
} as const;
export const demoRoles = {
  P1: ['positive', 'negative'],
  R1: ['terminal1', 'terminal2'],
  D1: ['anode', 'cathode'],
  S1: ['contactA', 'contactB'],
  R2: ['terminal1', 'terminal2'],
  J1: ['a', 'b'],
  D2: ['anode', 'cathode'],
} as const;
export function twoLedReference(
  parts: CircuitProfile['parts'],
  qualification: CircuitProfile['qualification'],
  reviewer: string,
): CircuitReference {
  return {
    schemaVersion: 'praxis-reference-circuit-v1',
    id: 'two-led-button',
    version: 1,
    name: 'Two-LED button indicator',
    qualification,
    schematicSource:
      parts.schematicSource ||
      'Draft intended two-LED series-branch design; physical build unverified.',
    reviewer,
    components: demoPartIds.map((id) => ({
      id,
      type: demoTypes[id],
      terminalRoles: [...demoRoles[id]],
      value:
        id === 'P1'
          ? `${parts.supplyVolts} V`
          : id === 'R1'
            ? `${parts.r1Ohms} ohm`
            : id === 'R2'
              ? `${parts.r2Ohms} ohm`
              : null,
      partNumber: id === 'S1' ? parts.switchPart || null : null,
      package: null,
      pinoutSource: id === 'S1' ? parts.switchContacts || null : null,
    })),
    nets: [
      { id: 'vcc', terminals: ['P1:positive', 'R1:terminal1', 'S1:contactA'] },
      { id: 'ground', terminals: ['P1:negative', 'D1:cathode', 'D2:cathode'] },
      { id: 'green-feed', terminals: ['R1:terminal2', 'D1:anode'] },
      { id: 'switched-feed', terminals: ['S1:contactB', 'R2:terminal1'] },
      {
        id: 'red-feed',
        terminals: ['R2:terminal2', 'J1:a', 'J1:b', 'D2:anode'],
      },
    ],
    rules: [
      {
        id: 'red-led-feed',
        kind: 'required_conductive_path',
        from: 'R2:terminal2',
        to: 'D2:anode',
        jumper: 'J1',
      },
    ],
  };
}
export function mappedTerminal(
  input: CircuitInput,
  mapping: CircuitProfile['mapping'],
  part: (typeof demoPartIds)[number],
  role: string,
) {
  const c = input.components.find(
    (c) => c.id === mapping[part] && confirmed(c.state),
  );
  if (!c) return undefined;
  const terminals = input.terminals.filter(
    (t) =>
      t.componentId === c.id &&
      t.role === role &&
      confirmed(t.roleState) &&
      t.evidence.length,
  );
  return terminals.length === 1 ? terminals[0] : undefined;
}
export function validateProfileWiring(
  input: CircuitInput,
  mapping: CircuitProfile['mapping'],
  reference: CircuitReference,
) {
  const graph = buildConnectivity(input);
  if (!graph.conductiveCompleteness)
    throw Error(
      'Resolve conductive evidence and confirm review coverage before qualifying the physical setup.',
    );
  for (const id of demoPartIds) {
    const c = input.components.find((c) => c.id === mapping[id]);
    if (
      !c ||
      !(
        c.type === demoTypes[id] ||
        (id === 'P1' && ['battery', 'dc_power_source'].includes(c.type)) ||
        (id === 'J1' && c.type === 'conductor') ||
        (id === 'S1' && c.type === 'button')
      ) ||
      !confirmed(c.state)
    )
      throw Error(`Confirm the physical identity and type of ${id}.`);
    if (
      c.terminalIds.some(
        (tid) =>
          !graph.terminals.find((t) => t.id === tid)?.associationConfirmed,
      )
    )
      throw Error(
        `Confirm all physical terminal insertions of ${id}, including switch contact aliases.`,
      );
    for (const role of demoRoles[id])
      if (!mappedTerminal(input, mapping, id, role))
        throw Error(`Identify ${id} ${role} using reviewed physical evidence.`);
  }
  const membership = new Map(
      graph.nodes.flatMap((n) => n.members.map((m) => [m, n.id] as const)),
    ),
    usedNets = new Map<string, string>();
  for (const n of reference.nets) {
    let observed: string | undefined;
    for (const port of n.terminals) {
      const [part, role] = port.split(':') as [
          (typeof demoPartIds)[number],
          string,
        ],
        terminal = mappedTerminal(input, mapping, part, role)!;
      if (
        !graph.terminals.find((t) => t.id === terminal.id)?.associationConfirmed
      )
        throw Error(`Confirm the electrical association of ${port}.`);
      const net = membership.get(terminalKey(terminal.id))!;
      if (observed && observed !== net)
        throw Error(`The reviewed setup does not match intended net ${n.id}.`);
      observed = net;
    }
    if (observed) {
      const prior = usedNets.get(observed);
      if (prior && prior !== n.id)
        throw Error(
          `Reference nets ${prior} and ${n.id} are unexpectedly merged.`,
        );
      usedNets.set(observed, n.id);
    }
  }
  return graph;
}
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
export function profileComparison(
  profile: CircuitProfile,
  input: CircuitInput,
) {
  const reference = structuredClone(profile.reference);
  // Equivalent physical roles are accepted only through the reviewed profile mapping.
  for (const part of reference.components) {
    const observed = input.components.find(
      (c) => c.id === profile.mapping[part.id as keyof typeof profile.mapping],
    );
    if (
      observed &&
      ((part.id === 'P1' &&
        ['battery', 'dc_power_source'].includes(observed.type)) ||
        (part.id === 'J1' && observed.type === 'conductor') ||
        (part.id === 'S1' && observed.type === 'button'))
    )
      part.type = observed.type;
  }
  return compareConnectivity(
    buildConnectivity(input),
    reference,
    profile.mapping,
  );
}
export function planCircuitRepair(args: {
  sessionId: string;
  captureId: string;
  profile: CircuitProfile;
  input: CircuitInput;
  target: { boardId: string; holeId: string };
  reviewer: string;
  note: string;
  timestamp: number;
}): RepairInstruction {
  const { profile, input, target } = args;
  if (profile.qualification === 'draft')
    throw Error('The physical profile is still draft.');
  const graph = buildConnectivity(input),
    comparison = profileComparison(profile, input),
    finding = comparison.findings.find((f) => f.status === 'confirmed_fault');
  if (!finding)
    throw Error(
      'A current confirmed J1 fault is required before exact-hole guidance.',
    );
  const moving = profile.movingTerminalId,
    anchored = profile.anchoredTerminalId;
  if (!moving || !anchored) throw Error('J1 end identity is unresolved.');
  const current = input.associations.find(
      (a) =>
        a.terminalId === moving && confirmed(a.state) && a.type === 'insertion',
    ),
    fixed = graph.terminals.find((t) => t.id === anchored),
    from = graph.terminals.find((t) => t.id === profile.requiredFromTerminalId),
    to = graph.terminals.find((t) => t.id === profile.requiredToTerminalId);
  if (
    current?.target?.kind !== 'hole' ||
    !fixed?.associationConfirmed ||
    fixed.nodeId !== from?.nodeId ||
    !to?.associationConfirmed
  )
    throw Error('Confirm both J1 ends and the unchanged R2-side anchor.');
  const destination = graph.nodes.find((n) => n.id === to.nodeId);
  if (!destination?.members.includes(holeKey(target.boardId, target.holeId)))
    throw Error('The chosen hole is not on the required LED anode net.');
  if (
    input.associations.some(
      (a) =>
        a.state !== 'rejected' &&
        a.target?.kind === 'hole' &&
        a.target.boardId === target.boardId &&
        a.target.holeId === target.holeId,
    )
  )
    throw Error(
      'The selected destination is occupied or has an unresolved insertion proposal. Review it before giving exact-hole guidance.',
    );
  const board = input.boards.find((b) => b.id === target.boardId);
  if (!board || !confirmed(board.topologyState))
    throw Error('Confirm target topology.');
  const hole = allHoles(
    board.calibration as Calibration,
    board.rails as Rail[],
  ).find((h) => h.id === target.holeId);
  if (!hole) throw Error('The destination hole is unregistered.');
  const trial = structuredClone(input),
    association = trial.associations.find((a) => a.id === current.id)!;
  association.target = {
    kind: 'hole',
    ...target,
    calibrationRevision: board.revision,
  };
  const simulated = profileComparison(profile, trial);
  if (simulated.findings[0]?.status !== 'no_fault')
    throw Error(
      'The proposed move does not restore the required relationship.',
    );
  const before = graph,
    after = buildConnectivity(trial),
    membership = (g: ElectricalGraph, t: string) =>
      g.terminals.find((v) => v.id === t)?.nodeId;
  // A repair may join only the expected red-feed nets; all other reference nets remain distinct.
  const representativeNets = new Map<string, string>();
  for (const net of profile.reference.nets) {
    for (const port of net.terminals) {
      const [part, role] = port.split(':') as [
          (typeof demoPartIds)[number],
          string,
        ],
        t = mappedTerminal(trial, profile.mapping, part, role);
      if (!t) throw Error('Reference identity became ambiguous.');
      const n = membership(after, t.id)!;
      const prior = representativeNets.get(n);
      if (prior && prior !== net.id)
        throw Error(
          'The repair would introduce an unexpected reference-net merge.',
        );
      representativeNets.set(n, net.id);
    }
  }
  for (const part of ['D1', 'R1'] as const)
    for (const role of demoRoles[part]) {
      const t = mappedTerminal(input, profile.mapping, part, role)!;
      const oldMembers = before.nodes.find(
        (n) => n.id === membership(before, t.id),
      )!.members;
      const newMembers = after.nodes.find(
        (n) => n.id === membership(after, t.id),
      )!.members;
      if (canonicalHash(oldMembers) !== canonicalHash(newMembers))
        throw Error('The proposed move changes the healthy green branch.');
    }
  const currentHole = current.target;
  const sourceBoard = input.boards.find((b) => b.id === currentHole.boardId)!;
  const sourceHole = allHoles(
    sourceBoard.calibration as Calibration,
    sourceBoard.rails as Rail[],
  ).find(
    (h) =>
      h.id === (current.target?.kind === 'hole' ? current.target.holeId : null),
  )!;
  const core = {
    schemaVersion: 'praxis-repair-instruction-v1' as const,
    sessionId: args.sessionId,
    profileHash: profile.profileHash,
    sourceCaptureId: args.captureId,
    sourceAnalysisId: input.analysisId,
    sourceImageHash: input.imageHash,
    sourceGraphHash: graph.graphHash,
    sourceInputHash: canonicalHash(input),
    sourceRevision: input.revision,
    findingHash: canonicalHash(finding),
    componentId: profile.mapping.J1,
    terminalId: moving,
    anchoredTerminalId: anchored,
    from: { boardId: current.target.boardId, holeId: current.target.holeId },
    to: target,
    fromPosition: project(
      sourceBoard.calibration as Calibration,
      sourceHole.grid,
    ),
    toPosition: project(board.calibration as Calibration, hole.grid),
    sourceEvidenceIds: current.evidence.map((p) => p.id),
    destinationEvidence: {
      reviewer: args.reviewer,
      note: args.note,
      timestamp: args.timestamp,
    },
    text: `Move only J1's LED-side end from ${current.target.boardId}/${current.target.holeId} to ${target.boardId}/${target.holeId}. Keep its R2-side end in place.`,
    createdAt: args.timestamp,
  };
  return repairInstructionSchema.parse({
    ...core,
    repairId: canonicalHash(core),
  });
}
export function verifyCircuitRepair(args: {
  repair: RepairInstruction;
  profile: CircuitProfile;
  captureId: string;
  input: CircuitInput;
  baselineInput: CircuitInput;
  freshReviewed: boolean;
  poseValid: boolean;
}): VerificationResult {
  const { repair, profile, input } = args;
  let status: VerificationResult['status'] = 'unable_to_verify',
    reason =
      'A fresh, registered capture with newly reviewed J1 observations is required.';
  let graphHash: string | null = null;
  if (
    args.captureId !== repair.sourceCaptureId &&
    input.analysisId !== repair.sourceAnalysisId &&
    input.imageHash !== repair.sourceImageHash &&
    args.poseValid &&
    args.freshReviewed &&
    profile.profileHash === repair.profileHash &&
    canonicalHash(args.baselineInput) === repair.sourceInputHash &&
    profile.qualification !== 'draft'
  ) {
    const graph = buildConnectivity(input);
    graphHash = graph.graphHash;
    const moving = input.associations.find(
        (a) =>
          a.terminalId === repair.terminalId &&
          confirmed(a.state) &&
          a.target?.kind === 'hole',
      ),
      fixed = input.associations.find(
        (a) => a.terminalId === repair.anchoredTerminalId && confirmed(a.state),
      ),
      oldFixed = args.baselineInput.associations.find(
        (a) => a.terminalId === repair.anchoredTerminalId && confirmed(a.state),
      );
    if (
      moving &&
      fixed &&
      oldFixed &&
      canonicalHash(fixed.target) === canonicalHash(oldFixed.target)
    ) {
      const compare = profileComparison(profile, input);
      if (compare.findings[0]?.status === 'no_fault') {
        try {
          validateProfileWiring(input, profile.mapping, profile.reference);
          status = 'resolved';
        } catch {
          status = 'unable_to_verify';
        }
        reason =
          status === 'resolved'
            ? 'Fresh capture review supports the unchanged anchor and restored R2-to-D2 connection. This is not electrical-operation or LED-on verification.'
            : 'The target path exists, but other reference nets, identities or contacts changed. Review the complete circuit.';
      } else {
        status = 'not_resolved';
        reason =
          'The freshly reviewed jumper still does not establish the required connection.';
      }
    } else
      reason =
        'One or both J1 insertions are unresolved, or the supposedly unchanged anchor moved.';
  }
  const core = {
    repairId: repair.repairId,
    captureId: args.captureId,
    analysisId: input.analysisId,
    imageHash: input.imageHash,
    profileHash: profile.profileHash,
    graphHash,
    status,
    reason,
    verificationBasis:
      status === 'unable_to_verify'
        ? ('insufficient_fresh_evidence' as const)
        : ('fresh_capture_manual_review' as const),
    electricalOperationVerified: false as const,
    createdAt: Date.now(),
  };
  return { ...core, verificationId: canonicalHash(core) };
}
