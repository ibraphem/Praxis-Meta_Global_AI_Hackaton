import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { prepareImage } from '../src/services/image.js';
import { auditWireCoverage } from '../src/services/wire-coverage.js';
import { evaluateWires } from '../src/services/wire-evaluation.js';
import { snapshotHash } from '../src/jobs/snapshots.js';
import { imageBytes, testConfig, maskFixture } from './helpers.js';
async function fixture() {
  const image = await prepareImage(await imageBytes(600, 400), testConfig());
  const snapshot = {
    image,
    candidates: [30, 230, 430].map((x, i) => ({
      id: `jumper_wire_${i + 1}`,
      type: 'jumper_wire' as const,
      bbox: [x, 30, 100, 100] as [number, number, number, number],
      encodedMask: maskFixture('wire'),
    })),
  };
  const ref = {
    samSnapshotId: randomUUID(),
    imageHash: 'a'.repeat(64),
    model: 'sam',
    processingVersion: 'test',
    sourceAttemptId: randomUUID(),
    createdAt: 1,
    origin: 'recorded' as const,
  };
  const report = await auditWireCoverage(snapshot, {
    ...ref,
    samSnapshotHash: snapshotHash(snapshot, ref),
  });
  report.candidates.find((c) => c.id === 'jumper_wire_3')!.touchesCropBoundary =
    true;
  const truth = {
    version: 'wire-truth-v1',
    imageHash: ref.imageHash,
    recordedBeforeInference: true,
    completeInventory: true,
    wires: Array.from({ length: 17 }, (_, i) => ({
      id: `physical_${i + 1}`,
      endpoints: [0, 1].map((n) => ({
        visibility: 'visible',
        holeId: `board:a${i * 2 + n + 1}`,
        position: [30 + i * 10, 30 + n * 50],
      })),
    })),
  };
  const evaluation = {
    version: 'wire-evaluation-v1',
    imageHash: ref.imageHash,
    reportId: report.reportId,
    sourceSnapshotHash: report.sourceSnapshotHash,
    selectableCandidateIds: ['jumper_wire_1', 'jumper_wire_2', 'jumper_wire_3'],
    groups: report.candidates.map((c) => ({
      candidateIds: [c.id],
      truthWireId: c.id.startsWith('jumper_wire_')
        ? `physical_${c.id.split('_').at(-1)}`
        : null,
      matchKind:
        c.id === 'jumper_wire_2'
          ? 'fragment'
          : c.id.startsWith('jumper_wire_')
            ? 'whole_wire'
            : 'clutter',
      identityAccepted: c.id === 'jumper_wire_1' || c.id === 'jumper_wire_3',
      endpoints: [0, 1].map(() => ({
        holeId: null,
        position: null,
        accepted: false,
      })),
    })),
  };
  return { report, truth, evaluation };
}
const provenance = (source = 'human_visual') => ({
  source,
  reviewer: 'independent benchmark reviewer',
  recordedAt: '2026-01-01T00:00:00Z',
});
test('mask counts, partial trace coverage, complete segmentation and independent identity confirmation remain distinct over 17 wires', async () => {
  const { report, truth, evaluation } = await fixture();
  const score = evaluateWires(report, truth.imageHash, truth, evaluation);
  assert.equal(score.version, 'wire-score-v3');
  assert.equal(score.metrics.physicalWires, 17);
  assert.equal(score.metrics.selectableMaskCandidates, 3);
  assert.equal(score.metrics.selectablePhysicalWires, 3);
  assert.equal(score.metrics.selectablePhysicalWireCoverage, 3 / 17);
  assert.equal(score.metrics.fragmentGroups, 1);
  assert.equal(score.metrics.cropTruncatedMaskCandidates, 1);
  assert.equal(score.metrics.selectableCropTruncatedMasks, 1);
  assert.equal(score.metrics.completeSegmentationWires, 1);
  assert.equal(score.metrics.completeSegmentationCoverage, 1 / 17);
  assert.equal(score.metrics.correctAcceptedIdentityCoverage, 2 / 17);
  assert.equal(score.metrics.confirmedPhysicalWireCoverage, null);
  const confirmed = evaluateWires(
    report,
    truth.imageHash,
    { ...truth, reviewProvenance: provenance() },
    { ...evaluation, reviewProvenance: provenance() },
  );
  assert.equal(confirmed.metrics.confirmedPhysicalWires, 2);
  assert.equal(confirmed.metrics.confirmedPhysicalWireCoverage, 2 / 17);
  assert.equal(
    confirmed.verificationEvidence.nativeIdentityLedgerUpdated,
    false,
  );
});
test('duplicates cannot inflate physical coverage or confirmed identities even when one competing group is not accepted', async () => {
  const { report, truth, evaluation } = await fixture();
  report.candidates.push({
    ...report.candidates.find((c) => c.id === 'jumper_wire_1')!,
    id: 'jumper_wire_4',
    geometryAccepted: false,
  });
  report.summary.rawSamCandidates++;
  evaluation.selectableCandidateIds.push('jumper_wire_4');
  evaluation.groups.push({
    ...evaluation.groups.find((g) => g.candidateIds[0] === 'jumper_wire_1')!,
    candidateIds: ['jumper_wire_4'],
    identityAccepted: false,
  });
  const score = evaluateWires(
    report,
    truth.imageHash,
    { ...truth, reviewProvenance: provenance() },
    { ...evaluation, reviewProvenance: provenance() },
  );
  assert.equal(score.metrics.selectableMaskCandidates, 4);
  assert.equal(score.metrics.selectablePhysicalWires, 3);
  assert.equal(score.metrics.duplicateGroups, 1);
  assert.equal(score.metrics.confirmedPhysicalWires, 1);
  assert.equal(score.metrics.correctAcceptedIdentities, 1);
});
test('assistant-only annotation and absent selectable mapping stay explicitly unknown; invalid mappings fail closed', async () => {
  const { report, truth, evaluation } = await fixture();
  const assistant = evaluateWires(
    report,
    truth.imageHash,
    { ...truth, reviewProvenance: provenance('assistant_visual') },
    { ...evaluation, reviewProvenance: provenance() },
  );
  assert.equal(assistant.metrics.confirmedPhysicalWires, null);
  assert.equal(
    assistant.verificationEvidence.truthReview!.source,
    'assistant_visual',
  );
  const { selectableCandidateIds: _selection, ...withoutSelection } =
    evaluation;
  assert.equal(
    evaluateWires(report, truth.imageHash, truth, withoutSelection).metrics
      .selectableMaskCandidates,
    null,
  );
  assert.equal(
    evaluateWires(report, truth.imageHash, truth, {
      ...evaluation,
      selectableCandidateIds: [],
    }).metrics.selectableMaskCandidates,
    0,
  );
  assert.throws(
    () =>
      evaluateWires(report, truth.imageHash, truth, {
        ...evaluation,
        selectableCandidateIds: ['jumper_wire_999'],
      }),
    /Selectable candidate IDs/,
  );
});
