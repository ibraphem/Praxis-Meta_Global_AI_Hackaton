import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { canonicalHash } from '../src/lib/canonical-json.js';
import { ConnectorWorkflowService } from '../src/jobs/connector-workflow.js';
import { connectorAccounting } from '../src/jobs/connector-lifecycle.js';
import { JobStore } from '../src/jobs/store.js';
import { buildApp } from '../src/app.js';
import { evaluateConnectorPixels } from '../src/services/connector-pixel-evaluation.js';
import { connectorThresholds } from '../src/services/connector-pixel-evaluation.js';
import { exportJobEvidence } from '../src/jobs/evidence.js';
import { buildSceneGraph } from '../src/services/scene.js';
import { matchInventoryRediscoveries } from '../src/services/scene-identity.js';
import { sceneGraphSchema } from '../src/schemas/scene.js';
import {
  syntheticConnectorFixture,
  syntheticConnectorClient,
  workflowApproval,
} from './fixtures/connector-workflow.js';
import { testConfig, maskFixture } from './helpers.js';

async function setup(
  t: { after: (f: () => void | Promise<void>) => void },
  behavior?: Parameters<typeof syntheticConnectorClient>[1],
) {
  const f = await syntheticConnectorFixture(),
    fake = syntheticConnectorClient(f.config, behavior),
    service = new ConnectorWorkflowService(f.store, fake.client);
  t.after(async () => {
    await service.close();
    f.store.close();
  });
  return { ...f, fake, service };
}
test('shared HTTP execution freezes exact A/B specs, preserves production evidence, evaluates and exports bound native evidence', async (t) => {
  const f = await setup(t),
    app = await buildApp(f.config, undefined, () => {}, undefined, {
      store: f.store,
      experimentClient: f.fake.client,
    });
  t.after(() => app.close());
  const before = JSON.stringify(f.store.get(f.job.analysisId));
  const prepare = await app.inject({
    method: 'POST',
    url: `/api/analyses/${f.job.analysisId}/prepare-automatic-targeting`,
    payload: f.prepareBody,
  });
  assert.equal(prepare.statusCode, 200, prepare.body);
  const summary = prepare.json().automaticTargeting[0];
  assert.equal(summary.arms.length, 2);
  assert.equal(summary.budget.plannedRequests, 2);
  assert.equal(f.fake.calls(), 0);
  const w = f.service.get(summary.workflowId);
  assert.equal(w.workflowId, canonicalHash(w.contract));
  assert.equal(w.contract.plan.requestSpecifications!.length, 2);
  const reordered = Object.fromEntries(Object.entries(w.contract).reverse());
  assert.equal(canonicalHash(reordered), w.workflowId);
  const again = await f.service.prepare(f.job.analysisId, f.prepareBody);
  assert.equal(again.workflowId, w.workflowId);
  const wrong = await app.inject({
    method: 'POST',
    url: `/api/analyses/${f.job.analysisId}/run-automatic-targeting`,
    payload: { ...workflowApproval(w), pixels: 1 },
  });
  assert.equal(wrong.statusCode, 400);
  assert.equal(f.fake.calls(), 0);
  const run = await app.inject({
    method: 'POST',
    url: `/api/analyses/${f.job.analysisId}/run-automatic-targeting`,
    payload: workflowApproval(w),
  });
  assert.equal(run.statusCode, 202, run.body);
  let result = f.service.publicForAnalysis(f.job.analysisId)[0]!;
  for (
    let i = 0;
    i < 100 && ['running', 'starting'].includes(result.status);
    i++
  ) {
    await delay(5);
    result = f.service.publicForAnalysis(f.job.analysisId)[0]!;
  }
  assert.equal(result.status, 'completed');
  assert.equal(f.fake.calls(), 2);
  assert.equal(result.accounting.dispatchAttempts, 2);
  assert.equal(result.accounting.responsesRecorded, 2);
  assert.equal(result.accounting.providerConfirmedUsage, null);
  assert.ok(
    result.measurements.every(
      (m) =>
        m.events.map((e) => e.phase).join(',') ===
        'admitted,dispatching,response_recorded',
    ),
  );
  const reviews = result.measurements.flatMap((m) =>
    m.observationIds.map((observationId) => ({
      observationId,
      decision: 'correct',
      source: 'synthetic_fixture',
      reviewedAt: Date.now(),
    })),
  );
  const evaluated = await app.inject({
    method: 'POST',
    url: `/api/analyses/${f.job.analysisId}/evaluate-automatic-targeting`,
    payload: { workflowId: w.workflowId, reviews },
  });
  assert.equal(evaluated.statusCode, 200, evaluated.body);
  const evaluation = evaluated.json().automaticTargeting[0].evaluation;
  assert.equal(evaluation.status, 'synthetic_pass');
  assert.equal(evaluation.successRate, 1);
  assert.equal(evaluation.independentGroundTruth, false);
  assert.equal(f.service.evaluate(w.workflowId).status, 'synthetic_pass');
  assert.equal(f.service.get(w.workflowId).evaluations.length, 1);
  assert.deepEqual(
    evaluation.armResults.map(
      (a: { maskMetrics: Array<{ iou: number }> }) => a.maskMetrics[0]!.iou,
    ),
    [1, 1],
  );
  const evidence = await app.inject({ method: 'GET', url: result.evidenceUrl });
  assert.equal(evidence.statusCode, 200);
  const data = evidence.json();
  assert.equal(data.requests.length, 2);
  assert.ok(
    data.requests.every(
      (r: { response?: unknown; request?: unknown }) => r.response && r.request,
    ),
  );
  assert.equal(data.workflow.workflowId, canonicalHash(data.workflow.contract));
  assert.equal(JSON.stringify(f.store.get(f.job.analysisId)), before);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/analyses/${f.job.analysisId}/run-automatic-targeting`,
        payload: workflowApproval(w),
      })
    ).statusCode,
    409,
  );
  assert.equal(f.fake.calls(), 2);
});

test('point abstention stays in the denominator; empty outputs and references without pixel truth do not fabricate scores', async (t) => {
  const f = await setup(t, ['empty', 'empty']);
  const w = await f.service.prepare(f.job.analysisId, {
    ...f.prepareBody,
    reference: undefined,
  });
  const report = await f.service.run(w.workflowId, workflowApproval(w));
  assert.equal(report.status, 'completed');
  assert.equal(f.service.evaluate(w.workflowId).status, 'unavailable');
  const scored = evaluateConnectorPixels({
    report,
    reference: f.reference,
    registeredReferenceHash: canonicalHash(f.reference),
  });
  assert.equal(scored.status, 'failed');
  assert.equal(scored.successRate, 0);
  assert.equal(scored.validMaskArms, 0);
  assert.ok(
    scored.armResults.every(
      (a) =>
        a.maskMetrics.length === 0 &&
        a.emptyPrediction?.iou === 0 &&
        a.emptyPrediction.precision === null,
    ),
  );
  const partial = structuredClone(report);
  partial.plan.variants = partial.plan.variants.slice(0, 1);
  partial.measurements = partial.measurements.slice(0, 1);
  const abstention = evaluateConnectorPixels({
    report: partial,
    reference: f.reference,
    registeredReferenceHash: canonicalHash(f.reference),
  });
  assert.equal(abstention.abComparison, 'incomplete');
  assert.equal(abstention.armResults[1]!.outcome, 'abstained');
  assert.equal(abstention.successRate, 0);
  const assistant = { ...f.reference, source: 'assistant_visual' as const };
  assert.equal(
    evaluateConnectorPixels({
      report,
      reference: assistant,
      registeredReferenceHash: canonicalHash(assistant),
    }).successRate,
    null,
  );
});

test('pixel metrics penalize conductor leakage and incorrect physical identity despite successful mask delivery', async (t) => {
  const f = await setup(t);
  const reference = {
    ...f.reference,
    conductors: {
      bbox: [120, 80, 20, 20] as [number, number, number, number],
      mask: maskFixture('blob'),
    },
  };
  const w = await f.service.prepare(f.job.analysisId, {
    ...f.prepareBody,
    reference,
  });
  const report = await f.service.run(w.workflowId, workflowApproval(w));
  for (const m of report.measurements)
    (m.observations![0] as { bbox: number[] }).bbox = [120, 80, 20, 20];
  const reviews = report.measurements.flatMap((m) =>
    (m.observations as Array<{ id: string }>).map((o) => ({
      observationId: o.id,
      decision: 'incorrect' as const,
      source: 'synthetic_fixture' as const,
      reviewedAt: Date.now(),
    })),
  );
  const result = evaluateConnectorPixels({
    report,
    reference,
    registeredReferenceHash: canonicalHash(reference),
    reviews,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.successRate, 0);
  for (const arm of result.armResults) {
    const mask = arm.maskMetrics[0]!;
    assert.equal(mask.recall, 0);
    assert.equal(mask.precision, 0);
    assert.equal(mask.leakage, 1);
    assert.equal(mask.identityCorrectness, 'incorrect');
  }
  assert.equal(connectorThresholds.minimumIoU, 0.8);
});

test('unknown usage survives release; duplicate execution is blocked and replacement requires a new linked authorization', async (t) => {
  const f = await setup(t, ['disconnect']);
  const w = await f.service.prepare(f.job.analysisId, f.prepareBody);
  const report = await f.service.run(w.workflowId, workflowApproval(w));
  assert.equal(report.status, 'interrupted');
  assert.equal(report.accounting.reservedRequests, 1);
  assert.equal(report.accounting.dispatchAttempts, 1);
  assert.equal(report.accounting.responsesRecorded, 0);
  assert.equal(report.accounting.unknownUsageRequests, 1);
  f.service.release(w.workflowId);
  const released = f.service.publicForAnalysis(f.job.analysisId)[0]!;
  assert.equal(released.status, 'released');
  assert.equal(released.accounting.unknownUsageRequests, 1);
  await assert.rejects(
    f.service.run(w.workflowId, workflowApproval(w)),
    /already admitted/,
  );
  await assert.rejects(
    f.service.prepare(f.job.analysisId, f.prepareBody),
    /unknown usage/,
  );
  const replacement = await f.service.prepare(f.job.analysisId, {
    ...f.prepareBody,
    replacementOf: w.workflowId,
    authorizeReplacement: true,
  });
  assert.notEqual(replacement.workflowId, w.workflowId);
  assert.equal(replacement.contract.replacementOf, w.workflowId);
  assert.equal(f.fake.calls(), 1);
});

test('definitive failures retain response bytes and never become completed or unknown dispatches', async (t) => {
  const f = await setup(t, ['invalid']);
  const w = await f.service.prepare(f.job.analysisId, f.prepareBody);
  const report = await f.service.run(w.workflowId, workflowApproval(w));
  assert.equal(report.status, 'failed');
  assert.equal(report.accounting.responsesRecorded, 1);
  assert.equal(report.accounting.unknownUsageRequests, 0);
  assert.equal(report.measurements[0]!.phase, 'response_recorded');
  assert.equal(
    f.service.evidence(w.workflowId, f.job.analysisId).requests[0]!
      .failurePhase,
    'decoding',
  );
});

test('identity replay is order-invariant for clear identities and preserves ambiguity across jitter and conductor conflicts', async (t) => {
  const f = await setup(t),
    before = JSON.stringify(f.graph.observations);
  const clear = f.graph.objects.map((o) => ({
    proposedType: o.proposedType,
    category: o.category,
    bbox: o.bbox,
  }));
  const a = matchInventoryRediscoveries(f.graph, clear),
    b = matchInventoryRediscoveries(f.graph, [...clear].reverse());
  assert.deepEqual(
    a.map((d) => d.matchedObjectId).sort(),
    b.map((d) => d.matchedObjectId).sort(),
  );
  let graph = f.graph;
  for (let iteration = 0; iteration < 3; iteration++) {
    const x = 350 + iteration * 3;
    const proposals = [
      {
        proposedType: 'black battery snap connector',
        category: 'connector' as const,
        box: [x, 188, 550, 500] as [number, number, number, number],
      },
      {
        proposedType: 'black battery snap clip',
        category: 'connector' as const,
        box: [350, 188, 550, 500] as [number, number, number, number],
      },
      {
        proposedType: 'red conductor from battery connector',
        category: 'conductor' as const,
        box: [350, 188, 550, 500] as [number, number, number, number],
      },
    ];
    graph = buildSceneGraph({
      inventory: { objects: iteration % 2 ? proposals.reverse() : proposals },
      previous: graph,
      snapshot: f.job.sam.snapshot!,
      ref: f.job.sam.snapshotRef!,
      attemptId: randomUUID(),
      imageHash: f.job.imageHash,
      model: 'fake-replay',
    });
    assert.equal(graph.ambiguityClusters!.length, 1);
    assert.equal(graph.identityReviews?.length ?? 0, 0);
    assert.equal(graph.ambiguityReviews?.length ?? 0, 0);
    for (const original of f.graph.observations)
      assert.deepEqual(
        graph.observations.find((o) => o.id === original.id),
        original,
      );
  }
  assert.equal(JSON.stringify(f.graph.observations), before);
  sceneGraphSchema.parse(graph);
  assert.equal(graph.terminals?.length ?? 0, 0);
});

for (const phase of ['admitted', 'dispatching', 'response_recorded'])
  test(`SIGKILL at ${phase} recovers durable evidence without replay`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'praxis-connector-crash-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/connector-crash-child.ts',
        root,
        phase,
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    const ready = await new Promise<{ analysisId: string; workflowId: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(
            new Error('Crash fixture did not reach checkpoint: ' + errors),
          );
        }, 8000);
        child.stdout.once('data', (chunk) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(String(chunk)));
          } catch (e) {
            reject(e);
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Crash fixture exited ${code}: ${errors}`));
        });
      },
    );
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const store = new JobStore(testConfig(), root),
      service = new ConnectorWorkflowService(store);
    t.after(async () => {
      await service.close();
      store.close();
    });
    store.experiments.recover(Date.now() + 30000);
    const record = service.publicForAnalysis(ready.analysisId)[0]!;
    assert.equal(record.status, 'interrupted');
    assert.equal(record.accounting.reservedRequests, 1);
    assert.equal(
      record.accounting.dispatchAttempts,
      phase === 'admitted' ? 0 : 1,
    );
    assert.equal(
      record.accounting.responsesRecorded,
      phase === 'response_recorded' ? 1 : 0,
    );
    assert.equal(
      record.accounting.unknownUsageRequests,
      phase === 'dispatching' ? 1 : 0,
    );
    const ledger = service.evidence(ready.workflowId, ready.analysisId);
    assert.equal(
      connectorAccounting(
        ledger.experiment!.report as Parameters<typeof connectorAccounting>[0],
      ).reservedRequests,
      1,
    );
    const destination = join(root, 'archive');
    const manifest = exportJobEvidence(store, ready.analysisId, destination);
    assert.ok(
      manifest.files.some((f) => f.path === 'automatic-targeting/1.json'),
    );
    assert.ok(
      readFileSync(
        join(destination, 'automatic-targeting/1.json'),
        'utf8',
      ).includes(ready.workflowId),
    );
    await assert.rejects(
      service.run(
        ready.workflowId,
        workflowApproval(service.get(ready.workflowId)),
      ),
      /already admitted/,
    );
  });

for (const rejectedPhase of ['dispatching', 'response_recorded'])
  test(`failed ${rejectedPhase} transaction cannot leak uncommitted evidence or permit replay`, async (t) => {
    const f = await setup(t),
      w = await f.service.prepare(f.job.analysisId, f.prepareBody);
    const record = f.store.experiments.record.bind(f.store.experiments);
    let injected = false;
    f.store.experiments.record = (id, owner, report, status) => {
      const current = report as { measurements: Array<{ phase: string }> };
      if (!injected && current.measurements.at(-1)?.phase === rejectedPhase) {
        injected = true;
        return false;
      }
      return record(id, owner, report, status);
    };
    const result = await f.service.run(w.workflowId, workflowApproval(w));
    const raw = f.service.evidence(w.workflowId, f.job.analysisId).requests[0]!;
    assert.equal(result.accounting.reservedRequests, 1);
    if (rejectedPhase === 'dispatching') {
      assert.equal(f.fake.calls(), 0);
      assert.equal(result.status, 'failed');
      assert.equal(result.accounting.dispatchAttempts, 0);
      assert.equal(raw.request, undefined);
    } else {
      assert.equal(f.fake.calls(), 1);
      assert.equal(result.status, 'interrupted');
      assert.equal(result.accounting.unknownUsageRequests, 1);
      assert.equal(raw.response, undefined);
    }
    await assert.rejects(
      f.service.run(w.workflowId, workflowApproval(w)),
      /already admitted/,
    );
  });

test('evaluation failures are persisted separately from successful execution and preserve the original evidence', async (t) => {
  const f = await setup(t),
    w = await f.service.prepare(f.job.analysisId, f.prepareBody);
  const report = await f.service.run(w.workflowId, workflowApproval(w));
  const before = canonicalHash(
    f.service.evidence(w.workflowId, f.job.analysisId).requests,
  );
  assert.throws(
    () =>
      f.service.evaluate(w.workflowId, [
        {
          observationId: randomUUID(),
          decision: 'correct',
          source: 'synthetic_fixture',
          reviewedAt: Date.now(),
        },
      ]),
    /Inspect the mask/,
  );
  const record = f.service.publicForAnalysis(f.job.analysisId)[0]!;
  assert.equal(record.status, 'completed');
  assert.equal(record.evaluationStatus, 'failed');
  assert.equal(record.evaluationError, 'EVALUATION_FAILED');
  assert.equal(
    canonicalHash(f.service.evidence(w.workflowId, f.job.analysisId).requests),
    before,
  );
  assert.equal(report.measurements.length, 2);
});

test('frozen references cannot alter automatic cues and corrupted registered references fail closed', async (t) => {
  const f = await setup(t),
    a = await f.service.prepare(f.job.analysisId, f.prepareBody);
  const alternate = {
    ...f.reference,
    reviewId: randomUUID(),
    source: 'assistant_visual' as const,
  };
  const b = await f.service.prepare(f.job.analysisId, {
    ...f.prepareBody,
    reference: alternate,
  });
  assert.equal(canonicalHash(a.contract.plan), canonicalHash(b.contract.plan));
  assert.notEqual(a.workflowId, b.workflowId);
  const corrupted = structuredClone(a);
  corrupted.reference!.connector.bbox[0] += 1;
  f.store.db
    .prepare('UPDATE connector_workflows SET data=? WHERE id=?')
    .run(JSON.stringify(corrupted), a.workflowId);
  assert.throws(() => f.service.get(a.workflowId), /integrity/);
  assert.equal(f.fake.calls(), 0);
});

test('missing request provenance cannot pass a pixel gate and each evaluation retains its evidence digest', async (t) => {
  const f = await setup(t),
    w = await f.service.prepare(f.job.analysisId, f.prepareBody);
  const report = await f.service.run(w.workflowId, workflowApproval(w));
  const reviews = report.measurements.flatMap((m) =>
    (m.observations as Array<{ id: string }>).map((o) => ({
      observationId: o.id,
      decision: 'correct',
      source: 'synthetic_fixture',
      reviewedAt: Date.now(),
    })),
  );
  assert.equal(
    f.service.evaluate(w.workflowId, reviews).status,
    'synthetic_pass',
  );
  const request = f.service.evidence(w.workflowId, f.job.analysisId)
    .requests[0]!;
  request.prompt = 'wrong target';
  f.store.db
    .prepare('UPDATE scene_requests SET data=? WHERE id=?')
    .run(JSON.stringify(request), request.requestId);
  const after = f.service.evaluate(w.workflowId, reviews);
  assert.equal(after.status, 'incomplete');
  assert.equal(after.invariants!.missingRequiredProvenance, 1);
  assert.equal(after.successRate, 0.5);
  assert.equal(f.service.get(w.workflowId).evaluations.length, 2);
});
