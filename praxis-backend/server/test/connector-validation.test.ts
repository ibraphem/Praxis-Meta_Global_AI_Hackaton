import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeMaskToRaster } from '@meta-sam/parser';
import { canonicalHash } from '../src/lib/canonical-json.js';
import { ConnectorWorkflowService } from '../src/jobs/connector-workflow.js';
import { ConnectorValidationService } from '../src/jobs/connector-validation.js';
import { assertConnectorTerminalGate } from '../src/jobs/connector-validation-gate.js';
import { auditConnectorEvidence } from '../src/jobs/connector-evidence-audit.js';
import {
  syntheticConnectorFixture,
  syntheticConnectorClient,
  workflowApproval,
} from './fixtures/connector-workflow.js';
import type { AnnotationContent } from '../src/schemas/connector-validation.js';
import { checkpointScene } from '../src/jobs/scene-snapshots.js';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { exportJobEvidence } from '../src/jobs/evidence.js';
import { sha256 } from '../src/jobs/scene-request-evidence.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pixelMetrics } from '../src/services/pixel-reference.js';

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const f = await syntheticConnectorFixture(':memory:', false),
    fake = syntheticConnectorClient(f.config, ['mask']),
    workflows = new ConnectorWorkflowService(f.store, fake.client),
    service = new ConnectorValidationService(f.store);
  t.after(async () => {
    await workflows.close();
    f.store.close();
  });
  const { reference: _reference, ...body } = f.prepareBody,
    w = await workflows.prepare(f.job.analysisId, body),
    report = await workflows.run(w.workflowId, workflowApproval(w));
  const observationId = (
    report.measurements[0]!.observations![0] as { id: string }
  ).id;
  workflows.evaluate(w.workflowId, [
    {
      observationId,
      decision: 'correct',
      source: 'human_review',
      reviewedAt: Date.now(),
    },
  ]);
  const draft = service.draft(w.workflowId, f.job.analysisId);
  const mask = f.reference.connector.mask,
    raster = decodeMaskToRaster(mask),
    runs: number[][] = [];
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width;) {
      if (!raster[y * mask.width + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < mask.width && raster[y * mask.width + x]) x++;
      runs.push([y + 40, start + 80, x + 80]);
    }
  const content: AnnotationContent = {
    ...draft.content,
    reviewer: 'Simulated human reviewer',
    source: 'human_review',
    predictionExposure: 'never_seen',
    originalImageOnly: true,
    independentAttestation: true,
    regions: {
      connector: runs as [number, number, number][],
      // Wider than the 2 px freeze band so every class keeps foreground.
      redWire: [78, 79, 80, 81, 82, 83, 84].map(
        (y) => [y, 120, 130] as [number, number, number],
      ),
      blackWire: [98, 99, 100, 101, 102, 103, 104].map(
        (y) => [y, 140, 150] as [number, number, number],
      ),
      uncertain: [],
    },
  };
  return { ...f, w, report, fake, workflows, service, content };
}
test('retrospective A evaluation preserves the original contract, independent acceptance is separate from incomplete A/B', async (t) => {
  const f = await fixture(t),
    before = canonicalHash(
      f.workflows.evidence(f.w.workflowId, f.job.analysisId),
    );
  const saved = f.service.saveDraft(f.w.workflowId, f.job.analysisId, {
      revision: 0,
      content: f.content,
    }),
    reference = f.service.freeze(
      f.w.workflowId,
      f.job.analysisId,
      saved.revision,
    );
  const result = f.service.evaluate(
    f.w.workflowId,
    f.job.analysisId,
    reference.referenceHash,
  );
  assert.equal(result.status, 'passed');
  assert.equal(result.mode, 'retrospective_diagnostic');
  assert.equal(result.abComparison, 'incomplete');
  assert.equal(result.metrics[0]!.iou, 1);
  assert.equal(result.metrics[0]!.leakage, 0);
  assert.equal(result.independentGroundTruth, true);
  assert.equal(
    canonicalHash(f.workflows.evidence(f.w.workflowId, f.job.analysisId)),
    before,
  );
  assert.equal(f.fake.calls(), 1);
  assert.doesNotThrow(() =>
    assertConnectorTerminalGate(f.store, f.store.get(f.job.analysisId)),
  );
  assert.equal(
    f.service.evaluate(
      f.w.workflowId,
      f.job.analysisId,
      reference.referenceHash,
    ).evaluationId,
    result.evaluationId,
  );
  const directory = mkdtempSync(join(tmpdir(), 'praxis-reference-export-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const archive = join(directory, 'archive'),
    manifest = exportJobEvidence(f.store, f.job.analysisId, archive),
    validation = JSON.parse(
      readFileSync(join(archive, 'connector-validation/evidence.json'), 'utf8'),
    );
  assert.deepEqual(validation.references[0], reference);
  assert.deepEqual(validation.evaluations[0], result);
  assert.ok(
    manifest.files.some(
      (file) =>
        file.path.startsWith('scene-requests/') &&
        file.path.endsWith('-response.bin'),
    ),
  );
  for (const file of manifest.files)
    assert.equal(sha256(readFileSync(join(archive, file.path))), file.sha256);
  assert.equal(
    canonicalHash(f.workflows.evidence(f.w.workflowId, f.job.analysisId)),
    before,
  );
  assert.equal(f.fake.calls(), 1);
});
test('pixel scores separately count red and black conductor leakage and exclude uncertain pixels', () => {
  const pixels = (...values: number[]) => Uint8Array.from(values),
    scores = pixelMetrics(
      pixels(1, 0, 1, 1, 1),
      pixels(1, 1, 0, 0, 0),
      pixels(0, 0, 1, 0, 0),
      pixels(0, 0, 0, 1, 0),
      pixels(0, 0, 0, 0, 1),
    );
  assert.equal(scores.iou, 1 / 4);
  assert.equal(scores.recall, 1 / 2);
  assert.equal(scores.precision, 1 / 3);
  assert.equal(scores.leakage, 2 / 3);
  assert.equal(scores.redWireLeakage, 1 / 3);
  assert.equal(scores.blackWireLeakage, 1 / 3);
  assert.equal(scores.excludedPixels, 1);
});
test('seen-before human reference receives scores but cannot claim blinded independent evidence or unlock terminals', async (t) => {
  const f = await fixture(t),
    saved = f.service.saveDraft(f.w.workflowId, f.job.analysisId, {
      revision: 0,
      content: { ...f.content, predictionExposure: 'seen_before' },
    }),
    r = f.service.freeze(f.w.workflowId, f.job.analysisId, saved.revision),
    e = f.service.evaluate(f.w.workflowId, f.job.analysisId, r.referenceHash);
  assert.equal(r.independent, false);
  assert.equal(e.blinded, false);
  assert.equal(e.independentGroundTruth, false);
  assert.equal(e.metrics[0]!.iou, 1);
  assert.equal(e.status, 'incomplete');
  assert.equal(e.metrics[0]!.accepted, false);
  assert.equal(e.metrics[0]!.scoredMask, 'native');
  assert.equal(e.metrics[0]!.raw, undefined);
  assert.equal(e.refinement, undefined);
  assert.throws(
    () =>
      f.store.requestSceneUnderstanding(f.job.analysisId, 'terminals', {
        snapshotId: f.job.scene!.snapshotRef!.snapshotId,
        snapshotHash: f.job.scene!.snapshotRef!.snapshotHash,
        objectIds: [f.w.contract.plan.objectId],
      }),
    /independent connector/,
  );
  assert.equal(
    f.store.get(f.job.analysisId).scene!.budget.terminalRequests ?? 0,
    0,
  );
  assert.equal(f.fake.calls(), 1);
  assert.throws(
    () =>
      f.service.saveDraft(f.w.workflowId, f.job.analysisId, {
        revision: saved.revision,
        content: f.content,
      }),
    /blinded status/,
  );
});
test('draft revisions reject stale writes, frozen masks reject updates, new versions preserve the old reference', async (t) => {
  const f = await fixture(t),
    a = f.service.saveDraft(f.w.workflowId, f.job.analysisId, {
      revision: 0,
      content: f.content,
    }),
    r = f.service.freeze(f.w.workflowId, f.job.analysisId, a.revision);
  assert.throws(
    () =>
      f.service.saveDraft(f.w.workflowId, f.job.analysisId, {
        revision: 0,
        content: f.content,
      }),
    /changed/,
  );
  assert.throws(
    () =>
      f.store.db
        .prepare('UPDATE connector_references SET data=? WHERE hash=?')
        .run('{}', r.referenceHash),
    /immutable/,
  );
  const b = f.service.saveDraft(f.w.workflowId, f.job.analysisId, {
      revision: a.revision,
      content: {
        ...f.content,
        boundaryDefinition:
          f.content.boundaryDefinition + ' Refined visible extent.',
      },
    }),
    r2 = f.service.freeze(f.w.workflowId, f.job.analysisId, b.revision);
  assert.equal(r2.annotationVersion, 2);
  assert.deepEqual(f.service.reference(r.referenceHash, f.w.workflowId), r);
  assert.notEqual(r2.referenceHash, r.referenceHash);
});
test('invalid overlapping or incomplete pixel references are rejected before evaluation', async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      f.service.saveDraft(f.w.workflowId, f.job.analysisId, {
        revision: 0,
        content: {
          ...f.content,
          regions: {
            ...f.content.regions,
            redWire: f.content.regions.connector,
          },
        },
      }),
    /disjoint/,
  );
  const draft = f.service.saveDraft(f.w.workflowId, f.job.analysisId, {
    revision: 0,
    content: { ...f.content, regions: { ...f.content.regions, blackWire: [] } },
  });
  assert.throws(
    () => f.service.freeze(f.w.workflowId, f.job.analysisId, draft.revision),
    /blackWire foreground/,
  );
});
test('native masks, recorded provider response and public preview must agree; stale scene evidence blocks the gate', async (t) => {
  const f = await fixture(t),
    evidence = f.workflows.evidence(f.w.workflowId, f.job.analysisId);
  assert.equal(auditConnectorEvidence(evidence).provenanceValid, true);
  const changed = structuredClone(evidence),
    report = changed.experiment!.report as {
      measurements: Array<{ observations: Array<{ mask: { path: string } }> }>;
    };
  report.measurements[0]!.observations[0]!.mask.path = 'M0 0L1 0L1 1Z';
  assert.equal(auditConnectorEvidence(changed).previewAgreement, false);
  const a = f.service.saveDraft(f.w.workflowId, f.job.analysisId, {
      revision: 0,
      content: f.content,
    }),
    r = f.service.freeze(f.w.workflowId, f.job.analysisId, a.revision);
  f.service.evaluate(f.w.workflowId, f.job.analysisId, r.referenceHash);
  const job = f.store.get(f.job.analysisId),
    graph = structuredClone(job.scene!.graph!);
  graph.objects[0]!.bbox[0] += 1;
  checkpointScene(f.store, job, graph, [], randomUUID());
  f.store.save(job);
  assert.throws(
    () => assertConnectorTerminalGate(f.store, f.store.get(f.job.analysisId)),
    /independent connector/,
  );
});
test('point audit excludes the existing A mask and annotation pixels; repeat inference is blocked before reference validation', async (t) => {
  const f = await fixture(t),
    audit = f.service.pointAudit(f.w.workflowId, f.job.analysisId);
  assert.equal(audit.eligibleEvidenceCount, 0);
  assert.equal(audit.independentBaselinePreserved, true);
  assert.equal(audit.targetingAlgorithmVersion, 'automatic-targeting-v1');
  assert.equal(audit.predictionObservationIdsExcluded.length, 1);
  const replacement = await f.workflows.prepare(f.job.analysisId, {
    objectId: f.w.contract.plan.objectId,
    snapshotId: f.job.scene!.snapshotRef!.snapshotId,
    snapshotHash: f.job.scene!.snapshotRef!.snapshotHash,
    replacementOf: f.w.workflowId,
    authorizeReplacement: true,
  });
  await assert.rejects(
    f.workflows.run(replacement.workflowId, workflowApproval(replacement)),
    /independent reference/,
  );
  assert.equal(f.fake.calls(), 1);
  assert.equal(f.workflows.get(replacement.workflowId).startingAt, null);
});
test('annotation HTTP views and saves expose no prediction geometry and terminal endpoint fails before dispatch', async (t) => {
  const f = await fixture(t),
    app = await buildApp(f.config, undefined, () => {}, undefined, {
      store: f.store,
      experimentClient: f.fake.client,
    });
  t.after(() => app.close());
  const base = `/api/analyses/${f.job.analysisId}`,
    view = await app.inject({
      method: 'GET',
      url: `${base}/connector-annotation?workflowId=${f.w.workflowId}`,
    });
  assert.equal(view.statusCode, 200);
  assert.equal(
    view.json().schemaVersion,
    'praxis-connector-annotation-view-v1',
  );
  assert.equal(view.body.includes('encodedMask'), false);
  assert.equal(view.body.includes('observations'), false);
  const save = await app.inject({
    method: 'POST',
    url: `${base}/save-connector-reference`,
    payload: {
      workflowId: f.w.workflowId,
      revision: 0,
      content: { ...f.content, predictionExposure: 'seen_before' },
    },
  });
  assert.equal(save.statusCode, 200);
  assert.equal(save.body.includes('native'), false);
  const blocked = await app.inject({
    method: 'POST',
    url: `${base}/discover-terminals`,
    payload: {
      snapshotId: f.job.scene!.snapshotRef!.snapshotId,
      snapshotHash: f.job.scene!.snapshotRef!.snapshotHash,
      objectIds: [f.w.contract.plan.objectId],
    },
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, 'CONNECTOR_SEGMENTATION_UNVALIDATED');
  assert.equal(f.fake.calls(), 1);
});
