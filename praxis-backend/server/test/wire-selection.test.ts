import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  reconcileWireSelection,
  wireEvidenceHash,
} from '../src/services/wire-selection.js';
import {
  analysisSchema,
  type Analysis,
  type Component,
} from '../src/schemas/vision.js';
import type { SnapshotRef } from '../src/jobs/snapshots.js';
import { JobStore } from '../src/jobs/store.js';
import { AnalysisWorker } from '../src/jobs/worker.js';
import { imageBytes, testConfig } from './helpers.js';
import { prepareImage } from '../src/services/image.js';
const imageHash = 'a'.repeat(64);
const ref = (parent?: SnapshotRef): SnapshotRef => ({
  samSnapshotId: randomUUID(),
  samSnapshotHash: randomUUID().replaceAll('-', '').repeat(2),
  imageHash,
  model: 'sam',
  processingVersion: 'test',
  sourceAttemptId: randomUUID(),
  createdAt: 1,
  origin: 'recorded',
  ...(parent ? { parentSnapshotId: parent.samSnapshotId } : {}),
});
const wire = (id: number, x = 20): Component => ({
  id: `jumper_wire_${id}`,
  type: 'jumper_wire',
  bbox: [x, 20, 100, 40],
  color: 'red',
  mask: {
    format: 'svg_path',
    width: 100,
    height: 40,
    path: 'M0 15L100 15L100 18L0 18Z',
  },
  interpretation: 'confirmed',
  localizationSource: 'sam',
  geometryStatus: 'segmented',
  guidanceEligible: false,
  identityStatus: 'unverified',
});
function analysis(r: SnapshotRef, objects: Component[]): Analysis {
  return analysisSchema.parse({
    image: { width: 1000, height: 600 },
    objects,
    provenance: {
      mode: 'combined',
      reasoningModel: 'mock',
      segmentationModel: 'sam',
      samSnapshotId: r.samSnapshotId,
      samSnapshotHash: r.samSnapshotHash,
    },
  });
}
function fixture() {
  const old = ref(),
    next = ref(old);
  const refs = [old, next];
  return {
    old,
    next,
    context: {
      previousAttemptId: randomUUID(),
      currentAttemptId: randomUUID(),
      previousRef: old,
      currentRef: next,
      getRef: (id: string) => refs.find((r) => r.samSnapshotId === id)!,
    },
  };
}
test('omitted masks survive and exact evidence keeps stable IDs despite fresh Muse renumbering', () => {
  const f = fixture(),
    before = analysis(f.old, [wire(1), wire(2, 300)]),
    raw = analysis(f.next, [wire(1, 300), wire(2, 600)]);
  const original = JSON.stringify({ before, raw });
  const selected = reconcileWireSelection(before, raw, f.context);
  assert.deepEqual(
    selected.objects.map((c) => c.id),
    ['jumper_wire_1', 'jumper_wire_2', 'jumper_wire_3'],
  );
  assert.deepEqual(selected.objects[0]!.mask, before.objects[0]!.mask);
  assert.equal(selected.objects[0]!.selectionEvidence!.state, 'retained');
  assert.equal(selected.objects[0]!.selectionEvidence!.requiresReview, true);
  assert.equal(selected.objects[0]!.interpretation, 'uncertain');
  assert.equal(
    selected.objects[1]!.selectionEvidence!.latestObjectId,
    'jumper_wire_1',
  );
  assert.ok(
    selected.objects.every(
      (c) => c.identityStatus === 'unverified' && c.guidanceEligible === false,
    ),
  );
  assert.equal(JSON.stringify({ before, raw }), original);
});
test('changed geometry is a separate hypothesis and overlapping evidence is flagged, never merged or given an old identity', () => {
  const f = fixture(),
    before = analysis(f.old, [wire(1)]),
    raw = analysis(f.next, [
      {
        ...wire(1),
        mask: { ...wire(1).mask!, path: 'M0 16L100 16L100 20L0 20Z' },
      },
    ]);
  const selected = reconcileWireSelection(before, raw, f.context);
  assert.equal(selected.objects.length, 2);
  assert.equal(selected.objects[1]!.id, 'jumper_wire_2');
  assert.ok(
    selected.objects.every((c) =>
      c.selectionEvidence!.reasons.includes('overlapping_hypothesis'),
    ),
  );
  assert.ok(selected.objects.every((c) => c.selectionEvidence!.requiresReview));
});
test('semantic disagreements persist across later confirmations and crop-boundary evidence is never cleared by matching geometry', () => {
  const f = fixture(),
    c = {
      ...wire(1),
      cropOrigin: [0, 0, 140, 100] as [number, number, number, number],
      touchesCropBoundary: true,
    };
  const before = analysis(f.old, [c]),
    raw = analysis(f.next, [{ ...c, color: 'blue' }]);
  const selected = reconcileWireSelection(before, raw, f.context);
  assert.equal(selected.objects[0]!.touchesCropBoundary, true);
  assert.ok(
    selected.objects[0]!.selectionEvidence!.reasons.includes(
      'changed_interpretation',
    ),
  );
  const again = reconcileWireSelection(selected, raw, {
    ...f.context,
    previousRef: f.next,
  });
  assert.equal(again.objects[0]!.selectionEvidence!.requiresReview, true);
});
test('unrelated SAM roots and different images do not inherit earlier selectable identities', () => {
  const f = fixture(),
    before = analysis(f.old, [wire(1)]),
    raw = analysis(f.next, []);
  const unrelated = { ...f.next };
  delete unrelated.parentSnapshotId;
  assert.deepEqual(
    reconcileWireSelection(before, raw, {
      ...f.context,
      currentRef: unrelated,
    }),
    raw,
  );
  assert.deepEqual(
    reconcileWireSelection(before, raw, {
      ...f.context,
      currentRef: { ...f.next, imageHash: 'b'.repeat(64) },
    }),
    raw,
  );
});
test('output budgets defer new candidates instead of evicting previous masks', () => {
  const f = fixture(),
    before = analysis(
      f.old,
      Array.from({ length: 100 }, (_, i) => wire(i + 1, (i % 9) * 100)),
    ),
    raw = analysis(f.next, [wire(1, 800)]);
  // Distinguish each observation without making the path budget artificial.
  before.objects.forEach((c, i) => {
    c.bbox[1] = 20 + Math.floor(i / 9) * 40;
  });
  raw.objects[0]!.bbox[1] = 540;
  const selected = reconcileWireSelection(before, raw, f.context);
  assert.equal(selected.objects.length, 100);
  assert.deepEqual(selected.provenance.wireSelection!.deferredObjectIds, [
    'jumper_wire_1',
  ]);
  assert.ok(selected.objects.every((c, i) => c.id === before.objects[i]!.id));
});
const archived = JSON.parse(
  readFileSync(
    new URL('./fixtures/phase3-wire-selection.json', import.meta.url),
    'utf8',
  ),
) as {
  before: Analysis;
  after: Analysis;
  beforeAttemptId: string;
  afterAttemptId: string;
  refs: SnapshotRef[];
};
test('replay of the actual Phase 3 masks retains all 14 prior hypotheses and adds three without losing white/yellow masks or clearing green/blue crop boundaries', () => {
  const before = analysisSchema.parse(archived.before),
    raw = analysisSchema.parse(archived.after);
  const getRef = (id: string) =>
    archived.refs.find((r) => r.samSnapshotId === id)!;
  const selected = reconcileWireSelection(before, raw, {
    previousAttemptId: archived.beforeAttemptId,
    currentAttemptId: archived.afterAttemptId,
    previousRef: getRef(before.provenance.samSnapshotId!),
    currentRef: getRef(raw.provenance.samSnapshotId!),
    getRef,
  });
  assert.equal(
    selected.objects.filter((c) => c.type === 'jumper_wire').length,
    17,
  );
  assert.equal(selected.provenance.wireSelection!.matched, 7);
  assert.equal(selected.provenance.wireSelection!.retained, 7);
  assert.equal(selected.provenance.wireSelection!.added, 3);
  for (const id of ['jumper_wire_10', 'jumper_wire_11']) {
    const old = before.objects.find((c) => c.id === id)!;
    const kept = selected.objects.find((c) => c.id === id)!;
    assert.deepEqual(kept.mask, old.mask);
    assert.deepEqual(kept.bbox, old.bbox);
    assert.equal(kept.selectionEvidence!.state, 'retained');
  }
  assert.equal(
    selected.objects.filter((c) => c.touchesCropBoundary).length,
    raw.objects.filter((c) => c.touchesCropBoundary).length,
  );
});
test('historical successful attempts restore already-lost masks while preserving the latest orange wire ID', () => {
  const previous = analysisSchema.parse(archived.after);
  const getRef = (id: string) =>
    archived.refs.find((r) => r.samSnapshotId === id)!;
  const latestRef = getRef(previous.provenance.samSnapshotId!);
  const restored = reconcileWireSelection(previous, previous, {
    previousAttemptId: archived.afterAttemptId,
    currentAttemptId: randomUUID(),
    previousRef: latestRef,
    currentRef: latestRef,
    getRef,
    historical: [
      {
        analysis: analysisSchema.parse(archived.before),
        attemptId: archived.beforeAttemptId,
        ref: getRef(archived.before.provenance.samSnapshotId!),
      },
    ],
  });
  assert.equal(restored.provenance.wireSelection!.restoredHistorical, 7);
  assert.equal(
    restored.objects.filter((c) => c.type === 'jumper_wire').length,
    17,
  );
  for (const current of previous.objects.filter(
    (c) => c.type === 'jumper_wire',
  )) {
    assert.equal(
      wireEvidenceHash(
        restored.objects.find((c) => c.id === current.id)!,
        latestRef.imageHash,
      ),
      wireEvidenceHash(current, latestRef.imageHash),
    );
  }
  assert.deepEqual(
    restored.objects.find((c) => c.id === 'jumper_wire_9')!.bbox,
    [635, 1630, 522, 75],
  );
  assert.ok(
    restored.objects
      .filter((c) => c.selectionEvidence?.state === 'retained')
      .every((c) => c.selectionEvidence!.requiresReview),
  );
});
test('worker publishes reconciled evidence and keeps unmodified raw predictions in historical attempts', async (t) => {
  const config = testConfig(),
    store = new JobStore(config, ':memory:');
  const bytes = await imageBytes(1000, 600),
    image = await prepareImage(bytes, config);
  let calls = 0;
  const worker = new AnalysisWorker(store, config, () => undefined, {
    async segment() {
      return { image, candidates: [] };
    },
    async interpret() {
      calls++;
      return {
        image: { width: 1000, height: 600 },
        objects:
          calls === 1
            ? [wire(1)]
            : calls === 2
              ? []
              : Array.from({ length: 100 }, (_, i) => ({
                  id: `led_${i + 1}`,
                  type: 'led' as const,
                  bbox: [10, 10, 10, 10] as [number, number, number, number],
                  interpretation: 'uncertain' as const,
                  localizationSource: 'sam' as const,
                  geometryStatus: 'box_only' as const,
                  guidanceEligible: false as const,
                })),
        provenance: { mode: 'combined', reasoningModel: 'mock' },
      };
    },
  });
  t.after(async () => {
    await worker.close();
    store.close();
  });
  const id = store.create(bytes, image).analysisId;
  worker.start();
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (condition()) return;
      await delay(10);
    }
    assert.fail('Worker did not settle');
  };
  await until(() => store.get(id).status === 'completed');
  const first = JSON.stringify(store.get(id).muse.attempts[0]!.result);
  const audited = store.get(id);
  audited.recovery.snapshotRef = audited.sam.snapshotRef!;
  store.save(audited);
  store.interpretRecovery(id);
  worker.tick();
  await until(() => store.get(id).muse.status === 'succeeded');
  const saved = store.get(id);
  assert.equal(calls, 2);
  assert.equal(saved.muse.result!.objects.length, 1);
  assert.equal(
    saved.muse.result!.objects[0]!.selectionEvidence!.state,
    'retained',
  );
  assert.equal(saved.muse.attempts[1]!.result!.objects.length, 0);
  assert.equal(JSON.stringify(saved.muse.attempts[0]!.result), first);
  const published = JSON.stringify(saved.muse.result);
  store.interpretRecovery(id);
  worker.tick();
  await until(() => store.get(id).muse.status === 'failed');
  const blocked = store.get(id);
  assert.equal(blocked.muse.attempts[2]!.errorCode, 'WIRE_SELECTION_BUDGET');
  assert.equal(blocked.muse.attempts[2]!.result!.objects.length, 100);
  assert.equal(JSON.stringify(blocked.muse.result), published);
  assert.equal(blocked.muse.resultAttemptId, saved.muse.resultAttemptId);
});
