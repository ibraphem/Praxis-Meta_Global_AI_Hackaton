import { createHash } from 'node:crypto';
import { AppError } from '../lib/errors.js';
import {
  analysisSchema,
  type Analysis,
  type Component,
} from '../schemas/vision.js';
import type { SnapshotRef } from '../jobs/snapshots.js';

/** Exact geometry and observation boundaries, never bounding-box/color identity matching. */
export function wireEvidenceHash(c: Component, imageHash: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        imageHash,
        bbox: c.bbox,
        mask: c.mask
          ? {
              format: c.mask.format,
              width: c.mask.width,
              height: c.mask.height,
              path: c.mask.path,
            }
          : null,
        cropOrigin: c.cropOrigin ?? null,
        touchesCropBoundary: c.touchesCropBoundary ?? false,
      }),
    )
    .digest('hex');
}
const overlaps = (a: Component, b: Component) =>
  a.bbox[0] < b.bbox[0] + b.bbox[2] &&
  b.bbox[0] < a.bbox[0] + a.bbox[2] &&
  a.bbox[1] < b.bbox[1] + b.bbox[3] &&
  b.bbox[1] < a.bbox[1] + a.bbox[3];
function descendsFrom(
  ancestor: SnapshotRef,
  current: SnapshotRef,
  getRef: (id: string) => SnapshotRef,
) {
  let cursor = current;
  const visited = new Set<string>();
  while (cursor.samSnapshotId !== ancestor.samSnapshotId) {
    if (
      cursor.imageHash !== ancestor.imageHash ||
      !cursor.parentSnapshotId ||
      visited.has(cursor.samSnapshotId) ||
      visited.size >= 128
    )
      return false;
    visited.add(cursor.samSnapshotId);
    cursor = getRef(cursor.parentSnapshotId);
  }
  return (
    cursor.samSnapshotHash === ancestor.samSnapshotHash &&
    cursor.imageHash === ancestor.imageHash
  );
}
/** Preserve selectable evidence only within the same immutable checkpoint lineage. Raw attempts stay untouched. */
export function reconcileWireSelection(
  previous: Analysis,
  raw: Analysis,
  context: {
    observationOnly?: boolean;
    previousAttemptId: string;
    currentAttemptId: string;
    previousRef: SnapshotRef;
    currentRef: SnapshotRef;
    getRef: (id: string) => SnapshotRef;
    historical?: { analysis: Analysis; attemptId: string; ref: SnapshotRef }[];
  },
): Analysis {
  const { previousRef, currentRef } = context;
  if (
    previousRef.imageHash !== currentRef.imageHash ||
    JSON.stringify(previous.image) !== JSON.stringify(raw.image) ||
    previous.provenance.samSnapshotId !== previousRef.samSnapshotId ||
    previous.provenance.samSnapshotHash !== previousRef.samSnapshotHash ||
    raw.provenance.samSnapshotId !== currentRef.samSnapshotId ||
    raw.provenance.samSnapshotHash !== currentRef.samSnapshotHash
  )
    return raw;
  if (!descendsFrom(previousRef, currentRef, context.getRef)) return raw;
  const before = structuredClone(
    previous.objects.filter((c) => c.type === 'jumper_wire'),
  );
  const hash = (c: Component) => wireEvidenceHash(c, currentRef.imageHash);
  const known = new Set(before.map(hash));
  let historicalId = Math.max(
    0,
    ...before.map((c) => Number(c.id.split('_').at(-1))),
  );
  let restoredHistorical = 0;
  for (const historic of context.historical ?? []) {
    if (
      historic.analysis.provenance.samSnapshotId !==
        historic.ref.samSnapshotId ||
      historic.analysis.provenance.samSnapshotHash !==
        historic.ref.samSnapshotHash ||
      JSON.stringify(historic.analysis.image) !== JSON.stringify(raw.image) ||
      !descendsFrom(historic.ref, previousRef, context.getRef)
    )
      continue;
    for (const c of historic.analysis.objects.filter(
      (c) => c.type === 'jumper_wire',
    )) {
      const evidenceHash = hash(c);
      if (known.has(evidenceHash)) continue;
      known.add(evidenceHash);
      restoredHistorical++;
      before.push({
        ...structuredClone(c),
        id: `jumper_wire_${++historicalId}`,
        interpretation: 'uncertain',
        selectionEvidence: {
          evidenceHash,
          sourceSnapshotId:
            c.selectionEvidence?.sourceSnapshotId ?? historic.ref.samSnapshotId,
          sourceAttemptId:
            c.selectionEvidence?.sourceAttemptId ?? historic.attemptId,
          state: 'retained',
          requiresReview: true,
          reasons: ['not_selected_by_latest_interpretation'],
        },
      });
    }
  }
  const incoming = raw.objects.filter((c) => c.type === 'jumper_wire');
  const nextByHash = new Map(incoming.map((c) => [hash(c), c]));
  const oldHashes = new Set(before.map(hash));
  const nonWires = structuredClone(
    raw.objects.filter((c) => c.type !== 'jumper_wire'),
  );
  const kept: Component[] = before.map((old) => {
    const match = nextByHash.get(hash(old));
    const reasons = new Set(old.selectionEvidence?.reasons ?? []);
    if (!match)
      reasons.add(
        context.observationOnly
          ? 'not_present_in_current_geometry'
          : 'not_selected_by_latest_interpretation',
      );
    else if (
      !context.observationOnly &&
      (match.interpretation !== old.interpretation ||
        (match.color &&
          old.color &&
          match.color.toLowerCase() !== old.color.toLowerCase()))
    )
      reasons.add('changed_interpretation');
    const origin = old.selectionEvidence;
    return {
      ...structuredClone(context.observationOnly ? old : (match ?? old)),
      id: old.id,
      // These are selectable hypotheses, including when a fresh interpretation disagrees.
      interpretation: reasons.size
        ? 'uncertain'
        : context.observationOnly
          ? old.interpretation
          : match!.interpretation,
      guidanceEligible: false,
      identityStatus: 'unverified',
      selectionEvidence: {
        evidenceHash: hash(old),
        sourceSnapshotId: origin?.sourceSnapshotId ?? previousRef.samSnapshotId,
        sourceAttemptId: origin?.sourceAttemptId ?? context.previousAttemptId,
        ...(match ? { latestObjectId: match.id } : {}),
        state: match ? 'current' : 'retained',
        requiresReview: reasons.size > 0,
        reasons: [...reasons],
      },
    };
  });
  let pathBytes = [...nonWires, ...kept].reduce(
    (n, c) => n + (c.mask?.path.length ?? 0),
    0,
  );
  if (nonWires.length + kept.length > 100 || pathBytes > 120000)
    throw new AppError(
      409,
      'WIRE_SELECTION_BUDGET',
      'The new interpretation cannot preserve earlier masks within the output budget. Earlier results remain available.',
    );
  let nextId = Math.max(
    0,
    ...before.map((c) => Number(c.id.split('_').at(-1))),
  );
  const deferredObjectIds: string[] = [];
  for (const c of incoming) {
    if (oldHashes.has(hash(c))) continue;
    if (
      nonWires.length + kept.length >= 100 ||
      pathBytes + c.mask!.path.length > 120000
    ) {
      deferredObjectIds.push(c.id);
      continue;
    }
    const evidenceHash = hash(c);
    // Exact duplicate observations have one selectable representative. Similar/crossing masks remain separate.
    oldHashes.add(evidenceHash);
    kept.push({
      ...structuredClone(c),
      id: `jumper_wire_${++nextId}`,
      guidanceEligible: false,
      identityStatus: 'unverified',
      selectionEvidence: {
        evidenceHash,
        sourceSnapshotId: currentRef.samSnapshotId,
        sourceAttemptId: context.currentAttemptId,
        latestObjectId: c.id,
        state: 'current',
        requiresReview: false,
        reasons: [],
      },
    });
    pathBytes += c.mask!.path.length;
  }
  // Spatial overlap signals competing evidence; it never establishes one physical wire or authorizes a merge.
  for (const c of kept.filter((c) => !before.some((old) => old.id === c.id)))
    for (const old of kept.filter((c) => before.some((old) => old.id === c.id)))
      if (overlaps(c, old))
        for (const item of [c, old]) {
          item.selectionEvidence!.requiresReview = true;
          if (
            !item.selectionEvidence!.reasons.includes('overlapping_hypothesis')
          )
            item.selectionEvidence!.reasons.push('overlapping_hypothesis');
          item.interpretation = 'uncertain';
        }
  return analysisSchema.parse({
    ...raw,
    objects: [...nonWires, ...kept],
    provenance: {
      ...raw.provenance,
      wireSelection: {
        version: 'preserve-wire-evidence-v1',
        previousSnapshotId: previousRef.samSnapshotId,
        previousAttemptId: context.previousAttemptId,
        restoredHistorical,
        priorSelectable: before.length - restoredHistorical,
        rawSelectable: incoming.length,
        matched: kept.filter(
          (c) =>
            before.some((old) => old.id === c.id) &&
            c.selectionEvidence!.state === 'current',
        ).length,
        retained: kept.filter((c) => c.selectionEvidence!.state === 'retained')
          .length,
        added: kept.length - before.length,
        reviewRequired: kept.filter((c) => c.selectionEvidence!.requiresReview)
          .length,
        deferredObjectIds,
      },
    },
  });
}
