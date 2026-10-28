import { z } from 'zod';
import {
  boardExtentSchema,
  enclosingBox,
  encloses,
  type BreadboardAudit,
} from '../schemas/breadboards.js';
import type { Candidate, Component } from '../schemas/vision.js';
import { invalidProviderOutput } from '../lib/errors.js';

const id = z.string().regex(/^breadboard_[1-9]\d*$/);
export const breadboardReviewShape = {
  breadboardCandidates: z
    .array(z.object({ id, extent: boardExtentSchema }).strict())
    .max(100),
  breadboardGroups: z
    .array(
      z
        .object({
          candidateIds: z.array(id).min(1).max(100),
          wholeCandidateId: id.nullable(),
          decision: z.enum(['confirmed', 'uncertain']),
        })
        .strict(),
    )
    .max(100),
};
const reviewSchema = z.object(breadboardReviewShape);
type Review = z.infer<typeof reviewSchema>;
interface Decision {
  id: string;
  decision: 'confirmed' | 'uncertain' | 'rejected';
  color: string | null;
}

/** Group only explicit visual judgments; geometry alone never merges physical boards. */
export function consolidateBreadboards(
  candidates: Candidate[],
  decisions: Decision[],
  review: Review,
): {
  boards: Omit<Component, 'id'>[];
  audit: BreadboardAudit;
} {
  const raw = candidates.filter((c) => c.type === 'breadboard');
  const byId = new Map(raw.map((c) => [c.id, c]));
  const roles = new Map(
    review.breadboardCandidates.map((c) => [c.id, c.extent]),
  );
  const judgments = new Map(decisions.map((d) => [d.id, d]));
  if (
    roles.size !== review.breadboardCandidates.length ||
    roles.size !== raw.length ||
    [...roles.keys()].some((id) => !byId.has(id)) ||
    raw.some((c) => !judgments.has(c.id))
  )
    throw invalidProviderOutput();
  const assigned = new Set<string>(),
    counted = new Set<string>();
  const boards: Omit<Component, 'id'>[] = [];
  const auditId = (id: string) => `sam_${id}`;
  for (const group of review.breadboardGroups) {
    const members = group.candidateIds.map((id) => byId.get(id));
    for (const id of group.candidateIds) {
      if (
        !byId.has(id) ||
        assigned.has(id) ||
        judgments.get(id)!.decision === 'rejected'
      )
        throw invalidProviderOutput();
      assigned.add(id);
    }
    if (
      group.wholeCandidateId !== null &&
      (!group.candidateIds.includes(group.wholeCandidateId) ||
        roles.get(group.wholeCandidateId) !== 'whole')
    )
      throw invalidProviderOutput();
    if (
      group.decision !== 'confirmed' ||
      group.candidateIds.some(
        (id) =>
          roles.get(id) === 'uncertain' ||
          judgments.get(id)!.decision !== 'confirmed',
      ) ||
      (members.length === 1 && roles.get(members[0]!.id) !== 'whole')
    )
      continue;
    const boxes = members.map((c) => c!.bbox);
    const proposedWhole = group.wholeCandidateId
      ? byId.get(group.wholeCandidateId)
      : undefined;
    const whole = [proposedWhole, ...members].find(
      (c) =>
        c &&
        roles.get(c.id) === 'whole' &&
        boxes.every((b) => encloses(c.bbox, b)),
    );
    const colors = new Set(
      group.candidateIds
        .map((id) => judgments.get(id)!.color)
        .filter((c) => c !== null),
    );
    boards.push({
      type: 'breadboard',
      bbox: whole ? [...whole.bbox] : enclosingBox(boxes),
      interpretation: 'confirmed',
      localizationSource: whole ? 'sam' : 'derived',
      geometryStatus: 'box_only',
      guidanceEligible: false,
      ...(whole?.confidence === undefined
        ? {}
        : { confidence: whole.confidence }),
      ...(colors.size === 1 ? { color: [...colors][0]! } : {}),
      breadboardGrouping: {
        candidateIds: group.candidateIds.map(auditId),
        geometrySource: whole ? 'sam_candidate' : 'candidate_union',
        wholeCandidateId: whole ? auditId(whole.id) : null,
        reviewSource: 'muse',
      },
    });
    group.candidateIds.forEach((id) => counted.add(id));
  }
  return {
    boards,
    audit: {
      candidates: raw.map((c) => ({
        id: auditId(c.id),
        bbox: [...c.bbox],
        ...(c.confidence === undefined ? {} : { confidence: c.confidence }),
        decision: judgments.get(c.id)!.decision,
        extent: roles.get(c.id)!,
      })),
      unresolvedCandidateIds: raw
        .filter(
          (c) =>
            judgments.get(c.id)!.decision !== 'rejected' && !counted.has(c.id),
        )
        .map((c) => auditId(c.id)),
    },
  };
}
