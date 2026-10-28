import { z } from 'zod';

const candidateId = z.string().regex(/^sam_breadboard_[1-9]\d*$/);
const bbox = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().positive(),
  z.number().int().positive(),
]);
export const boardExtentSchema = z.enum(['whole', 'part', 'uncertain']);
export const breadboardGroupingSchema = z
  .object({
    candidateIds: z.array(candidateId).min(1).max(100),
    geometrySource: z.enum(['sam_candidate', 'candidate_union']),
    wholeCandidateId: candidateId.nullable(),
    reviewSource: z.literal('muse'),
  })
  .strict();
export const breadboardAuditSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            id: candidateId,
            bbox,
            confidence: z.number().min(0).max(1).optional(),
            decision: z.enum(['confirmed', 'uncertain', 'rejected']),
            extent: boardExtentSchema,
          })
          .strict(),
      )
      .max(100),
    unresolvedCandidateIds: z.array(candidateId).max(100),
  })
  .strict();
export type BreadboardAudit = z.infer<typeof breadboardAuditSchema>;
export type BreadboardGrouping = z.infer<typeof breadboardGroupingSchema>;
type Box = [number, number, number, number];
export function enclosingBox(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b[0])),
    y = Math.min(...boxes.map((b) => b[1]));
  return [
    x,
    y,
    Math.max(...boxes.map((b) => b[0] + b[2])) - x,
    Math.max(...boxes.map((b) => b[1] + b[3])) - y,
  ];
}
export function encloses(outer: Box, inner: Box) {
  return (
    outer[0] <= inner[0] &&
    outer[1] <= inner[1] &&
    outer[0] + outer[2] >= inner[0] + inner[2] &&
    outer[1] + outer[3] >= inner[1] + inner[3]
  );
}

/** Validate evidence references and derived geometry at both sides of the proxy. */
export function validateBreadboards(
  analysis: {
    image: { width: number; height: number };
    objects: {
      type: string;
      bbox: Box;
      confidence?: number | undefined;
      localizationSource?: string | undefined;
      interpretation: string;
      breadboardGrouping?: BreadboardGrouping | undefined;
    }[];
    breadboardAudit?: BreadboardAudit | undefined;
    provenance: { mode: string };
  },
  context: z.RefinementCtx,
) {
  const fail = () =>
    context.addIssue({
      code: 'custom',
      message: 'Invalid breadboard grouping evidence.',
    });
  const audit = analysis.breadboardAudit;
  if (!audit) {
    if (
      analysis.objects.some(
        (o) => o.breadboardGrouping || o.localizationSource === 'derived',
      )
    )
      fail();
    return;
  }
  if (analysis.provenance.mode !== 'combined') fail();
  const candidates = new Map(audit.candidates.map((c) => [c.id, c]));
  if (candidates.size !== audit.candidates.length) fail();
  for (const c of audit.candidates)
    if (
      c.bbox[0] + c.bbox[2] > analysis.image.width ||
      c.bbox[1] + c.bbox[3] > analysis.image.height
    )
      fail();
  const used = new Set<string>();
  for (const o of analysis.objects) {
    const group = o.breadboardGrouping;
    if (o.type !== 'breadboard') {
      if (group || o.localizationSource === 'derived') fail();
      continue;
    }
    if (!group) {
      fail();
      continue;
    }
    const members = group.candidateIds.map((id) => candidates.get(id));
    for (const id of group.candidateIds) {
      if (used.has(id)) fail();
      used.add(id);
    }
    if (
      members.some(
        (c) => !c || c.decision !== 'confirmed' || c.extent === 'uncertain',
      ) ||
      o.interpretation !== 'confirmed' ||
      (members.length === 1 && members[0]?.extent !== 'whole')
    ) {
      fail();
      continue;
    }
    const boxes = members.map((c) => c!.bbox);
    if (group.geometrySource === 'candidate_union') {
      if (
        group.wholeCandidateId !== null ||
        o.localizationSource !== 'derived' ||
        o.confidence !== undefined ||
        o.bbox.some((n, i) => n !== enclosingBox(boxes)[i])
      )
        fail();
    } else {
      const whole = candidates.get(group.wholeCandidateId ?? '');
      if (
        !whole ||
        !group.candidateIds.includes(whole.id) ||
        whole.extent !== 'whole' ||
        o.localizationSource !== 'sam' ||
        o.confidence !== whole.confidence ||
        o.bbox.some((n, i) => n !== whole.bbox[i]) ||
        boxes.some((b) => !encloses(whole.bbox, b))
      )
        fail();
    }
  }
  for (const id of audit.unresolvedCandidateIds) {
    if (
      used.has(id) ||
      !candidates.has(id) ||
      candidates.get(id)!.decision === 'rejected'
    )
      fail();
    used.add(id);
  }
  for (const c of audit.candidates) {
    if ((c.decision === 'rejected') === used.has(c.id)) fail();
  }
}
