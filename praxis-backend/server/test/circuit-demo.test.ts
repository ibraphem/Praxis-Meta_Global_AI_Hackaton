import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { syntheticTwoLed } from './fixtures/two-led.js';
import { buildConnectivity } from '../src/services/connectivity.js';
import {
  validateProfileWiring,
  profileComparison,
  planCircuitRepair,
  verifyCircuitRepair,
  connectionProjection,
} from '../src/services/circuit-demo.js';
import { checkFixedCamera } from '../src/shared/fixed-camera.js';
const plan = () => {
  const { input, profile } = syntheticTwoLed(true);
  return {
    input,
    profile,
    repair: planCircuitRepair({
      sessionId: randomUUID(),
      captureId: randomUUID(),
      profile,
      input,
      target: { boardId: 'board_1', holeId: 'c6' },
      reviewer: 'synthetic_fixture',
      note: 'Synthetic destination explicitly reviewed as empty.',
      timestamp: 0,
    }),
  };
};
test('two-LED reference accepts released button without shorting its device ports', () => {
  const { input, profile } = syntheticTwoLed();
  for (const state of ['open', 'unknown', 'closed'] as const) {
    input.components.find((c) => c.id === 'S1')!.switchState = state;
    const graph = validateProfileWiring(
      input,
      profile.mapping,
      profile.reference,
    );
    assert.notEqual(
      graph.terminals.find((t) => t.id === 'S1:contactA')!.nodeId,
      graph.terminals.find((t) => t.id === 'S1:contactB')!.nodeId,
    );
    assert.equal(
      profileComparison(profile, input).findings[0]!.status,
      'no_fault',
    );
    assert.equal(
      graph.devices.find((d) => d.componentId === 'S1')!.switchState,
      state,
    );
  }
});
test('both wrong strips yield scoped faults and a simulated safe single-end repair', () => {
  for (const wrong of ['a7', 'a8']) {
    const { input, profile } = syntheticTwoLed(true);
    input.associations.find((a) => a.terminalId === 'J1:b')!.target = {
      kind: 'hole',
      boardId: 'board_1',
      holeId: wrong,
      calibrationRevision: 1,
    };
    assert.equal(
      profileComparison(profile, input).findings[0]!.status,
      'confirmed_fault',
    );
    const repair = planCircuitRepair({
      sessionId: randomUUID(),
      captureId: randomUUID(),
      profile,
      input,
      target: { boardId: 'board_1', holeId: 'c6' },
      reviewer: 'synthetic_fixture',
      note: 'Explicit synthetic available destination.',
      timestamp: 0,
    });
    assert.equal(repair.from.holeId, wrong);
    assert.equal(repair.to.holeId, 'c6');
    assert.equal(repair.terminalId, 'J1:b');
    assert.equal(
      input.associations.find((a) => a.terminalId === 'J1:b')!.target!.kind,
      'hole',
    );
  }
});
test('planner rejects draft, unknown destination, occupied hole, wrong net and wrong anchor', () => {
  for (const mode of ['draft', 'unknown', 'occupied', 'wrong-net', 'anchor']) {
    const { input, profile } = syntheticTwoLed(true);
    if (mode === 'draft') profile.qualification = 'draft';
    if (mode === 'anchor')
      input.associations.find((a) => a.terminalId === 'J1:a')!.target = {
        kind: 'hole',
        boardId: 'board_1',
        holeId: 'c8',
        calibrationRevision: 1,
      };
    assert.throws(() =>
      planCircuitRepair({
        sessionId: randomUUID(),
        captureId: randomUUID(),
        profile,
        input,
        target: {
          boardId: 'board_1',
          holeId:
            mode === 'unknown'
              ? 'c999'
              : mode === 'occupied'
                ? 'b6'
                : mode === 'wrong-net'
                  ? 'd2'
                  : 'c6',
        },
        reviewer: 'synthetic_fixture',
        note: 'Synthetic destination evidence.',
        timestamp: 0,
      }),
    );
  }
});
test('verification needs a different photo and current baseline, and rejects hidden/moved/unexpected evidence', () => {
  const { repair, input, profile } = plan(),
    fresh = syntheticTwoLed().input;
  fresh.analysisId = randomUUID();
  fresh.imageHash = 'd'.repeat(64);
  const args = {
    repair,
    profile,
    captureId: randomUUID(),
    input: fresh,
    baselineInput: input,
    freshReviewed: true,
    poseValid: true,
  };
  assert.equal(verifyCircuitRepair(args).status, 'resolved');
  assert.equal(verifyCircuitRepair(args).electricalOperationVerified, false);
  for (const variant of [
    'old',
    'pose',
    'review',
    'hidden',
    'anchor',
    'stale',
    'short',
  ]) {
    const a = structuredClone(args);
    if (variant === 'old') a.input.imageHash = repair.sourceImageHash;
    if (variant === 'pose') a.poseValid = false;
    if (variant === 'review') a.freshReviewed = false;
    if (variant === 'hidden')
      a.input.associations.find((v) => v.terminalId === 'J1:b')!.state =
        'unresolved';
    if (variant === 'anchor')
      a.input.associations.find((v) => v.terminalId === 'J1:a')!.target = {
        kind: 'hole',
        boardId: 'board_1',
        holeId: 'd8',
        calibrationRevision: 1,
      };
    if (variant === 'stale') a.baselineInput.revision++;
    if (variant === 'short')
      a.input.associations.find((v) => v.terminalId === 'D1:cathode')!.target =
        {
          kind: 'hole',
          boardId: 'board_1',
          holeId: 'e1',
          calibrationRevision: 1,
        };
    assert.equal(verifyCircuitRepair(a).status, 'unable_to_verify', variant);
  }
  const wrong = structuredClone(args);
  wrong.input.associations.find((v) => v.terminalId === 'J1:b')!.target = {
    kind: 'hole',
    boardId: 'board_1',
    holeId: 'c8',
    calibrationRevision: 1,
  };
  assert.equal(verifyCircuitRepair(wrong).status, 'not_resolved');
});
test('connection view preserves J1 edge while the final netlist unions its two ports', () => {
  const graph = buildConnectivity(syntheticTwoLed().input),
    v = connectionProjection(graph),
    j = v.wires.find((w) => w.id === 'J1')!;
  assert.notEqual(j.from, j.to);
  assert.ok(
    v.netlist.some(
      (n) => n.terminals.includes('J1:a') && n.terminals.includes('J1:b'),
    ),
  );
  assert.equal(v.devices.find((d) => d.id === 'S1')!.ports.length, 2);
});
test('fixed-camera policy rejects flat/repeated landmarks, changed view and altered dimensions', () => {
  let seed = 42;
  const data = Uint8Array.from({ length: 220 * 220 * 3 }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % 256;
    }),
    f = { width: 220, height: 220, data },
    anchors = [
      { x: 40, y: 40 },
      { x: 180, y: 40 },
      { x: 40, y: 180 },
      { x: 180, y: 180 },
    ];
  assert.equal(checkFixedCamera(f, f, anchors).valid, true);
  assert.equal(checkFixedCamera(f, { ...f, width: 221 }, anchors).valid, false);
  const flat = { ...f, data: new Uint8Array(data.length) };
  assert.equal(checkFixedCamera(flat, flat, anchors).valid, false);
  assert.equal(checkFixedCamera(f, flat, anchors).valid, false);
  const repeated = {
    ...f,
    data: Uint8Array.from(data, (_, i) => (Math.floor(i / 3) % 2 ? 255 : 0)),
  };
  assert.equal(checkFixedCamera(repeated, repeated, anchors).valid, false);
});
test('verified switch leg aliases conduct within one contact while the open A/B device remains separate', () => {
  const { input, profile } = syntheticTwoLed(),
    c = input.components.find((c) => c.id === 'S1')!,
    proof = c.evidence[0]!;
  c.terminalIds.push('S1:leg:3');
  input.terminals.push({
    id: 'S1:leg:3',
    componentId: 'S1',
    label: 'Synthetic physical leg 3',
    role: null,
    roleState: 'unresolved',
    position: null,
    evidence: [proof],
  });
  c.contactAliases = [
    {
      terminalId: 'S1:leg:3',
      contactTerminalId: 'S1:contactA',
      state: 'confirmed_manual',
      evidence: [proof],
    },
  ];
  assert.throws(
    () => validateProfileWiring(input, profile.mapping, profile.reference),
    /all physical/,
  );
  input.associations.push({
    id: 'insert:S1:leg:3',
    terminalId: 'S1:leg:3',
    target: {
      kind: 'hole',
      boardId: 'board_1',
      holeId: 'a10',
      calibrationRevision: 1,
    },
    type: 'insertion',
    state: 'confirmed_manual',
    evidence: [proof],
    originalProposalRef: null,
  });
  const graph = validateProfileWiring(
    input,
    profile.mapping,
    profile.reference,
  );
  assert.equal(
    graph.terminals.find((t) => t.id === 'S1:leg:3')!.nodeId,
    graph.terminals.find((t) => t.id === 'S1:contactA')!.nodeId,
  );
  assert.notEqual(
    graph.terminals.find((t) => t.id === 'S1:contactB')!.nodeId,
    graph.terminals.find((t) => t.id === 'S1:contactA')!.nodeId,
  );
  assert.equal(
    graph.devices.find((d) => d.componentId === 'S1')!.terminals.length,
    2,
  );
  c.contactAliases[0]!.state = 'unresolved';
  assert.equal(buildConnectivity(input).conductiveCompleteness, false);
});
test('junction pixel checks pause guidance after a small local insertion change even when fixed landmarks match', async () => {
  const { junctionRegionsUnchanged } =
      await import('../src/shared/fixed-camera.js'),
    data = new Uint8Array(100 * 100 * 3),
    f = { width: 100, height: 100, data },
    points = [
      { x: 20, y: 20 },
      { x: 70, y: 70 },
    ];
  assert.equal(junctionRegionsUnchanged(f, f, points), true);
  const changed = { ...f, data: new Uint8Array(data) };
  for (let y = 18; y <= 22; y++)
    for (let x = 18; x <= 22; x++)
      changed.data.fill(255, (y * 100 + x) * 3, (y * 100 + x) * 3 + 3);
  assert.equal(junctionRegionsUnchanged(f, changed, points), false);
  assert.equal(junctionRegionsUnchanged(f, f, [points[0]!]), false);
});
