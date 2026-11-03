import { syntheticNightLight } from './night-light.js';
import {
  demoRoles,
  demoTypes,
  twoLedReference,
} from '../../src/services/circuit-demo.js';
import { canonicalHash } from '../../src/lib/canonical-json.js';
import {
  demoPartIds,
  circuitProfileSchema,
} from '../../src/schemas/circuit-session.js';
import type { CircuitInput } from '../../src/schemas/connectivity.js';
/** Invented component/contact placements for engine tests only. Never used as camera observations. */
export function syntheticTwoLed(fault = false) {
  const base = syntheticNightLight().input,
    proof = base.coverage.evidence[0]!,
    input: CircuitInput = {
      ...base,
      components: [],
      terminals: [],
      associations: [],
    },
    mapping = Object.fromEntries(demoPartIds.map((id) => [id, id])) as Record<
      (typeof demoPartIds)[number],
      string
    >;
  const positions: Record<string, string> = {
    'P1:positive': 'a1',
    'P1:negative': 'a2',
    'R1:terminal1': 'b1',
    'R1:terminal2': 'a3',
    'D1:anode': 'b3',
    'D1:cathode': 'b2',
    'S1:contactA': 'c1',
    'S1:contactB': 'a4',
    'R2:terminal1': 'b4',
    'R2:terminal2': 'a5',
    'J1:a': 'b5',
    'J1:b': fault ? 'a7' : 'a6',
    'D2:anode': 'b6',
    'D2:cathode': 'c2',
  };
  for (const id of demoPartIds) {
    input.components.push({
      id,
      label: id,
      type: demoTypes[id],
      objectRef: { kind: 'manual', id },
      bbox: null,
      terminalIds: demoRoles[id].map((role) => `${id}:${role}`),
      state: 'confirmed_manual',
      continuity: id === 'J1' ? 'confirmed_manual' : 'unresolved',
      evidence: [proof],
      ...(id === 'S1'
        ? { switchState: 'open', switchStateEvidence: [proof] }
        : {}),
    });
    for (const role of demoRoles[id]) {
      const tid = `${id}:${role}`;
      input.terminals.push({
        id: tid,
        componentId: id,
        label: role,
        role,
        roleState: 'confirmed_manual',
        position: null,
        evidence: [proof],
      });
      input.associations.push({
        id: `insert:${tid}`,
        terminalId: tid,
        target: {
          kind: 'hole',
          boardId: 'board_1',
          holeId: positions[tid]!,
          calibrationRevision: 1,
        },
        type: 'insertion',
        state: 'confirmed_manual',
        evidence: [proof],
        originalProposalRef: null,
      });
    }
  }
  const parts = {
    supplyVolts: 5,
    r1Ohms: 1000,
    r2Ohms: 1000,
    ledSource: 'SYNTHETIC verified roles',
    switchPart: 'SYNTHETIC two-port switch',
    switchContacts: 'SYNTHETIC reviewed contactA and contactB',
    schematicSource: 'SYNTHETIC two-LED fixture; no real physical rig.',
  };
  const core = {
    schemaVersion: 'praxis-circuit-profile-v1',
    sessionId: 'f7000000-0000-4000-a000-000000000002',
    createdAt: 0,
    name: 'Synthetic two-LED button fixture',
    qualification: 'synthetic_fixture',
    validationScope: 'synthetic_fixture',
    sourceAnalysisId: input.analysisId,
    sourceInputHash: canonicalHash(input),
    sourcePerceptionHash: 'b'.repeat(64),
    sourceGraphHash: 'c'.repeat(64),
    reviewer: 'synthetic_fixture',
    reason: 'SYNTHETIC engine test, no physical image validation.',
    parts,
    mapping,
    reference: twoLedReference(parts, 'synthetic_fixture', 'synthetic_fixture'),
    input: structuredClone(input),
    anchoredTerminalId: 'J1:a',
    movingTerminalId: 'J1:b',
    requiredFromTerminalId: 'R2:terminal2',
    requiredToTerminalId: 'D2:anode',
    poseAnchors: [
      { x: 50, y: 50 },
      { x: 590, y: 50 },
      { x: 590, y: 850 },
      { x: 50, y: 850 },
    ],
    posePolicy: 'fixed-camera-patches-v1',
  };
  return {
    input,
    profile: circuitProfileSchema.parse({
      ...core,
      profileHash: canonicalHash(core),
    }),
  };
}
