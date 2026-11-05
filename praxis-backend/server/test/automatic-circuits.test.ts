import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AutomaticCircuitService } from '../src/jobs/automatic-circuits.js';
import { JobStore } from '../src/jobs/store.js';
import { fitObservedBoard } from '../src/services/automatic-calibration.js';
import {
  calibrateBoard,
  project,
  terminalHoles,
} from '../src/shared/calibration.js';
import type { MetaClient } from '../src/lib/meta-client.js';
import { buildApp } from '../src/app.js';
import {
  completion,
  samEnvelope,
  imageBytes,
  multipartBody,
  testConfig,
} from './helpers.js';
import type { CircuitInspection } from '../src/shared/automatic-circuit.js';
import type { MeasuredGeometry } from '../src/shared/hybrid-geometry.js';
import { inferAutomaticDiagnosis } from '../src/services/automatic-diagnosis.js';
import { prepareImage } from '../src/services/image.js';
import type { CircuitInput } from '../src/schemas/connectivity.js';

const image = { width: 640, height: 960 };
function measuredGeometry(): MeasuredGeometry {
  const calibration = calibrateBoard('board_1', 30, image, [
    { x: 100, y: 100 },
    { x: 430, y: 100 },
    { x: 430, y: 900 },
    { x: 100, y: 900 },
  ]);
  return {
    version: 'opencv-lattice-v1',
    image,
    processing: image,
    status: 'measured',
    reason: 'Synthetic measured grid',
    holeCount: 300,
    fit: {
      rows: 30,
      observedRows: 30,
      anchors: calibration.anchors,
      holes: terminalHoles(calibration).map((h) => ({
        ...project(calibration, h.grid),
        column: 'abcdefghij'.indexOf(h.id[0]!),
        row: Number(h.id.slice(1)) - 1,
      })),
      pitch: 30,
      rmsPitch: 0,
      inlierRatio: 1,
    },
  };
}
function semanticClient() {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      async post(path: string, body: Record<string, unknown>) {
        calls++;
        if (path === 'responses') return samEnvelope('<0f>');
        const prompt = JSON.stringify(body.messages);
        assert.ok(
          prompt.includes('Do not predict hole centres or terminal positions'),
        );
        return completion({
          numbering: {
            firstPrintedRow: 1,
            rowDirection: 'forward',
            columnDirection: 'forward',
            note: 'Readable labels',
          },
          components: [
            {
              label: 'Observed conductor',
              type: 'jumper_wire',
              bbox: [100, 150, 600, 500],
              wireMaskId: null,
            },
          ],
          warnings: [],
        });
      },
    } as MetaClient,
  };
}
test('hybrid geometry replaces model coordinates and local proposals remain unconfirmed until review', async () => {
  const store = new JobStore(testConfig(), ':memory:'),
    fake = semanticClient(),
    service = new AutomaticCircuitService(store, fake.client);
  try {
    const bytes = await imageBytes(640, 960),
      initial = await service.create(bytes, {
        sourceHash: createHash('sha256').update(bytes).digest('hex'),
        geometry: measuredGeometry(),
      }),
      v = await done(service, initial.id);
    assert.equal(v.status, 'needs_review');
    assert.equal(v.requestCount, 2);
    assert.equal(fake.calls(), 2);
    assert.equal(v.hybrid!.geometry.fit!.holes.length, 300);
    assert.ok(v.input!.terminals.every((t) => t.position === null));
    const endpoints = v.input!.terminals.map((t, i) => ({
      terminalId: t.id,
      componentId: t.componentId,
      position: fixture().pixel(i ? 'f5' : 'a5'),
      basis: 'mask_endpoint',
      status: 'supported',
      reason: 'Measured synthetic mask',
      candidates: [],
    }));
    const localized = service.localize(v.id, {
      expectedRevision: v.revision,
      imageHash: v.imageHash,
      endpoints,
    });
    assert.equal(localized.hybrid!.localStatus, 'ready');
    assert.deepEqual(
      localized
        .input!.associations.map((a) =>
          a.target?.kind === 'hole' ? a.target.holeId : null,
        )
        .sort(),
      ['a5', 'f5'],
    );
    assert.ok(
      localized.input!.associations.every((a) => a.state === 'unresolved'),
    );
    assert.equal(fake.calls(), 2);
    assert.throws(
      () =>
        service.localize(v.id, {
          expectedRevision: v.revision,
          imageHash: v.imageHash,
          endpoints,
        }),
      /changed/,
    );
    const confirmed = service.review(v.id, reviewed(localized));
    assert.equal(confirmed.graph!.wires[0]!.confirmed, true);
    assert.throws(()=>service.localize(v.id,{expectedRevision:confirmed.revision,imageHash:v.imageHash,endpoints}),/saved human review/);
    assert.equal(fake.calls(), 2);
  } finally {
    await service.close();
    store.close();
  }
});
test('local endpoint evidence separates a board insertion from an external wire end', async () => {
  const store = new JobStore(testConfig(), ':memory:'),
    fake = semanticClient(),
    service = new AutomaticCircuitService(store, fake.client);
  try {
    const bytes = await imageBytes(640, 960),
      initial = await service.create(bytes, {
        sourceHash: createHash('sha256').update(bytes).digest('hex'),
        geometry: measuredGeometry(),
      }),
      v = await done(service, initial.id),
      component = v.input!.components.find((c) => c.type === 'jumper_wire')!,
      localized = service.localize(v.id, {
        expectedRevision: v.revision,
        imageHash: v.imageHash,
        endpoints: [
          {
            terminalId: component.terminalIds[0],
            componentId: component.id,
            position: fixture().pixel('a5'),
            basis: 'mask_endpoint',
            status: 'supported',
            reason: 'Measured mask endpoint',
            candidates: [],
          },
          {
            terminalId: component.terminalIds[1],
            componentId: component.id,
            position: { x: 20, y: 20 },
            basis: 'external_connector',
            status: 'external',
            reason: 'Visible wire end outside the board',
            candidates: [],
          },
        ],
      });
    assert.equal(localized.hybrid!.localStatus, 'ready');
    assert.equal(
      localized.hybrid!.endpoints.find((e) => e.status === 'external')!
        .candidates.length,
      0,
    );
    assert.equal(
      localized.input!.associations.filter((a) => a.target).length,
      1,
    );
    assert.equal(
      localized.input!.associations.find(
        (a) => a.terminalId === component.terminalIds[0],
      )!.target!.kind,
      'hole',
    );
  } finally {
    await service.close();
    store.close();
  }
});
test('intent inference can name terminals but only server geometry chooses a safe empty repair hole', async () => {
  const config = testConfig(),
    calibration = calibrateBoard('board_1', 30, image, [
      { x: 100, y: 100 },
      { x: 430, y: 100 },
      { x: 430, y: 900 },
      { x: 100, y: 900 },
    ]),
    proof = {
      id: 'review_1',
      source: 'human_review' as const,
      reviewer: 'Test reviewer',
      note: 'Reviewed synthetic diagnosis fixture.',
      timestamp: 1,
    },
    input: CircuitInput = {
      schemaVersion: 'praxis-connectivity-input-v1',
      analysisId: '11111111-1111-4111-8111-111111111111',
      imageHash: 'a'.repeat(64),
      revision: 1,
      validationScope: 'photograph',
      coverage: { state: 'unresolved', evidence: [] },
      boards: [
        {
          id: 'board_1',
          revision: 1,
          calibration,
          rails: [],
          topologyState: 'confirmed_manual',
          evidence: [proof],
        },
      ],
      components: [
        {
          id: 'red_wire',
          label: 'red battery lead',
          type: 'jumper_wire',
          objectRef: { kind: 'manual', id: 'red_wire' },
          bbox: null,
          terminalIds: ['red_board', 'red_external'],
          state: 'confirmed_manual',
          continuity: 'unresolved',
          evidence: [proof],
        },
        {
          id: 'resistor',
          label: 'series resistor',
          type: 'resistor',
          objectRef: { kind: 'manual', id: 'resistor' },
          bbox: null,
          terminalIds: ['resistor_left', 'resistor_right'],
          state: 'confirmed_manual',
          continuity: 'unresolved',
          evidence: [proof],
        },
      ],
      terminals: [
        ['red_board', 'red_wire'],
        ['red_external', 'red_wire'],
        ['resistor_left', 'resistor'],
        ['resistor_right', 'resistor'],
      ].map(([id, componentId]) => ({
        id: id!,
        componentId: componentId!,
        label: id!,
        role: null,
        roleState: 'unresolved' as const,
        position: null,
        evidence: [proof],
      })),
      associations: [
        ['red_board', 'a9'],
        ['resistor_left', 'e7'],
        ['resistor_right', 'f7'],
      ].map(([terminalId, holeId]) => ({
        id: `association_${terminalId}`,
        terminalId: terminalId!,
        target: {
          kind: 'hole' as const,
          boardId: 'board_1',
          holeId: holeId!,
          calibrationRevision: 1,
        },
        type: 'insertion' as const,
        state: 'confirmed_manual' as const,
        evidence: [proof],
        originalProposalRef: terminalId!,
      })),
    },
    prepared = await prepareImage(await imageBytes(640, 960), config),
    response: Record<string, unknown> = {
      outcome: 'repair_candidate',
      intendedBehavior: 'Feed the series resistor from the battery lead.',
      confidence: 'high',
      assumptions: ['The labelled red lead is the intended positive feed.'],
      relationships: [
        {
          fromTerminalId: 'red_board',
          toTerminalId: 'resistor_left',
          reason: 'The source must feed the resistor input.',
        },
      ],
      repair: {
        movableTerminalId: 'red_board',
        targetTerminalId: 'resistor_left',
        reason: 'The lead is two rows below the resistor input net.',
      },
      explanation: 'One lead is on the wrong terminal strip.',
    },
    client = {
      async post() {
        return completion(response);
      },
    } as MetaClient;
  const diagnosis = await inferAutomaticDiagnosis({
    config,
    client,
    image: prepared,
    input,
    sourceRevision: 1,
    sourceImageHash: input.imageHash,
    requestedGoal: '',
    verificationOf: null,
    signal: new AbortController().signal,
  });
  assert.equal(diagnosis.status, 'repair_ready');
  assert.equal(diagnosis.repair!.from.holeId, 'a9');
  assert.equal(diagnosis.repair!.to.holeId, 'a7');
  assert.match(diagnosis.repair!.instruction, /Move the red battery lead/);

  response.repair = {
    movableTerminalId: 'resistor_left',
    targetTerminalId: 'red_board',
    reason: 'Move the visible resistor lead onto the source terminal strip.',
  };
  const discreteLead = await inferAutomaticDiagnosis({
    config,
    client,
    image: prepared,
    input,
    sourceRevision: 1,
    sourceImageHash: input.imageHash,
    requestedGoal: '',
    verificationOf: null,
    signal: new AbortController().signal,
  });
  assert.equal(discreteLead.status, 'repair_ready');
  assert.equal(discreteLead.repair!.from.holeId, 'e7');
  assert.equal(discreteLead.repair!.to.holeId, 'e9');
  assert.match(discreteLead.repair!.instruction, /series resistor/);

  response.repair = {
    movableTerminalId: 'red_external',
    targetTerminalId: 'resistor_left',
    reason: 'The external end has no reviewed board insertion.',
  };
  const rejected = await inferAutomaticDiagnosis({
    config,
    client,
    image: prepared,
    input,
    sourceRevision: 1,
    sourceImageHash: input.imageHash,
    requestedGoal: '',
    verificationOf: null,
    signal: new AbortController().signal,
  });
  assert.equal(rejected.status, 'no_safe_repair');
  assert.equal(rejected.repair, null);

  const fixed = structuredClone(input),
    fixedAssociation = fixed.associations.find(
      (association) => association.terminalId === 'red_board',
    )!;
  fixedAssociation.target = {
    kind: 'hole',
    boardId: 'board_1',
    holeId: 'a7',
    calibrationRevision: 1,
  };
  response.outcome = 'no_fault';
  response.repair = null;
  response.explanation = 'The fresh capture now satisfies the intended feed.';
  const verified = await inferAutomaticDiagnosis({
    config,
    client,
    image: prepared,
    input: fixed,
    sourceRevision: 2,
    sourceImageHash: fixed.imageHash,
    requestedGoal: 'Feed the resistor from the battery lead.',
    verificationOf: '22222222-2222-4222-8222-222222222222',
    signal: new AbortController().signal,
  });
  assert.equal(verified.status, 'no_fault');
  assert.equal(verified.verificationOf, '22222222-2222-4222-8222-222222222222');
  assert.equal(verified.relationships[0]!.satisfied, true);
});
test('foreign or inconsistent browser geometry is rejected before provider dispatch', async () => {
  const store = new JobStore(testConfig(), ':memory:'),
    fake = semanticClient(),
    service = new AutomaticCircuitService(store, fake.client);
  try {
    const bytes = await imageBytes(640, 960),
      geometry = measuredGeometry(),
      sourceHash = createHash('sha256').update(bytes).digest('hex');
    await assert.rejects(
      service.create(bytes, { sourceHash: 'b'.repeat(64), geometry }),
      /match the uploaded/,
    );
    geometry.fit!.holes[0]!.x += 100;
    await assert.rejects(
      service.create(bytes, { sourceHash, geometry }),
      /disagree/,
    );
    assert.equal(fake.calls(), 0);
  } finally {
    await service.close();
    store.close();
  }
});
function fixture(rotated = false, rows: 30 | 63 = 30) {
  const calibration = calibrateBoard(
    'board_1',
    rows,
    image,
    rotated
      ? [
          { x: 490, y: 900 },
          { x: 160, y: 900 },
          { x: 160, y: 100 },
          { x: 490, y: 100 },
        ]
      : [
          { x: 100, y: 100 },
          { x: 430, y: 100 },
          { x: 430, y: 900 },
          { x: 100, y: 900 },
        ],
  );
  const pixel = (hole: string) =>
    project(calibration, {
      x:
        'abcdefghij'.indexOf(hole[0]!) < 5
          ? 'abcdefghij'.indexOf(hole[0]!)
          : 'abcdefghij'.indexOf(hole[0]!) + 2,
      y: Number(hole.slice(1)) - 1,
    });
  const landmarks = [
    'a4',
    'j4',
    `a${Math.floor(rows / 2)}`,
    `j${Math.floor(rows / 2)}`,
    `a${rows - 2}`,
    `j${rows - 2}`,
  ].map((hole) => {
    const p = pixel(hole);
    return {
      hole,
      position: [(p.x / 639) * 999, (p.y / 959) * 999] as [number, number],
    };
  });
  return {
    pixel,
    inventory: {
      boards: [
        {
          rows,
          landmarks,
          rails: [],
          note: 'Synthetic labelled holes',
        },
      ],
      components: [
        {
          label: 'Observed conductor',
          type: 'jumper_wire',
          bbox: [60, 60, 800, 700],
        },
        {
          label: 'Unidentified module',
          type: 'power_module',
          bbox: [100, 20, 500, 200],
        },
      ],
      warnings: [],
    },
  };
}
function fakeClient(rotated = false): {
  client: MetaClient;
  calls: () => number;
} {
  const f = fixture(rotated);
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      async post(_path, body, _signal, operation) {
        calls++;
        assert.equal(operation?.timeoutMs, 90000);
        const format = body.response_format as {
          json_schema: { name: string };
        };
        if (format.json_schema.name === 'breadboard_inventory')
          return completion(f.inventory);
        if (format.json_schema.name === 'automatic_circuit_intent')
          return completion({
            outcome: 'needs_intent',
            intendedBehavior: 'Several circuit purposes remain plausible.',
            confidence: 'low',
            assumptions: [],
            relationships: [],
            repair: null,
            explanation: 'Describe the intended behavior before repair.',
          });
        const messages = body.messages as { content: unknown }[];
        const text = (messages[1]!.content as { text?: string }[])[0]!.text!;
        if (text.includes('Unidentified module'))
          return completion({
            terminals: [
              {
                label: 'Covered contact',
                position: [400, 500],
                evidence: 'occluded',
                role: 'positive',
                marking: null,
              },
            ],
            note: 'Contact is covered.',
          });
        const [x, y, w, h] = f.inventory.components[0]!.bbox as [
          number,
          number,
          number,
          number,
        ];
        const pad = 22.4,
          left = Math.max(0, Math.floor((x / 999) * 639 - pad)),
          top = Math.max(0, Math.floor((y / 999) * 959 - pad));
        const width = Math.min(
            640 - left,
            Math.ceil((w / 999) * 640 + 2 * pad),
          ),
          height = Math.min(960 - top, Math.ceil((h / 999) * 960 + 2 * pad));
        return completion({
          terminals: ['a5', 'f5'].map((hole) => {
            const p = f.pixel(hole);
            return {
              label: hole,
              position: [
                ((p.x - left) / (width - 1)) * 999,
                ((p.y - top) / (height - 1)) * 999,
              ],
              evidence: 'visible_insertion',
              role: null,
              marking: null,
            };
          }),
          note: 'Two visible insertions.',
        });
      },
    },
  };
}
async function done(service: AutomaticCircuitService, id: string) {
  for (let n = 0; n < 200; n++) {
    const v = service.get(id);
    if (!['queued', 'running'].includes(v.status)) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Inspection did not finish.');
}
function reviewed(v: CircuitInspection) {
  const input = structuredClone(v.input!);
  input.boards.forEach((b) => (b.topologyState = 'confirmed_manual'));
  input.components.forEach((c) => {
    c.state = 'confirmed_manual';
    c.continuity = 'confirmed_manual';
  });
  input.associations.forEach((a) => {
    if (a.target) a.state = 'confirmed_manual';
  });
  return { expectedRevision: v.revision, reviewer: 'Test reviewer', input };
}

test('automatic grid fit supports different orientations and rejects inconsistent landmarks', () => {
  for (const rows of [30, 63] as const)
    for (const rotated of [false, true]) {
      const f = fixture(rotated, rows),
        b = fitObservedBoard(
          'board_1',
          f.inventory.boards[0] as Parameters<typeof fitObservedBoard>[1],
          image,
        );
      const p = project(b.calibration, { x: 7, y: 4 });
      assert.ok(
        Math.hypot(p.x - f.pixel('f5').x, p.y - f.pixel('f5').y) < 0.01,
      );
      assert.equal(b.calibration.rows, rows);
    }
  const f = fixture();
  f.inventory.boards[0]!.landmarks[2]!.position[0]! += 100;
  assert.throws(
    () =>
      fitObservedBoard(
        'board_1',
        f.inventory.boards[0] as Parameters<typeof fitObservedBoard>[1],
        image,
      ),
    /disagree/,
  );
});

test('AI proposes dynamic parts and exact holes without confirming hidden contacts or roles', async () => {
  const store = new JobStore(testConfig(), ':memory:'),
    fake = fakeClient(),
    service = new AutomaticCircuitService(store, fake.client);
  try {
    const initial = await service.create(await imageBytes(640, 960));
    const reservation = store.db
      .prepare('SELECT lease_until FROM legacy_requests')
      .get();
    assert.ok(
      Number(reservation?.lease_until) >=
        initial.createdAt + store.config.CIRCUIT_INSPECTION_TIMEOUT_MS,
    );
    const v = await done(service, initial.id);
    assert.equal(v.status, 'needs_review');
    assert.equal(v.requestCount, 3);
    assert.equal(v.input!.components.length, 2);
    assert.deepEqual(
      v
        .input!.associations.filter((a) => a.target?.kind === 'hole')
        .map((a) => (a.target as { holeId: string }).holeId)
        .sort(),
      ['a5', 'f5'],
    );
    assert.ok(v.input!.associations.every((a) => a.state === 'unresolved'));
    assert.equal(v.graph, null);
    const hidden = v.input!.terminals.find((t) => t.componentId === 'part_2')!;
    assert.equal(hidden.position, null);
    assert.equal(hidden.role, null);
    for (let n = 0; n < 4; n++) service.get(initial.id);
    assert.equal(fake.calls(), 3);
    const input = reviewed(v);
    const confirmed = service.review(v.id, input);
    assert.equal(confirmed.graph!.wires[0]!.confirmed, true);
    assert.equal(
      confirmed.graph!.devices.find((d) => d.type === 'power_module')!.ports
        .length,
      1,
    );
    assert.equal(
      confirmed.input!.associations.find((a) => a.terminalId === hidden.id)!
        .state,
      'unresolved',
    );
    assert.equal(confirmed.input!.coverage.state, 'unresolved');
    assert.equal(fake.calls(), 3);
    assert.equal(service.evidence(v.id).reviews.length, 1);
    assert.ok(
      service
        .evidence(v.id)
        .originalProposal.input.associations.every(
          (a: { state: string }) => a.state === 'unresolved',
        ),
    );
    assert.throws(() => service.review(v.id, input), /changed/);
  } finally {
    await service.close();
    store.close();
  }
});

test('connection confirmation requires reviewed board and component; automatic claims are downgraded', async () => {
  const store = new JobStore(testConfig(), ':memory:'),
    service = new AutomaticCircuitService(store, fakeClient().client);
  try {
    const initial = await service.create(await imageBytes(640, 960)),
      v = await done(service, initial.id),
      body = reviewed(v);
    body.input.boards[0]!.topologyState = 'unresolved';
    assert.throws(() => service.review(v.id, body), /Confirm the board/);
    body.input.boards[0]!.topologyState = 'confirmed_manual';
    body.input.components[0]!.state = 'unresolved';
    assert.throws(() => service.review(v.id, body), /component identity/);
    body.input.components[0]!.state = 'confirmed_manual';
    const wireAssociation = body.input.associations.find((a) => a.target)!;
    wireAssociation.state = 'confirmed_auto';
    const result = service.review(v.id, body);
    assert.equal(
      result.input!.associations.find((a) => a.id === wireAssociation.id)!
        .state,
      'unresolved',
    );
    assert.equal(result.graph!.wires[0]!.confirmed, false);
  } finally {
    await service.close();
    store.close();
  }
});

test('grid refit preserves edits, resets confirmations, and binds reviews to the saved photo', async () => {
  const store = new JobStore(testConfig(), ':memory:'),
    service = new AutomaticCircuitService(store, fakeClient().client);
  try {
    const initial = await service.create(await imageBytes(640, 960)),
      v = await done(service, initial.id);
    const c = service.review(v.id, reviewed(v));
    const input = structuredClone(c.input!);
    input.components[0]!.label = 'Edited conductor';
    const recalibrated = service.recalibrate(v.id, {
      expectedRevision: c.revision,
      observations: c.observations,
      input,
    });
    assert.equal(recalibrated.input!.components[0]!.label, 'Edited conductor');
    assert.ok(
      recalibrated.input!.associations.every((a) => a.state === 'unresolved'),
    );
    assert.equal(recalibrated.graph, null);
    const wrong = reviewed(recalibrated);
    wrong.input.imageHash = 'b'.repeat(64);
    assert.throws(() => service.review(v.id, wrong), /captured image/);
  } finally {
    await service.close();
    store.close();
  }
});

test('grid refit explains the six-landmark minimum without exposing schema errors', async () => {
  const store = new JobStore(testConfig(), ':memory:'),
    service = new AutomaticCircuitService(store, fakeClient().client);
  try {
    const initial = await service.create(await imageBytes(640, 960)),
      v = await done(service, initial.id),
      observations = structuredClone(v.observations!);
    observations.boards[0]!.landmarks = observations.boards[0]!.landmarks.slice(
      0,
      5,
    );
    assert.throws(
      () =>
        service.recalibrate(v.id, {
          expectedRevision: v.revision,
          observations,
          input: v.input,
        }),
      /Place at least six labelled hole landmarks/,
    );
  } finally {
    await service.close();
    store.close();
  }
});

test('durable inspections survive reopen and interrupted inference is never replayed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-auto-'));
  let store = new JobStore(testConfig(), dir);
  const fake = fakeClient();
  let service = new AutomaticCircuitService(store, fake.client);
  try {
    const initial = await service.create(await imageBytes(640, 960)),
      v = await done(service, initial.id);
    service.review(v.id, reviewed(v));
    await service.close();
    store.close();
    store = new JobStore(testConfig(), dir);
    service = new AutomaticCircuitService(store, fake.client);
    assert.equal(service.get(v.id).status, 'reviewed');
    assert.equal(service.evidence(v.id).reviews.length, 1);
    assert.equal(fake.calls(), 3);
    const record = service.get(v.id);
    record.status = 'running';
    store.db
      .prepare('UPDATE automatic_circuit_inspections SET data=? WHERE id=?')
      .run(JSON.stringify(record), v.id);
    await service.close();
    store.close();
    store = new JobStore(testConfig(), dir);
    service = new AutomaticCircuitService(store, fake.client);
    assert.equal(service.get(v.id).status, 'needs_review');
    assert.match(service.get(v.id).error!, /interrupted/);
    assert.equal(fake.calls(), 3);
  } finally {
    await service.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP upload, polling, image, review and deletion use the existing private API boundary', async () => {
  const config = testConfig({
      PRAXIS_API_TOKEN: 'test-token-that-is-long-enough-123456',
    }),
    store = new JobStore(config, ':memory:'),
    fake = fakeClient();
  const app = await buildApp(config, undefined, undefined, undefined, {
    store,
    experimentClient: fake.client,
  });
  const auth = { authorization: `Bearer ${config.PRAXIS_API_TOKEN}` };
  try {
    const data = multipartBody(await imageBytes(640, 960));
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/circuit-inspections',
          ...data,
        })
      ).statusCode,
      401,
    );
    const upload = await app.inject({
      method: 'POST',
      url: '/api/circuit-inspections',
      payload: data.payload,
      headers: { ...data.headers, ...auth },
    });
    assert.equal(upload.statusCode, 202);
    const id = upload.json().id;
    let v = upload.json() as CircuitInspection;
    for (let n = 0; n < 200 && ['queued', 'running'].includes(v.status); n++) {
      await new Promise((r) => setTimeout(r, 10));
      v = (
        await app.inject({
          url: `/api/circuit-inspections/${id}`,
          headers: auth,
        })
      ).json();
    }
    assert.equal(v.status, 'needs_review');
    assert.equal(
      (
        await app.inject({
          url: `/api/circuit-inspections/${id}/image`,
          headers: auth,
        })
      ).headers['content-type'],
      'image/jpeg',
    );
    const review = await app.inject({
      method: 'POST',
      url: `/api/circuit-inspections/${id}/review`,
      headers: auth,
      payload: reviewed(v),
    });
    assert.equal(review.statusCode, 200);
    assert.equal(review.json().status, 'reviewed');
    const diagnosis = await app.inject({
      method: 'POST',
      url: `/api/circuit-inspections/${id}/diagnose`,
      headers: auth,
      payload: {
        expectedRevision: review.json().revision,
        goal: '',
        verificationOf: null,
      },
    });
    assert.equal(diagnosis.statusCode, 200);
    assert.equal(diagnosis.json().diagnosis.status, 'needs_intent');
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/circuit-inspections/${id}`,
          headers: auth,
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/circuit-inspections/${id}`,
          headers: auth,
        })
      ).statusCode,
      404,
    );
    assert.equal(fake.calls(), 4);
  } finally {
    await app.close();
    store.close();
  }
});
