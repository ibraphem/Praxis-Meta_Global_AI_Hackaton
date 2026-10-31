import { randomUUID } from 'node:crypto';
import type { SceneGraph, SceneObject } from '../schemas/scene.js';
import { boxSupport, inventoryObjectIds } from './scene-reconciliation.js';

type Proposal = Pick<SceneObject, 'proposedType' | 'category' | 'bbox'> & {
  segmentationObservationIds?: string[];
};
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const color = (s: string) =>
  normalize(s).match(
    /\b(red|white|black|blue|green|yellow|orange|purple|brown)\b/,
  )?.[0];
const words = (s: string) =>
  new Set(
    normalize(s)
      .replace(/\bclips?\b/g, 'connector')
      .replace(/\b(holder|housing|socket)\b/g, 'housing')
      .replace(/\b(leads?|legs?|pins?)\b/g, 'lead')
      .split(' ')
      .filter(
        (w) =>
          ![
            'with',
            'from',
            'the',
            'a',
            'and',
            'of',
            'in',
            'along',
            'across',
            'side',
            'plastic',
            'insulated',
            'color',
            'bands',
            'heavy',
            'duty',
          ].includes(w),
      ),
  );
function kind(o: Proposal) {
  const s = normalize(o.proposedType);
  if (o.category === 'conductor') return 'conductor';
  if (/\bled\b|light emitting diode/.test(s))
    return /holder|housing|socket/.test(s) ? 'led_housing' : 'led_body';
  if (/battery/.test(s))
    return /connector|snap|clip/.test(s) ? 'battery_connector' : 'battery';
  if (/resistor/.test(s)) return 'resistor';
  if (/breadboard/.test(s)) return 'breadboard';
  return 'open_description';
}
/** Proposed identity reuse only. Wire proximity and overlap never establish wire identity. */
export function matchInventoryRediscoveries(
  graph: SceneGraph,
  proposals: Proposal[],
) {
  const inventory = inventoryObjectIds(graph),
    old = graph.objects.filter((o) => inventory.has(o.id));
  const boards = graph.objects.filter((o) => o.category === 'board');
  const anchor = (p: Proposal) =>
    [...boards].sort(
      (a, b) =>
        Math.hypot(p.bbox[0] - a.bbox[0], p.bbox[1] - a.bbox[1]) -
        Math.hypot(p.bbox[0] - b.bbox[0], p.bbox[1] - b.bbox[1]),
    )[0]?.id ?? null;
  const candidates = proposals.map((p) =>
    old.flatMap((o) => {
      if (
        o.category !== p.category ||
        kind(o) !== kind(p) ||
        (color(o.proposedType) &&
          color(p.proposedType) &&
          color(o.proposedType) !== color(p.proposedType))
      )
        return [];
      const a = words(o.proposedType),
        b = words(p.proposedType),
        shared = [...a].filter((w) => b.has(w)).length;
      if (!a.size || !b.size) return [];
      const semanticOverlap = shared / new Set([...a, ...b]).size;
      if (semanticOverlap < 0.45) return [];
      const geometry = boxSupport(o.bbox, p.bbox);
      if (
        geometry.iou < 0.55 &&
        !(geometry.containment >= 0.85 && geometry.ratio <= 3)
      )
        return [];
      const ids = graph.associations
        .filter((x) => x.objectId === o.id && x.basis === 'prompt_target')
        .map((x) => x.observationId);
      const sharedSegmentation = (p.segmentationObservationIds ?? []).filter(
        (id) => ids.includes(id),
      );
      // Shared segmentation is supporting evidence, never an override for wire identity.
      const eligible =
        o.category !== 'conductor' ||
        (normalize(o.proposedType) === normalize(p.proposedType) &&
          geometry.iou >= 0.85);
      return [
        {
          objectId: o.id,
          eligible,
          evidence: {
            semanticOverlap,
            ...geometry,
            sharedBoardAnchor: anchor(p) === anchor(o) ? anchor(o) : null,
            sharedSegmentation,
            wireSafeguard: o.category === 'conductor',
          },
        },
      ];
    }),
  );
  return proposals.map((p, index) => {
    const supported = candidates[index]!.filter((c) => c.eligible);
    const unique =
      supported.length === 1 &&
      candidates.filter((cs) =>
        cs.some((c) => c.eligible && c.objectId === supported[0]!.objectId),
      ).length === 1;
    return {
      proposalIndex: index,
      proposedType: p.proposedType,
      status: unique
        ? 'proposed_match'
        : supported.length
          ? 'ambiguous'
          : candidates[index]!.length
            ? 'insufficient_identity_evidence'
            : 'new_hypothesis',
      matchedObjectId: unique ? supported[0]!.objectId : null,
      candidates: candidates[index]!,
    };
  });
}

/** Retain evidence and stable candidate references without changing identity or wire eligibility. */
export function recordIdentityAmbiguities(
  graph: SceneGraph,
  decisions: ReturnType<typeof matchInventoryRediscoveries>,
  proposals: Array<{
    objectId: string;
    observationId: string;
    attemptId: string;
  }>,
) {
  for (const decision of decisions) {
    if (decision.matchedObjectId || !decision.candidates.length) continue;
    const proposal = proposals[decision.proposalIndex]!;
    const members = [
      proposal.objectId,
      ...decision.candidates.map((c) => c.objectId),
    ];
    graph.ambiguityClusters ??= [];
    const linked = graph.ambiguityClusters.filter((c) =>
      c.memberObjectIds.some((id) => members.includes(id)),
    );
    let cluster = linked[0];
    if (!cluster) {
      cluster = {
        id: randomUUID(),
        memberObjectIds: [],
        evidence: [],
        relatedClusterIds: [],
      };
      graph.ambiguityClusters.push(cluster);
    }
    // Bridging clusters keep their original IDs and reviews; cross references expose the overlap.
    for (const other of linked.slice(1)) {
      if (!cluster.relatedClusterIds.includes(other.id))
        cluster.relatedClusterIds.push(other.id);
      if (!other.relatedClusterIds.includes(cluster.id))
        other.relatedClusterIds.push(cluster.id);
    }
    cluster.memberObjectIds = [
      ...new Set([...cluster.memberObjectIds, ...members]),
    ];
    for (const candidate of decision.candidates) {
      if (
        cluster.evidence.some(
          (e) =>
            e.observationId === proposal.observationId &&
            e.candidateObjectId === candidate.objectId,
        )
      )
        continue;
      cluster.evidence.push({
        proposalObjectId: proposal.objectId,
        candidateObjectId: candidate.objectId,
        observationId: proposal.observationId,
        attemptId: proposal.attemptId,
        eligible: candidate.eligible,
        ...candidate.evidence,
      });
    }
    graph.version = 'scene-v2';
  }
}
