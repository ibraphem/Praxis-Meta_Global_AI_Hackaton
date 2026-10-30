import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  continuationRegions,
  extendsCropFragment,
  type RecoveryTarget,
} from '../src/services/wire-continuation.js';
import { WireGeometry } from '../src/services/wire-geometry.js';
import { createWireRecovery } from '../src/services/wire-recovery.js';
import { recoveryPlan } from '../src/services/wire-recovery-plan.js';
import {
  cropWorkKey,
  cropWorkAttempted,
  normalizeCropAttempts,
} from '../src/services/crop-attempts.js';
import { maskEvidenceReader } from '../src/services/wire-mask-evidence.js';
import { auditWireCoverage } from '../src/services/wire-coverage.js';
import { shortWireRegions } from '../src/services/short-wire-recovery.js';
import { partialAnalysis } from '../src/services/partial-analysis.js';
import { reconcileWireSelection } from '../src/services/wire-selection.js';
import { snapshotHash, type SnapshotRef } from '../src/jobs/snapshots.js';
import { supportsSpatialPrompt } from '../src/services/wire-fragments.js';
import type { Candidate } from '../src/schemas/vision.js';
import type { CropAttempt } from '../src/schemas/wire-recovery.js';
import type { SamSnapshot } from '../src/services/vision.js';
import type { EncodedMask } from '../src/schemas/geometry.js';
import { prepareImage } from '../src/services/image.js';
import { imageBytes, samEnvelope, testConfig } from './helpers.js';

const masks = JSON.parse(
  readFileSync(
    new URL('./fixtures/continuation-masks.json', import.meta.url),
    'utf8',
  ),
) as Record<string, EncodedMask>;
function fragment(): Candidate & {
  cropOrigin: [number, number, number, number];
} {
  return {
    id: 'jumper_wire_1',
    type: 'jumper_wire',
    bbox: [110, 130, 90, 10],
    encodedMask: masks.fragment!,
    cropOrigin: [100, 100, 100, 80],
  };
}
function extension(): Candidate & {
  cropOrigin: [number, number, number, number];
} {
  return {
    ...fragment(),
    id: 'jumper_wire_2',
    bbox: [110, 130, 150, 10],
    encodedMask: masks.extended!,
    cropOrigin: [50, 80, 280, 160],
  };
}
function ref(snapshot: SamSnapshot, parent?: SnapshotRef): SnapshotRef {
  const context = {
    imageHash: 'a'.repeat(64),
    model: 'sam',
    processingVersion: 'test',
  };
  return {
    ...context,
    samSnapshotId: randomUUID(),
    samSnapshotHash: snapshotHash(snapshot, context),
    sourceAttemptId: randomUUID(),
    createdAt: 1,
    origin: 'recorded',
    ...(parent ? { parentSnapshotId: parent.samSnapshotId } : {}),
  };
}
const budget = () => ({
  requests: 0,
  pixels: 0,
  verificationRequests: 0,
  rounds: 0,
});
const prompt = (t: RecoveryTarget) => ({
  bbox: t.bbox,
  positivePoints: t.positivePoints,
  negativePoints: t.negativePoints,
});
function attempt(
  t: RecoveryTarget,
  status: CropAttempt['status'] = 'timed_out',
): CropAttempt {
  return {
    attemptId: randomUUID(),
    region: t.crop,
    workKeys: [cropWorkKey(t.crop, prompt(t))],
    spatialPrompt: prompt(t),
    mode: t.mode,
    status,
    upstreamOutcome: 'unknown',
    startedAt: 1,
  };
}

test('continuation needs native shared pixels and genuine growth beyond the old crop, never a crossing, parallel wire or subset', () => {
  assert.equal(extendsCropFragment(fragment(), extension()), true);
  assert.equal(
    extendsCropFragment(fragment(), {
      ...extension(),
      bbox: [110, 132, 150, 10],
    }),
    false,
  );
  assert.equal(
    extendsCropFragment(fragment(), {
      ...extension(),
      bbox: [150, 90, 10, 150],
    }),
    false,
  );
  assert.equal(extendsCropFragment(extension(), fragment()), false);
  assert.equal(
    extendsCropFragment(
      { ...fragment(), cropOrigin: [0, 0, 400, 300] },
      extension(),
    ),
    false,
  );
  assert.equal(
    extendsCropFragment(fragment(), extension(), maskEvidenceReader(1)),
    false,
  );
});

test('supported longer observations survive geometry dedup in either order; ordinary duplicates still reject', () => {
  for (const pair of [
    [fragment(), extension()],
    [extension(), fragment()],
  ]) {
    const g = new WireGeometry({ width: 400, height: 300 });
    assert.equal(g.resolve(pair[0]!).ok, true);
    assert.equal(g.resolve(pair[1]!).ok, true);
    assert.deepEqual(g.resolve(pair[1]!), {
      ok: false,
      reason: 'duplicate_mask',
    });
  }
});

test('continuation planning anchors observed insulation, includes prior crop exits, honors native pixel budget and stops once a whole extension exists', async () => {
  const snapshot = {
    image: await prepareImage(await imageBytes(400, 300), testConfig()),
    candidates: [fragment()],
  };
  const report = await auditWireCoverage(snapshot, ref(snapshot));
  // Preview exhaustion must not make existing raw mask evidence unrecoverable.
  delete report.candidates[0]!.mask;
  const targets = continuationRegions(snapshot, report, 2_000_000);
  assert.equal(targets.length, 1);
  const t = targets[0]!;
  assert.equal(t.candidateId, 'jumper_wire_1');
  assert.ok(t.positivePoints.length >= 1);
  assert.ok(supportsSpatialPrompt(fragment(), t.positivePoints, []));
  assert.ok(t.crop[0] + t.crop[2] > 200 + 8);
  assert.deepEqual(continuationRegions(snapshot, report, 20), []);
  const completed = { ...snapshot, candidates: [fragment(), extension()] };
  const audited = await auditWireCoverage(completed, ref(completed));
  assert.deepEqual(continuationRegions(completed, audited, 2_000_000), []);
  assert.ok(
    audited.hypotheses.some(
      (h) => h.kind === 'mask_extension_proposal' && h.status === 'unverified',
    ),
  );
  assert.equal(audited.candidates[0]!.touchesCropBoundary, true);
  assert.equal(audited.candidates[1]!.geometryAccepted, true);
});

test('same-crop objects batch with distinct durable work keys; timeout blocks identical seeds across checkpoints, not new targets', () => {
  const a: RecoveryTarget = {
    crop: [0, 0, 100, 100],
    bbox: [10, 20, 30, 10],
    positivePoints: [[15, 24]],
    negativePoints: [],
    mode: 'short',
  };
  const b = {
    ...a,
    bbox: [10, 50, 30, 10] as [number, number, number, number],
    positivePoints: [[15, 54]] as [number, number][],
  };
  const c = {
    ...a,
    mode: 'continuation' as const,
    candidateId: 'jumper_wire_1',
  };
  const plan = recoveryPlan([c], [a, b], [[200, 100, 100, 100]], []);
  assert.deepEqual(
    plan.map((w) => w.mode),
    ['continuation', 'short', 'tiles'],
  );
  assert.equal(plan[1]!.targets.length, 2);
  assert.notEqual(plan[1]!.workKeys[0], plan[1]!.workKeys[1]);
  const old = attempt(a);
  assert.equal(cropWorkAttempted([old], a.crop, prompt(a)), true);
  const remaining = recoveryPlan([], [a, b], [], [old]);
  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0]!.targets, [b]);
  // Old spatial records also have exact-target semantics, even without new work keys.
  delete old.workKeys;
  assert.deepEqual(recoveryPlan([], [a, b], [], [old])[0]!.targets, [b]);
  const unknown = normalizeCropAttempts([a.crop]);
  assert.deepEqual(recoveryPlan([], [a, b], [], unknown), []);
});

test('native short-wire search retains a trace inside another mask bounding box and reaches late board regions', async () => {
  const width = 1200,
    height = 800,
    rgb = Buffer.alloc(width * height * 3, 255);
  // Many earlier component regions used to consume the first twelve scan slots.
  const components: Candidate[] = Array.from({ length: 10 }, (_, i) => ({
    id: `resistor_${i + 1}`,
    type: 'resistor',
    bbox: [20 + (i % 5) * 150, 20 + Math.floor(i / 5) * 180, 40, 40],
  }));
  for (let x = 1010; x < 1040; x++)
    for (let y = 690; y < 693; y++) {
      const i = (y * width + x) * 3;
      rgb[i] = 210;
      rgb[i + 1] = 20;
      rgb[i + 2] = 20;
    }
  const bytes = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  const snapshot: SamSnapshot = {
    image: await prepareImage(bytes, testConfig()),
    candidates: [
      ...components,
      { id: 'breadboard_1', type: 'breadboard', bbox: [0, 0, width, height] },
      {
        ...fragment(),
        bbox: [900, 600, 250, 150],
        cropOrigin: [0, 0, width, height],
      },
    ],
  };
  const report = await auditWireCoverage(snapshot, ref(snapshot));
  const regions = await shortWireRegions(snapshot, report, {
    pitchPx: 10,
    gridPoints: [],
  });
  assert.ok(
    regions.some((r) =>
      r.positivePoints.some(
        ([x, y]) => x >= 1010 && x < 1040 && y >= 688 && y <= 695,
      ),
    ),
    JSON.stringify(regions),
  );
});

test('recovery prioritizes continuation without Muse, preserves original snapshot and stable selectable IDs, and flags the new whole mask for review', async () => {
  const config = testConfig(),
    snapshot: SamSnapshot = {
      image: await prepareImage(await imageBytes(400, 300), config),
      candidates: [fragment()],
    },
    reference = ref(snapshot);
  const before = JSON.stringify(snapshot),
    old = {
      ...partialAnalysis(snapshot, config),
      provenance: {
        ...partialAnalysis(snapshot, config).provenance,
        samSnapshotId: reference.samSnapshotId,
        samSnapshotHash: reference.samSnapshotHash,
      },
    };
  let saved: SnapshotRef | undefined,
    calls = 0;
  const result = await createWireRecovery(config, {
    async post(_path, body, _signal, options) {
      calls++;
      assert.equal(options!.maxRetries, 0);
      assert.equal(options!.stage, 'sam.wire_crop');
      const image = options!.imageDimensions![0]!;
      const report = await auditWireCoverage(snapshot, reference),
        t = continuationRegions(
          snapshot,
          report,
          config.WIRE_RECOVERY_MAX_CROP_PIXELS,
        )[0]!;
      assert.match(JSON.stringify(body.input), /<0f>1/);
      const x = 110 - t.crop[0],
        y = 130 - t.crop[1],
        m = masks.extended!;
      return samEnvelope(
        `<0f>1<|box;x1=${x};y1=${y};x2=${x + 149};y2=${y + 9};w=${image.width};h=${image.height}|><|mask;x=0;y=0;data=${m.height},${m.width},${m.payload}|>`,
      );
    },
  })(
    {
      snapshot,
      ref: reference,
      reviews: [],
      budget: budget(),
      visited: [],
      operation: 'recover',
    },
    new AbortController().signal,
    undefined,
    (value) => {
      if (value.changed) {
        saved = ref(value.snapshot, reference);
        return saved;
      }
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.cropAttempts[0]!.mode, 'continuation');
  assert.equal(result.cropAttempts[0]!.status, 'succeeded');
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(result.snapshot.candidates.length, 2);
  const raw = {
    ...partialAnalysis(result.snapshot, config),
    provenance: {
      ...partialAnalysis(result.snapshot, config).provenance,
      samSnapshotId: saved!.samSnapshotId,
      samSnapshotHash: saved!.samSnapshotHash,
    },
  };
  assert.equal(raw.objects.length, 2);
  const selected = reconcileWireSelection(old, raw, {
    observationOnly: true,
    previousAttemptId: reference.sourceAttemptId,
    currentAttemptId: saved!.sourceAttemptId,
    previousRef: reference,
    currentRef: saved!,
    getRef: () => reference,
  });
  assert.equal(selected.objects[0]!.id, 'jumper_wire_1');
  assert.equal(selected.objects[0]!.touchesCropBoundary, true);
  assert.equal(selected.objects[1]!.touchesCropBoundary, false);
  assert.equal(selected.objects[1]!.selectionEvidence!.requiresReview, true);
  assert.ok(
    selected.objects.every(
      (c) => c.identityStatus === 'unverified' && !c.guidanceEligible,
    ),
  );
  assert.ok(
    result.report.hypotheses.some((h) => h.kind === 'mask_extension_proposal'),
  );
});

test('a batched SAM response uses each returned object ID and its own spatial seeds, retaining mismatches as rejected evidence', async () => {
  const width = 400,
    height = 300,
    rgb = Buffer.alloc(width * height * 3, 255);
  for (const y0 of [120, 145])
    for (let x = 140; x < 170; x++)
      for (let y = y0; y < y0 + 3; y++) {
        const i = (y * width + x) * 3;
        rgb[i] = 210;
        rgb[i + 1] = 20;
        rgb[i + 2] = 20;
      }
  const bytes = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  for (const mismatch of [false, true]) {
    const snapshot: SamSnapshot = {
        image: await prepareImage(bytes, testConfig()),
        candidates: [],
      },
      reference = ref(snapshot);
    const audited = await auditWireCoverage(snapshot, reference);
    const targets = await shortWireRegions(snapshot, audited, {
      pitchPx: 10,
      gridPoints: [[150, 130]],
    });
    const plan = recoveryPlan(
      [],
      targets.map((t) => ({ ...t, mode: 'short' as const })),
      [],
      [],
    );
    assert.equal(plan[0]!.targets.length, 2);
    let calls = 0;
    const result = await createWireRecovery(
      { ...testConfig(), WIRE_RECOVERY_REQUESTS_PER_ROUND: 1 },
      {
        async post(_path, body, _signal, options) {
          calls++;
          const text = (body.input as { content: { text: string }[] }[])[0]!
            .content[0]!.text;
          assert.match(text, /,2<\|box/);
          const crop = plan[0]!.crop,
            dim = options!.imageDimensions![0]!,
            m = masks.short!;
          const records = plan[0]!.targets.map((t, i) => {
            const seedY = t.positivePoints[0]![1];
            const globalY = seedY < 135 ? 116 : 141;
            const x = 140 - crop[0],
              y = globalY - crop[1] + (mismatch && i === 1 ? 10 : 0);
            return `${i + 1}<|box;x1=${x};y1=${y};x2=${x + 29};y2=${y + 9};w=${dim.width};h=${dim.height}|><|mask;x=0;y=0;data=${m.height},${m.width},${m.payload}|>`;
          });
          // Response order is deliberately reversed: array position cannot identify the selected object.
          return samEnvelope('<0f>' + records.reverse().join(','));
        },
      },
    )(
      {
        snapshot,
        ref: reference,
        reviews: [],
        budget: budget(),
        visited: [],
        operation: 'recover_short',
        target: { pitchPx: 10, gridPoints: [[150, 130]] },
      },
      new AbortController().signal,
      undefined,
      (value) => (value.changed ? ref(value.snapshot, reference) : undefined),
    );
    assert.equal(calls, 1);
    assert.equal(result.budget.requests, 1);
    assert.equal(result.cropAttempts[0]!.workKeys!.length, 2);
    assert.equal(result.cropAttempts[0]!.spatialPrompts!.length, 2);
    assert.equal(result.snapshot.candidates.length, 2);
    assert.equal(
      partialAnalysis(result.snapshot, testConfig()).objects.length,
      mismatch ? 1 : 2,
    );
    if (mismatch)
      assert.ok(
        result.report.candidates.some((c) =>
          c.rejectionReasons.includes('prompt_mismatch'),
        ),
      );
  }
});

test('old rejected masks cannot starve a seed-validated new mask of the existing geometry and preview quotas', async () => {
  const config = testConfig(),
    image = await prepareImage(await imageBytes(400, 300), config);
  const rejected: Candidate[] = Array.from({ length: 3 }, (_, i) => ({
    id: `jumper_wire_${i + 1}`,
    type: 'jumper_wire',
    bbox: [0, 0, 400, 300],
    encodedMask: masks.large_empty!,
  }));
  const observed = {
    ...extension(),
    id: 'jumper_wire_4',
    recoveryPromptMatched: true,
  };
  const snapshot = { image, candidates: [...rejected, observed] },
    original = JSON.stringify(snapshot);
  const view = partialAnalysis(snapshot, config),
    report = await auditWireCoverage(snapshot, ref(snapshot));
  assert.ok(view.objects.some((c) => c.id === observed.id && c.mask));
  assert.equal(
    report.candidates.find((c) => c.id === observed.id)!.geometryAccepted,
    true,
  );
  assert.ok(report.candidates.find((c) => c.id === observed.id)!.mask);
  assert.equal(
    JSON.stringify(snapshot),
    original,
    'priority changes derived work order only',
  );
});
