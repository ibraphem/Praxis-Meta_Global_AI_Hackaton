import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomaticCircuitService } from '../src/jobs/automatic-circuits.js';
import { JobStore } from '../src/jobs/store.js';
import { fitObservedBoard } from '../src/services/automatic-calibration.js';
import { calibrateBoard, project } from '../src/shared/calibration.js';
import type { MetaClient } from '../src/lib/meta-client.js';
import { buildApp } from '../src/app.js';
import {
  completion,
  imageBytes,
  multipartBody,
  testConfig,
} from './helpers.js';
import type { CircuitInspection } from '../src/shared/automatic-circuit.js';

const image = { width: 640, height: 960 };
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
    assert.equal(fake.calls(), 3);
  } finally {
    await app.close();
    store.close();
  }
});
