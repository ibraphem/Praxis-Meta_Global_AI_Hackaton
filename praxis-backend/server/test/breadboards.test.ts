import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consolidateBreadboards } from '../src/services/breadboards.js';
import {
  analysisSchema,
  type Candidate,
  type BoundingBox,
} from '../src/schemas/vision.js';
import { createVisionService, deduplicate } from '../src/services/vision.js';
import {
  completion,
  imageBytes,
  queuedClient,
  samEnvelope,
  testConfig,
} from './helpers.js';

const candidates: Candidate[] = [
  [10, 10, 80, 6],
  [10, 16, 80, 20],
  [10, 36, 80, 20],
  [10, 56, 80, 6],
].map((bbox, i) => ({
  id: `breadboard_${i + 1}`,
  type: 'breadboard',
  bbox: bbox as BoundingBox,
  confidence: 0.8 + i * 0.01,
  localizationSource: 'sam',
}));
const decisions = candidates.map((c) => ({
  id: c.id,
  decision: 'confirmed' as const,
  color: 'white',
}));
const review = {
  breadboardCandidates: candidates.map((c) => ({
    id: c.id,
    extent: 'part' as const,
  })),
  breadboardGroups: [
    {
      candidateIds: candidates.map((c) => c.id),
      wholeCandidateId: null as string | null,
      decision: 'confirmed' as 'confirmed' | 'uncertain',
    },
  ],
};
function envelope(value: ReturnType<typeof consolidateBreadboards>) {
  return {
    image: { width: 100, height: 80 },
    objects: value.boards.map((b, i) => ({ ...b, id: `breadboard_${i + 1}` })),
    breadboardAudit: value.audit,
    provenance: {
      mode: 'combined',
      reasoningModel: 'test',
      segmentationModel: 'test',
    },
  };
}

test('four accepted strip/rail regions consolidate into one board without a fabricated score or geometry mutation', () => {
  const before = JSON.stringify(candidates);
  const value = consolidateBreadboards(candidates, decisions, review);
  assert.equal(value.boards.length, 1);
  assert.deepEqual(value.boards[0]!.bbox, [10, 10, 80, 52]);
  assert.equal(value.boards[0]!.localizationSource, 'derived');
  assert.equal(value.boards[0]!.confidence, undefined);
  assert.equal(value.audit.candidates.length, 4);
  assert.deepEqual(value.audit.unresolvedCandidateIds, []);
  assert.equal(JSON.stringify(candidates), before);
  assert.equal(analysisSchema.safeParse(envelope(value)).success, true);
});

test('an existing whole-board region supplies geometry and its own SAM score; parts are not counted again', () => {
  const whole: Candidate = {
    id: 'breadboard_5',
    type: 'breadboard',
    bbox: [9, 9, 82, 54],
    confidence: 0.92,
  };
  const raw = [...candidates, whole];
  const value = consolidateBreadboards(
    raw,
    [...decisions, { id: whole.id, decision: 'confirmed', color: 'white' }],
    {
      breadboardCandidates: [
        ...review.breadboardCandidates,
        { id: whole.id, extent: 'whole' },
      ],
      breadboardGroups: [
        {
          ...review.breadboardGroups[0]!,
          candidateIds: raw.map((c) => c.id),
          wholeCandidateId: whole.id,
        },
      ],
    },
  );
  assert.deepEqual(value.boards[0]!.bbox, whole.bbox);
  assert.equal(value.boards[0]!.confidence, 0.92);
  assert.equal(value.boards[0]!.localizationSource, 'sam');
  assert.equal(analysisSchema.safeParse(envelope(value)).success, true);
});

test('a whole-board candidate that fails to enclose its parts cannot lend its score to a union box', () => {
  const value = consolidateBreadboards(candidates, decisions, {
    ...review,
    breadboardCandidates: review.breadboardCandidates.map((c, i) => ({
      ...c,
      extent: i === 0 ? 'whole' : 'part',
    })),
    breadboardGroups: [
      { ...review.breadboardGroups[0]!, wholeCandidateId: candidates[0]!.id },
    ],
  });
  assert.equal(value.boards[0]!.localizationSource, 'derived');
  assert.equal(value.boards[0]!.confidence, undefined);
});

test('two adjacent boards remain distinct even with touching boxes; no proximity-only grouping is performed', () => {
  const raw: Candidate[] = [
    { id: 'breadboard_1', type: 'breadboard', bbox: [0, 0, 50, 80] },
    { id: 'breadboard_2', type: 'breadboard', bbox: [50, 0, 50, 80] },
  ];
  const value = consolidateBreadboards(raw, decisions.slice(0, 2), {
    breadboardCandidates: raw.map((c) => ({ id: c.id, extent: 'whole' })),
    breadboardGroups: raw.map((c) => ({
      candidateIds: [c.id],
      wholeCandidateId: c.id,
      decision: 'confirmed',
    })),
  });
  assert.equal(value.boards.length, 2);
  assert.deepEqual(
    value.boards.map((b) => b.bbox),
    raw.map((c) => c.bbox),
  );
  const unresolved = consolidateBreadboards(raw, decisions.slice(0, 2), {
    breadboardCandidates: raw.map((c) => ({ id: c.id, extent: 'uncertain' })),
    breadboardGroups: [],
  });
  assert.equal(unresolved.boards.length, 0);
  assert.equal(unresolved.audit.unresolvedCandidateIds.length, 2);
});

test('uncertain groups, uncertain extents/categories and isolated parts stay unresolved; rejected candidates stay diagnostic-only', () => {
  for (const change of [
    {
      ...review,
      breadboardGroups: [
        { ...review.breadboardGroups[0]!, decision: 'uncertain' as const },
      ],
    },
    {
      ...review,
      breadboardCandidates: review.breadboardCandidates.map((c) => ({
        ...c,
        extent: 'uncertain' as const,
      })),
    },
    { ...review, breadboardGroups: [] },
    {
      ...review,
      breadboardGroups: [
        { ...review.breadboardGroups[0]!, candidateIds: ['breadboard_1'] },
      ],
    },
  ]) {
    const value = consolidateBreadboards(candidates, decisions, change);
    assert.equal(value.boards.length, 0);
    assert.equal(value.audit.unresolvedCandidateIds.length, 4);
    assert.equal(analysisSchema.safeParse(envelope(value)).success, true);
  }
  const uncertain = consolidateBreadboards(
    candidates,
    decisions.map((d) => ({ ...d, decision: 'uncertain' })),
    review,
  );
  assert.equal(uncertain.boards.length, 0);
  const rejected = consolidateBreadboards(
    candidates,
    decisions.map((d) => ({ ...d, decision: 'rejected' })),
    { ...review, breadboardGroups: [] },
  );
  assert.equal(rejected.audit.candidates.length, 4);
  assert.equal(rejected.audit.unresolvedCandidateIds.length, 0);
});

test('invalid or reused IDs, missing extent reviews, rejected members and invalid whole references fail closed', () => {
  const bad = [
    { ...review, breadboardCandidates: [] },
    {
      ...review,
      breadboardCandidates: [
        ...review.breadboardCandidates,
        review.breadboardCandidates[0]!,
      ],
    },
    {
      ...review,
      breadboardGroups: [
        { ...review.breadboardGroups[0]!, candidateIds: ['breadboard_99'] },
      ],
    },
    {
      ...review,
      breadboardGroups: [
        review.breadboardGroups[0]!,
        review.breadboardGroups[0]!,
      ],
    },
    {
      ...review,
      breadboardGroups: [
        {
          ...review.breadboardGroups[0]!,
          candidateIds: ['breadboard_1', 'breadboard_1'],
        },
      ],
    },
    {
      ...review,
      breadboardGroups: [
        { ...review.breadboardGroups[0]!, wholeCandidateId: 'breadboard_1' },
      ],
    },
    {
      ...review,
      breadboardGroups: [
        { ...review.breadboardGroups[0]!, candidateIds: ['led_1'] },
      ],
    },
  ];
  for (const r of bad)
    assert.throws(() => consolidateBreadboards(candidates, decisions, r));
  assert.throws(() =>
    consolidateBreadboards(
      candidates,
      decisions.map((d) => ({ ...d, decision: 'rejected' })),
      review,
    ),
  );
});

test('public evidence validation rejects forged grouping, scores, references and bounds', () => {
  const valid = envelope(consolidateBreadboards(candidates, decisions, review));
  for (const mutate of [
    (v: typeof valid) => {
      v.objects[0]!.confidence = 0.99;
    },
    (v: typeof valid) => {
      v.objects[0]!.bbox[2] = 79;
    },
    (v: typeof valid) => {
      v.objects[0]!.breadboardGrouping!.candidateIds.push('sam_breadboard_99');
    },
    (v: typeof valid) => {
      v.breadboardAudit.unresolvedCandidateIds.push('sam_breadboard_1');
    },
    (v: typeof valid) => {
      v.breadboardAudit.candidates[0]!.bbox[0] = 99;
    },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.equal(analysisSchema.safeParse(changed).success, false);
  }
});

test('combined pipeline groups fragments in the existing Muse round trip and retains raw SAM evidence', async () => {
  const text =
    '<0f>' +
    candidates
      .map(
        (c, i) =>
          `${i}<|box;x1=${c.bbox[0]};y1=${c.bbox[1]};x2=${c.bbox[0] + c.bbox[2] - 1};y2=${c.bbox[1] + c.bbox[3] - 1};w=100;h=80;c=0.8|><|mask;x=0;y=0;c=0.8;data=1,1,!opaque|>`,
      )
      .join(',');
  const { client, calls } = queuedClient([
    samEnvelope(text),
    samEnvelope(''),
    samEnvelope(''),
    samEnvelope(''),
    completion({ objects: decisions, missingWires: [], ...review }),
  ]);
  const result = await createVisionService(testConfig(), client)(
    await imageBytes(),
    new AbortController().signal,
  );
  assert.equal(result.objects.length, 1);
  assert.equal(result.objects[0]!.type, 'breadboard');
  assert.equal(result.breadboardAudit!.candidates.length, 4);
  assert.equal(calls.length, 5);
  assert.equal(calls.filter((c) => c.path === 'chat/completions').length, 1);
});

test('box deduplication preserves overlapping whole/part board evidence until semantic review', () => {
  const overlapping = candidates.map((c) => ({
    ...c,
    bbox: [10, 10, 80, 52] as BoundingBox,
  }));
  assert.equal(deduplicate(overlapping).length, 4);
});
