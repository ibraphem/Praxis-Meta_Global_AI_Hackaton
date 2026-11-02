import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syntheticNightLight } from './fixtures/night-light.js';
import {
  buildConnectivity,
  compareConnectivity,
  holeKey,
  validateCircuitReference,
} from '../src/services/connectivity.js';
import { JobStore } from '../src/jobs/store.js';
import {
  ConnectivityService,
  connectivityPerceptionHash,
} from '../src/jobs/connectivity.js';
import { imageBytes, testConfig } from './helpers.js';
import { prepareImage } from '../src/services/image.js';
import { exportJobEvidence } from '../src/jobs/evidence.js';
import { buildApp } from '../src/app.js';
import { analysisSchema } from '../src/schemas/vision.js';
import { project } from '../src/shared/calibration.js';
const node = (g: ReturnType<typeof buildConnectivity>, key: string) =>
  g.nodes.find((n) => n.members.includes(key))!.id;
const meta = {
  expectedRevision: 1,
  reviewer: 'synthetic-test-reviewer',
  reason: 'Synthetic review of the deliberately misplaced wire.',
};
async function savedFixture(directory = ':memory:') {
  const config = testConfig(),
    store = new JobStore(config, directory),
    bytes = await imageBytes(640, 900),
    job = store.create(bytes, await prepareImage(bytes, config));
  // Stop the normal analysis queue: these are synthetic graph-only tests.
  job.sam.status = 'failed';
  job.sam.attempts.forEach((a) => (a.status = 'failed'));
  job.status = 'failed';
  store.save(job);
  const f = syntheticNightLight(true);
  f.input.analysisId = job.analysisId;
  f.input.imageHash = job.imageHash;
  const workspace = {
    boards: f.input.boards.map((b) => ({
      calibration: b.calibration,
      rails: b.rails,
      revision: b.revision,
    })),
    assignments: [],
    reviews: [],
    photoId: job.imageHash,
    analysisRunId: null,
  };
  store.db.prepare('INSERT INTO connectivity_sources VALUES (?,?)').run(
    job.analysisId,
    JSON.stringify({
      input: f.input,
      workspace,
      sourceSceneHash: null,
      sourceAnalysisRevision: job.revision,
      sourcePerceptionHash: connectivityPerceptionHash(job),
    }),
  );
  return {
    ...f,
    config,
    store,
    job,
    workspace,
    service: new ConnectivityService(store),
  };
}

test('A: registered topology respects strips, center gap, separate rows and split rails', () => {
  const { input } = syntheticNightLight(),
    g = buildConnectivity(input);
  const n = (h: string) => node(g, holeKey('board_1', h));
  assert.equal(n('a10'), n('e10'));
  assert.notEqual(n('e10'), n('f10'));
  assert.notEqual(n('a10'), n('a11'));
  assert.equal(n('R1:1'), n('R1:25'));
  assert.notEqual(n('R2:12'), n('R2:13'));
  input.boards[0]!.rails[1]!.connectivity = 'unknown';
  input.boards[0]!.rails[1]!.splitAfter = null;
  const unknown = buildConnectivity(input);
  assert.notEqual(
    node(unknown, holeKey('board_1', 'R2:1')),
    node(unknown, holeKey('board_1', 'R2:2')),
  );
  assert.equal(unknown.conductiveCompleteness, false);
  input.boards[0]!.topologyState = 'unresolved';
  const pending = buildConnectivity(input);
  assert.notEqual(
    node(pending, holeKey('board_1', 'a5')),
    node(pending, holeKey('board_1', 'b5')),
  );
});
test('B/D: confirmed jumper joins nodes with provenance; every device remains a typed non-short', () => {
  const { input } = syntheticNightLight(),
    g = buildConnectivity(input);
  assert.equal(
    node(g, 'terminal:led:cathode'),
    node(g, 'terminal:q:collector'),
  );
  const wire = g.connections.find((e) => e.id === 'wire:jumper')!;
  assert.deepEqual(wire.evidenceIds, ['synthetic-evidence']);
  for (const type of [
    'led',
    'resistor',
    'ldr',
    'npn_transistor',
    'power_source',
  ])
    assert.ok(
      g.devices.some(
        (d) => d.type === type && d.behavior === 'typed_device_not_a_short',
      ),
    );
  for (const d of g.devices) {
    assert.ok(new Set(d.terminals.map((t) => t.nodeId)).size > 1);
    assert.equal(
      g.connections.some((e) => e.componentId === d.componentId),
      false,
    );
  }
});
test('C: unresolved, rejected and housing-entry associations never establish a conductive path', () => {
  for (const kind of ['unresolved', 'rejected', 'housing_entry'] as const) {
    const f = syntheticNightLight(),
      a = f.input.associations.find((a) => a.terminalId === 'jumper:b')!;
    if (kind === 'housing_entry') a.type = 'housing_entry';
    else a.state = kind;
    const g = buildConnectivity(f.input);
    assert.notEqual(
      node(g, 'terminal:led:cathode'),
      node(g, 'terminal:q:collector'),
    );
    assert.ok(g.unresolved.some((u) => u.terminalId === 'jumper:b'));
    assert.notEqual(
      compareConnectivity(g, f.reference, f.mapping).findings[0]!.status,
      'confirmed_fault',
    );
  }
});
test('E/F: matching synthetic night-light passes; misplaced jumper is correctly attributed and explained', () => {
  const healthy = syntheticNightLight(),
    bad = syntheticNightLight(true);
  assert.equal(
    compareConnectivity(
      buildConnectivity(healthy.input),
      healthy.reference,
      healthy.mapping,
    ).findings[0]!.status,
    'no_fault',
  );
  const g = buildConnectivity(bad.input),
    finding = compareConnectivity(g, bad.reference, bad.mapping).findings[0]!;
  assert.equal(finding.status, 'confirmed_fault');
  assert.equal(finding.scope, 'synthetic_fixture');
  assert.equal(finding.observed.jumperId, 'jumper');
  assert.equal(finding.expected.to, 'q:collector');
  assert.equal(
    finding.highlight.destinationNodeId,
    node(g, holeKey('board_1', 'f12')),
  );
  assert.ok(finding.highlight.connectionIds.includes('insert:jumper:b'));
  assert.ok(finding.evidenceIds.length);
  assert.equal(finding.electricalOperationVerified, false);
});
test('electrically equivalent holes and alternate confirmed paths do not create a false disconnection', () => {
  const f = syntheticNightLight();
  f.input.associations.find((a) => a.terminalId === 'jumper:b')!.target = {
    kind: 'hole',
    boardId: 'board_1',
    holeId: 'j12',
    calibrationRevision: 1,
  };
  assert.equal(
    compareConnectivity(buildConnectivity(f.input), f.reference, f.mapping)
      .findings[0]!.status,
    'no_fault',
  );
  const bad = syntheticNightLight(true);
  bad.input.associations.push({
    id: 'alternate-contact',
    terminalId: 'led:anode',
    target: { kind: 'terminal', terminalId: 'q:collector' },
    state: 'confirmed_manual',
    type: 'conductive_contact',
    evidence: bad.input.components[0]!.evidence,
    originalProposalRef: null,
  });
  assert.throws(() => buildConnectivity(bad.input), /Conflicting/);
  bad.input.associations.pop();
  const template = bad.input.components.find((c) => c.id === 'jumper')!;
  bad.input.components.push({
    ...template,
    id: 'alternate',
    terminalIds: ['alternate:a', 'alternate:b'],
  });
  for (const [i, role] of ['a', 'b'].entries()) {
    bad.input.terminals.push({
      ...bad.input.terminals.find((t) => t.id === 'jumper:a')!,
      id: `alternate:${role}`,
      componentId: 'alternate',
      role,
    });
    bad.input.associations.push({
      id: `alternate:${role}`,
      terminalId: `alternate:${role}`,
      target: {
        kind: 'hole',
        boardId: 'board_1',
        holeId: i ? 'j12' : 'c12',
        calibrationRevision: 1,
      },
      state: 'confirmed_manual',
      type: 'insertion',
      evidence: template.evidence,
      originalProposalRef: null,
    });
  }
  assert.equal(
    compareConnectivity(
      buildConnectivity(bad.input),
      bad.reference,
      bad.mapping,
    ).findings[0]!.status,
    'no_fault',
  );
});
test('incomplete conductive evidence, unverified roles, draft references and ambiguous mappings abstain', () => {
  const f = syntheticNightLight(true);
  f.input.boards[0]!.topologyState = 'unresolved';
  assert.notEqual(
    compareConnectivity(buildConnectivity(f.input), f.reference, f.mapping)
      .findings[0]!.status,
    'confirmed_fault',
  );
  const u = syntheticNightLight(true);
  u.input.terminals.find((t) => t.id === 'q:collector')!.roleState =
    'unresolved';
  assert.equal(
    compareConnectivity(buildConnectivity(u.input), u.reference, u.mapping)
      .findings[0]!.status,
    'insufficient_evidence',
  );
  const draft = syntheticNightLight(true);
  draft.reference.qualification = 'draft';
  assert.equal(
    compareConnectivity(
      buildConnectivity(draft.input),
      draft.reference,
      draft.mapping,
    ).findings[0]!.status,
    'insufficient_evidence',
  );
  assert.throws(
    () =>
      compareConnectivity(buildConnectivity(draft.input), draft.reference, {
        ...draft.mapping,
        q: 'led',
      }),
    /one-to-one/,
  );
  const pinout = syntheticNightLight().reference;
  pinout.qualification = 'verified_human';
  assert.throws(() => validateCircuitReference(pinout), /pinout/);
});
test('same confirmed inputs produce deterministic semantics independent of array order', () => {
  const f = syntheticNightLight(true),
    first = buildConnectivity(f.input);
  f.input.boards.reverse();
  f.input.components.reverse();
  f.input.terminals.reverse();
  f.input.associations.reverse();
  assert.equal(buildConnectivity(f.input).graphHash, first.graphHash);
});
test('a new SAM checkpoint invalidates the graph even when the published revision and visible IDs stay unchanged', async (t) => {
  const f = await savedFixture();
  t.after(() => f.store.close());
  f.service.build(f.job.analysisId, { expectedRevision: 1 });
  const current = f.store.get(f.job.analysisId),
    revision = current.revision;
  current.sam.snapshotRef = f.store.checkpointSnapshot(
    current,
    current.sam.snapshot!,
    current.sam.attempts[0]!.attemptId,
  );
  f.store.save(current);
  assert.equal(f.store.get(f.job.analysisId).revision, revision);
  assert.equal(f.service.view(f.job.analysisId).graphStale, true);
  assert.throws(
    () => f.service.build(f.job.analysisId, { expectedRevision: 1 }),
    { code: 'STALE_CONNECTIVITY' },
  );
});
test('a missing path needs explicit conductive review coverage; later reviews invalidate that assertion', async (t) => {
  const f = syntheticNightLight(true);
  f.input.coverage = { state: 'unresolved', evidence: [] };
  assert.equal(
    compareConnectivity(buildConnectivity(f.input), f.reference, f.mapping)
      .findings[0]!.status,
    'possible_fault',
  );
  const saved = await savedFixture();
  t.after(() => saved.store.close());
  const v = saved.service.review(saved.job.analysisId, {
    ...meta,
    action: 'topology',
    targetId: 'board_1',
    value: { confirmed: true },
  });
  assert.equal(v.source!.input.coverage.state, 'unresolved');
  const reviewed = saved.service.review(saved.job.analysisId, {
    ...meta,
    expectedRevision: 2,
    action: 'coverage',
    targetId: 'conductive-review-coverage',
    value: { confirmed: true },
  });
  assert.equal(reviewed.source!.input.coverage.state, 'confirmed_manual');
  assert.ok(reviewed.source!.input.coverage.evidence[0]!.reviewer);
});
test('legacy complete endpoint assignments require new electrical and wire identity confirmation before node union', async (t) => {
  const config = testConfig(),
    store = new JobStore(config, ':memory:');
  t.after(() => store.close());
  const bytes = await imageBytes(640, 900),
    job = store.create(bytes, await prepareImage(bytes, config));
  job.candidateResult = analysisSchema.parse({
    image: job.image,
    objects: [
      {
        id: 'jumper_wire_1',
        type: 'jumper_wire',
        bbox: [100, 200, 300, 200],
        interpretation: 'uncertain',
        geometryStatus: 'segmented',
        localizationSource: 'sam',
        guidanceEligible: false,
        identityStatus: 'unverified',
        mask: {
          format: 'svg_path',
          width: 300,
          height: 200,
          path: 'M0 0L300 0L300 200L0 200Z',
        },
      },
    ],
    provenance: { mode: 'combined', reasoningModel: 'synthetic' },
  });
  store.save(job);
  const f = syntheticNightLight(),
    board = f.input.boards[0]!,
    workspace = {
      boards: [
        { calibration: board.calibration, rails: board.rails, revision: 1 },
      ],
      assignments: [
        {
          id: 'connection_1',
          wireCandidateId: 'jumper_wire_1',
          photoId: job.imageHash,
          analysisRunId: job.analysisId,
          wireIdentity: { status: 'unverified' },
          endpoints: [
            {
              boardId: 'board_1',
              calibrationRevision: 1,
              selectedImagePosition: project(
                board.calibration as Parameters<typeof project>[0],
                { x: 1, y: 11 },
              ),
              resolution: { status: 'resolved', holeId: 'b12' },
              electricalContact: 'unknown',
            },
            {
              boardId: 'board_1',
              calibrationRevision: 1,
              selectedImagePosition: project(
                board.calibration as Parameters<typeof project>[0],
                { x: 8, y: 12 },
              ),
              resolution: { status: 'resolved', holeId: 'g13' },
              electricalContact: 'unknown',
            },
          ],
        },
      ],
      reviews: [],
      photoId: job.imageHash,
      analysisRunId: job.analysisId,
    };
  const service = new ConnectivityService(store);
  let v = service.importWorkspace(job.analysisId, {
    ...meta,
    expectedRevision: 0,
    imageHash: job.imageHash,
    workspace,
  });
  assert.ok(
    v.source!.input.associations.every((a) => a.state === 'unresolved'),
  );
  assert.equal(v.source!.input.components[0]!.continuity, 'unresolved');
  assert.equal(
    service
      .build(job.analysisId, { expectedRevision: 1 })
      .graph!.graph.connections.some((e) => e.type === 'wire'),
    false,
  );
  v = service.review(job.analysisId, {
    ...meta,
    action: 'component',
    targetId: 'baseline:jumper_wire_1',
    value: { type: 'jumper_wire', confirmed: true, intactConductor: true },
  });
  for (const a of [...v.source!.input.associations])
    v = service.review(job.analysisId, {
      ...meta,
      expectedRevision: v.source!.input.revision,
      action: 'association',
      targetId: a.id,
      value: {
        terminalId: a.terminalId,
        target: a.target,
        type: 'insertion',
        decision: 'confirmed_manual',
      },
    });
  v = service.review(job.analysisId, {
    ...meta,
    expectedRevision: v.source!.input.revision,
    action: 'topology',
    targetId: 'board_1',
    value: { confirmed: true },
  });
  const g = service.build(job.analysisId, {
    expectedRevision: v.source!.input.revision,
  }).graph!.graph;
  assert.equal(
    node(g, holeKey('board_1', 'b12')),
    node(g, holeKey('board_1', 'g13')),
  );
  const original = v.history[0]!.payload as typeof workspace;
  assert.equal(
    original.assignments[0]!.endpoints[0]!.electricalContact,
    'unknown',
  );
});
test('a confirmed wire can bridge a declared rail split without changing its topology declaration', () => {
  const f = syntheticNightLight();
  for (const [id, holeId] of [
    ['jumper:a', 'R2:12'],
    ['jumper:b', 'R2:13'],
  ])
    f.input.associations.find((a) => a.terminalId === id)!.target = {
      kind: 'hole',
      boardId: 'board_1',
      holeId: holeId!,
      calibrationRevision: 1,
    };
  const g = buildConnectivity(f.input);
  assert.equal(
    node(g, holeKey('board_1', 'R2:1')),
    node(g, holeKey('board_1', 'R2:25')),
  );
  assert.equal(f.input.boards[0]!.rails[1]!.connectivity, 'split');
});
test('manual components start with unknown roles, require contact evidence, and never invent transistor assignments', async (t) => {
  const f = await savedFixture();
  t.after(() => f.store.close());
  let v = f.service.review(f.job.analysisId, {
    ...meta,
    action: 'add_component',
    targetId: 'manual:extra',
    value: { label: 'Unrecognized physical device', type: 'npn_transistor' },
  });
  const c = v.source!.input.components.find((c) => c.id === 'manual:extra')!;
  assert.equal(c.terminalIds.length, 3);
  assert.ok(
    v
      .source!.input.terminals.filter((t) => t.componentId === c.id)
      .every((t) => t.role === null && t.roleState === 'unresolved'),
  );
  assert.throws(
    () =>
      f.service.review(f.job.analysisId, {
        ...meta,
        expectedRevision: 2,
        action: 'association',
        targetId: 'manual:entry',
        value: {
          terminalId: c.terminalIds[0],
          target: {
            kind: 'hole',
            boardId: 'board_1',
            holeId: 'a10',
            calibrationRevision: 1,
          },
          type: 'housing_entry',
          decision: 'confirmed_manual',
        },
      }),
    /contact/,
  );
  assert.throws(
    () =>
      f.service.review(f.job.analysisId, {
        ...meta,
        expectedRevision: 2,
        action: 'association',
        targetId: 'manual:entry',
        value: {
          terminalId: c.terminalIds[0],
          target: {
            kind: 'hole',
            boardId: 'board_1',
            holeId: 'a999',
            calibrationRevision: 1,
          },
          type: 'insertion',
          decision: 'confirmed_manual',
        },
      }),
    /current board/,
  );
  v = f.service.build(f.job.analysisId, { expectedRevision: 2 });
  assert.ok(
    v.graph!.graph.unresolved.some((u) => u.terminalId === c.terminalIds[0]),
  );
});
test('unresolved contact survives persistence and replay, and changed calibration invalidates a confirmed insertion', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-connectivity-unknown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await savedFixture(dir);
  f.service.review(f.job.analysisId, {
    ...meta,
    action: 'association',
    targetId: 'insert:jumper:b',
    value: {
      terminalId: 'jumper:b',
      target: null,
      type: 'insertion',
      decision: 'unresolved',
    },
  });
  const g = f.service.build(f.job.analysisId, { expectedRevision: 2 }).graph!
    .graph;
  assert.ok(g.unresolved.some((u) => u.terminalId === 'jumper:b'));
  f.store.close();
  const reopened = new JobStore(f.config, dir);
  t.after(() => reopened.close());
  const service = new ConnectivityService(reopened),
    v = service.build(f.job.analysisId, { expectedRevision: 2 });
  assert.equal(v.graph!.graph.graphHash, g.graphHash);
  assert.equal(
    v.source!.input.associations.find((a) => a.terminalId === 'jumper:b')!
      .state,
    'unresolved',
  );
  const stale = syntheticNightLight();
  stale.input.boards[0]!.revision++;
  const rebuilt = buildConnectivity(stale.input);
  assert.equal(
    rebuilt.connections.some((e) => e.type === 'insertion'),
    false,
  );
  assert.ok(rebuilt.unresolved.some((u) => u.reason.includes('stale')));
});
test('G/H: correction is immutable, source-revision fenced, restart-safe and replay does not promote unknown evidence', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-connectivity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await savedFixture(dir);
  f.service.build(f.job.analysisId, { expectedRevision: 1 });
  let v = f.service.registerReference(f.job.analysisId, {
    ...meta,
    reference: f.reference,
    mapping: f.mapping,
  });
  v = f.service.compare(f.job.analysisId, {
    expectedRevision: 1,
    referenceId: v.references[0]!.id,
  });
  assert.equal(
    v.comparisons[0]!.comparison.findings[0]!.status,
    'confirmed_fault',
  );
  v = f.service.review(f.job.analysisId, {
    ...meta,
    action: 'association',
    targetId: 'insert:jumper:b',
    value: {
      terminalId: 'jumper:b',
      target: {
        kind: 'hole',
        boardId: 'board_1',
        holeId: 'j12',
        calibrationRevision: 1,
      },
      type: 'insertion',
      decision: 'confirmed_manual',
    },
  });
  assert.equal(v.source!.input.revision, 2);
  assert.equal(v.graphStale, true);
  assert.equal(
    (v.history[0]!.previousValue as { target: { holeId: string } }).target
      .holeId,
    'g13',
  );
  assert.equal(
    (v.history[0]!.payload as { value: { target: { holeId: string } } }).value
      .target.holeId,
    'j12',
  );
  assert.throws(
    () => f.service.build(f.job.analysisId, { expectedRevision: 1 }),
    /current/,
  );
  assert.throws(
    () =>
      f.service.review(f.job.analysisId, {
        ...meta,
        action: 'topology',
        targetId: 'board_1',
        value: { confirmed: true },
      }),
    /revision/,
  );
  const graph = f.service.build(f.job.analysisId, { expectedRevision: 2 })
    .graph!.graph;
  assert.equal(
    f.service.build(f.job.analysisId, { expectedRevision: 2 }).graph!.graph
      .graphHash,
    graph.graphHash,
  );
  v = f.service.compare(f.job.analysisId, {
    expectedRevision: 2,
    referenceId: v.references[0]!.id,
  });
  assert.equal(
    v.comparisons.at(-1)!.comparison.findings[0]!.status,
    'no_fault',
  );
  assert.throws(
    () => f.store.db.prepare('UPDATE connectivity_events SET data=?').run('{}'),
    /immutable/,
  );
  f.store.close();
  const reopened = new JobStore(f.config, dir);
  t.after(() => reopened.close());
  const service = new ConnectivityService(reopened);
  assert.equal(
    service.view(f.job.analysisId).graph!.graph.graphHash,
    graph.graphHash,
  );
  assert.equal(service.view(f.job.analysisId).history.length, 1);
  const out = join(dir, 'archive');
  exportJobEvidence(reopened, f.job.analysisId, out);
  const archive = JSON.parse(
    readFileSync(join(out, 'connectivity.json'), 'utf8'),
  );
  assert.equal(archive.history.length, 1);
  assert.equal(archive.graphHistory.length, 2);
  assert.equal(
    archive.references[0].reference.qualification,
    'synthetic_fixture',
  );
});
test('workspace import persists geometry while preserving unknown electrical contact and original proposals', async (t) => {
  const config = testConfig(),
    store = new JobStore(config, ':memory:');
  t.after(() => store.close());
  const bytes = await imageBytes(640, 900),
    job = store.create(bytes, await prepareImage(bytes, config));
  const service = new ConnectivityService(store),
    f = syntheticNightLight();
  const body = {
    expectedRevision: 0,
    reviewer: 'fixture',
    reason: 'Synthetic geometry import only.',
    imageHash: job.imageHash,
    workspace: {
      boards: f.input.boards.map((b) => ({
        calibration: b.calibration,
        rails: b.rails,
        revision: b.revision,
      })),
      assignments: [],
      reviews: [{ original: 'preserved' }],
      photoId: job.imageHash,
      analysisRunId: null,
    },
  };
  const v = service.importWorkspace(job.analysisId, body);
  assert.equal(v.source!.input.boards[0]!.topologyState, 'unresolved');
  assert.deepEqual((v.history[0]!.payload as { reviews: unknown[] }).reviews, [
    { original: 'preserved' },
  ]);
  assert.throws(
    () =>
      service.importWorkspace(job.analysisId, {
        ...body,
        imageHash: 'b'.repeat(64),
      }),
    /photograph/,
  );
  assert.equal(v.additionalInferenceRequests, 0);
});
test('HTTP graph construction and diagnosis are local, bound to analysis and never schedule inference', async (t) => {
  const f = await savedFixture(),
    app = await buildApp(f.config, undefined, () => {}, undefined, {
      store: f.store,
    });
  t.after(() => app.close());
  const root = `/api/analyses/${f.job.analysisId}`;
  const before = JSON.stringify(f.store.get(f.job.analysisId));
  const get = await app.inject({ method: 'GET', url: `${root}/connectivity` });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().imageHash, f.job.imageHash);
  const build = await app.inject({
    method: 'POST',
    url: `${root}/build-connectivity`,
    payload: { expectedRevision: 1 },
  });
  assert.equal(build.statusCode, 200);
  assert.ok(build.json().graph.graph.graphHash);
  const ref = await app.inject({
    method: 'POST',
    url: `${root}/register-connectivity-reference`,
    payload: { ...meta, reference: f.reference, mapping: f.mapping },
  });
  assert.equal(ref.statusCode, 200);
  const compare = await app.inject({
    method: 'POST',
    url: `${root}/compare-connectivity`,
    payload: { expectedRevision: 1, referenceId: ref.json().references[0].id },
  });
  assert.equal(compare.statusCode, 200);
  assert.equal(
    compare.json().comparisons[0].comparison.findings[0].status,
    'confirmed_fault',
  );
  const stale = await app.inject({
    method: 'POST',
    url: `${root}/build-connectivity`,
    payload: { expectedRevision: 0 },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(JSON.stringify(f.store.get(f.job.analysisId)), before);
  assert.equal(
    f.store.db.prepare('SELECT COUNT(*) n FROM scene_requests').get()!.n,
    0,
  );
});
