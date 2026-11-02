import { calibrateBoard } from '../../src/shared/calibration.js';
import type {
  CircuitInput,
  CircuitReference,
  CircuitProof,
} from '../../src/schemas/connectivity.js';

/** Logical schematic and invented board placements solely for deterministic tests.
 * No physical transistor package, photograph, pin order or measured circuit is asserted. */
export function syntheticNightLight(misplaced = false) {
  const proof: CircuitProof = {
    id: 'synthetic-evidence',
    source: 'synthetic_fixture',
    reviewer: 'synthetic_fixture',
    note: 'SYNTHETIC simulated confirmations. No photographic validation or physical transistor pinout.',
    timestamp: 0,
  };
  const input: CircuitInput = {
    schemaVersion: 'praxis-connectivity-input-v1',
    analysisId: 'f7000000-0000-4000-a000-000000000001',
    imageHash: 'a'.repeat(64),
    revision: 1,
    validationScope: 'synthetic_fixture',
    coverage: { state: 'confirmed_manual', evidence: [proof] },
    boards: [
      {
        id: 'board_1',
        revision: 1,
        calibration: calibrateBoard(
          'board_1',
          30,
          { width: 640, height: 900 },
          [
            { x: 100, y: 100 },
            { x: 430, y: 100 },
            { x: 430, y: 760 },
            { x: 100, y: 760 },
          ],
        ),
        rails: [
          {
            id: 'R1',
            label: 'positive',
            count: 25,
            layout: 'uniform',
            first: { x: -2, y: 0 },
            last: { x: -2, y: 24 },
            connectivity: 'continuous',
            splitAfter: null,
          },
          {
            id: 'R2',
            label: 'negative',
            count: 25,
            layout: 'uniform',
            first: { x: 13, y: 0 },
            last: { x: 13, y: 24 },
            connectivity: 'split',
            splitAfter: 12,
          },
        ],
        topologyState: 'confirmed_manual',
        evidence: [proof],
      },
    ],
    components: [],
    terminals: [],
    associations: [],
  };
  const specs: [string, string, string[]][] = [
    ['supply', 'power_source', ['positive', 'negative']],
    ['led', 'led', ['anode', 'cathode']],
    ['r_led', 'resistor', ['terminal1', 'terminal2']],
    ['ldr', 'ldr', ['terminal1', 'terminal2']],
    ['r_bias', 'resistor', ['terminal1', 'terminal2']],
    ['r_base', 'resistor', ['terminal1', 'terminal2']],
    ['q', 'npn_transistor', ['base', 'collector', 'emitter']],
    ['jumper', 'jumper_wire', ['a', 'b']],
  ];
  const mapping: Record<string, string> = {};
  for (const [id, type, roles] of specs) {
    mapping[id] = id;
    input.components.push({
      id,
      type,
      label: `Synthetic ${id}`,
      objectRef: { kind: 'manual', id },
      bbox: null,
      terminalIds: roles.map((r) => `${id}:${r}`),
      state: 'confirmed_manual',
      continuity: type === 'jumper_wire' ? 'confirmed_manual' : 'unresolved',
      evidence: [proof],
    });
    for (const role of roles)
      input.terminals.push({
        id: `${id}:${role}`,
        componentId: id,
        label: role,
        role,
        roleState: 'confirmed_manual',
        position: null,
        evidence: [proof],
      });
  }
  const placements: Record<string, string> = {
    'supply:positive': 'R1:1',
    'supply:negative': 'R2:1',
    'led:anode': 'a10',
    'led:cathode': 'a12',
    'r_led:terminal1': 'R1:2',
    'r_led:terminal2': 'b10',
    'ldr:terminal1': 'a18',
    'ldr:terminal2': 'R2:2',
    'r_bias:terminal1': 'R1:3',
    'r_bias:terminal2': 'b18',
    'r_base:terminal1': 'c18',
    'r_base:terminal2': 'a20',
    'q:base': 'b20',
    'q:collector': 'f12',
    'q:emitter': 'R2:3',
    'jumper:a': 'b12',
    'jumper:b': misplaced ? 'g13' : 'g12',
  };
  for (const [terminalId, holeId] of Object.entries(placements))
    input.associations.push({
      id: `insert:${terminalId}`,
      terminalId,
      target: {
        kind: 'hole',
        boardId: 'board_1',
        holeId,
        calibrationRevision: 1,
      },
      type: 'insertion',
      state: 'confirmed_manual',
      evidence: [proof],
      originalProposalRef: null,
    });
  const reference: CircuitReference = {
    schemaVersion: 'praxis-reference-circuit-v1',
    id: 'synthetic-night-light',
    version: 1,
    name: 'SYNTHETIC night-light logical netlist; no physical pinout',
    qualification: 'synthetic_fixture',
    schematicSource:
      'Manually authored abstract fixture for deterministic graph tests, not the intended physical demonstration schematic.',
    reviewer: 'synthetic_fixture',
    components: specs.map(([id, type, terminalRoles]) => ({
      id,
      type,
      terminalRoles,
      value: null,
      partNumber: null,
      package: null,
      pinoutSource:
        type === 'npn_transistor'
          ? 'Abstract named ports only; no package orientation or physical lead order'
          : null,
    })),
    nets: [
      {
        id: 'vcc',
        terminals: ['supply:positive', 'r_led:terminal1', 'r_bias:terminal1'],
      },
      {
        id: 'ground',
        terminals: ['supply:negative', 'q:emitter', 'ldr:terminal2'],
      },
      { id: 'led-feed', terminals: ['r_led:terminal2', 'led:anode'] },
      {
        id: 'collector',
        terminals: ['led:cathode', 'jumper:a', 'jumper:b', 'q:collector'],
      },
      {
        id: 'sense',
        terminals: ['r_bias:terminal2', 'ldr:terminal1', 'r_base:terminal1'],
      },
      { id: 'base', terminals: ['r_base:terminal2', 'q:base'] },
    ],
    rules: [
      {
        id: 'led-collector-path',
        kind: 'required_conductive_path',
        from: 'led:cathode',
        to: 'q:collector',
        jumper: 'jumper',
      },
    ],
  };
  return { input, reference, mapping };
}
