import type {
  SceneGraph,
  SceneObject,
  ObjectRelation,
} from '../schemas/scene.js';

type Box = [number, number, number, number];
export interface BaselineObject {
  id: string;
  type: string;
  bbox: Box;
  color?: string | undefined;
}
export interface DisplayObject {
  id: string;
  name: string;
  bbox: Box;
  category: string;
  sceneObjectIds: string[];
  baselineIds: string[];
  observationIds: string[];
  locationKind: 'approximate_inventory' | 'sam_candidate';
}
export interface ReconciledView {
  objects: DisplayObject[];
  evidenceOnlyObjectIds: string[];
  relations: ObjectRelation[];
}

const text = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
export function sceneKind(name: string, category = '') {
  const s = text(name);
  if (/\bled\b|light emitting diode/.test(s))
    return /holder|housing|socket/.test(s) ? 'led_housing' : 'led';
  if (/\bresistor\b/.test(s)) return 'resistor';
  if (/\bbreadboard\b/.test(s)) return 'breadboard';
  if (category === 'conductor' || /\bwire\b|jumper/.test(s)) return 'conductor';
  return `${category}:${s}`;
}
export function boxSupport(a: Box, b: Box) {
  const intersection =
    Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const aa = a[2] * a[3],
    bb = b[2] * b[3];
  return {
    iou: intersection / (aa + bb - intersection),
    containment: intersection / Math.min(aa, bb),
    ratio: Math.max(aa, bb) / Math.min(aa, bb),
  };
}
function compatible(
  a: { name: string; category: string; bbox: Box },
  b: { name: string; category: string; bbox: Box },
) {
  const ka = sceneKind(a.name, a.category),
    kb = sceneKind(b.name, b.category);
  if (ka !== kb) return false;
  const colors = (s: string) =>
    text(s).match(
      /\b(red|white|black|blue|green|yellow|orange|purple|brown)\b/,
    )?.[1];
  if (colors(a.name) && colors(b.name) && colors(a.name) !== colors(b.name))
    return false;
  const g = boxSupport(a.bbox, b.bbox);
  // Containment can explain a body-vs-assembly extent, never a whole wire identity.
  return ka === 'conductor'
    ? g.iou >= 0.75
    : g.iou >= 0.4 || (g.containment >= 0.75 && g.ratio <= 20);
}
function observationIds(graph: SceneGraph, objectId: string) {
  return [
    ...new Set(
      graph.associations
        .filter((a) => a.objectId === objectId)
        .map((a) => a.observationId),
    ),
  ];
}
export function inventoryObjectIds(graph: SceneGraph) {
  return new Set(
    graph.associations
      .filter((a) => a.basis === 'inventory')
      .map((a) => a.objectId),
  );
}
function descriptor(graph: SceneGraph, o: SceneObject) {
  const ids = new Set(observationIds(graph, o.id));
  const prompt = graph.observations.find(
    (obs) => ids.has(obs.id) && obs.source === 'sam',
  )?.prompt;
  return {
    name: o.category === 'unknown' && prompt ? prompt : o.proposedType,
    category: o.category,
    bbox: o.bbox,
  };
}

/** Claims are proposals, not identity verification. No observation or original object is deleted. */
export function proposeObjectRelations(graph: SceneGraph): ObjectRelation[] {
  const inventory = inventoryObjectIds(graph);
  const proposals: ObjectRelation[] = [];
  const candidates = graph.objects.filter((o) => !inventory.has(o.id));
  const named = graph.objects.filter((o) => inventory.has(o.id));
  const descriptors = new Map(
    graph.objects.map((o) => [o.id, descriptor(graph, o)]),
  );
  const add = (
    a: SceneObject,
    b: SceneObject,
    type: ObjectRelation['type'],
    status: ObjectRelation['status'],
  ) => {
    const evidence = [
      ...new Set([
        ...observationIds(graph, a.id),
        ...observationIds(graph, b.id),
      ]),
    ].slice(0, 64);
    if (!evidence.length) return;
    proposals.push({
      id: `local:${type}:${a.id}:${b.id}`,
      fromObjectId: a.id,
      toObjectId: b.id,
      type,
      status,
      basis: 'semantic_geometry',
      observationIds: evidence,
      source: 'local',
      algorithmVersion: 'object-reconciliation-v1',
    });
  };
  for (const raw of candidates) {
    const matches = named.filter((o) =>
      compatible(descriptors.get(raw.id)!, descriptors.get(o.id)!),
    );
    for (const match of matches)
      add(
        raw,
        match,
        'same_object',
        matches.length === 1 &&
          sceneKind(match.proposedType, match.category) !== 'conductor'
          ? 'proposed'
          : 'unresolved',
      );
  }
  for (let i = 0; i < named.length; i++)
    for (let j = i + 1; j < named.length; j++) {
      const a = named[i]!,
        b = named[j]!;
      const g = boxSupport(a.bbox, b.bbox);
      if (
        text(a.proposedType) === text(b.proposedType) &&
        g.iou >= 0.85 &&
        a.category !== 'conductor'
      )
        add(a, b, 'same_object', 'proposed');
      const kinds = [
        sceneKind(a.proposedType, a.category),
        sceneKind(b.proposedType, b.category),
      ];
      if (kinds.includes('led') && kinds.includes('led_housing')) {
        const gapX = Math.max(
          0,
          a.bbox[0] - b.bbox[0] - b.bbox[2],
          b.bbox[0] - a.bbox[0] - a.bbox[2],
        );
        const gapY = Math.max(
          0,
          a.bbox[1] - b.bbox[1] - b.bbox[3],
          b.bbox[1] - a.bbox[1] - a.bbox[3],
        );
        if (
          Math.hypot(gapX, gapY) <=
          Math.hypot(graph.image.width, graph.image.height) * 0.025
        )
          add(
            kinds[0] === 'led' ? a : b,
            kinds[0] === 'led_housing' ? a : b,
            'part_of',
            'unresolved',
          );
      }
    }
  return proposals.slice(0, 400);
}
export function reconcileSceneGraph(input: SceneGraph): SceneGraph {
  const graph = structuredClone(input);
  const old = graph.relations ?? [];
  const ids = new Set(old.map((r) => r.id));
  const fresh = proposeObjectRelations(graph).filter((r) => !ids.has(r.id));
  graph.version = 'scene-v2';
  graph.relations = [...old, ...fresh].slice(0, 400);
  return graph;
}

/** Read-only projection also supports historical v1 snapshots without modifying their hashes. */
export function reconcileSceneView(
  graph: SceneGraph,
  baseline: readonly BaselineObject[] = [],
): ReconciledView {
  const inventory = inventoryObjectIds(graph);
  const derived = reconcileSceneGraph(graph);
  const relations = derived.relations ?? [];
  const pair = (r: ObjectRelation, a: string, b: string) =>
    (r.fromObjectId === a && r.toObjectId === b) ||
    (r.fromObjectId === b && r.toObjectId === a);
  const same = (a: string, b: string) =>
    !relations.some((r) => r.type === 'part_of' && pair(r, a, b)) &&
    relations.some(
      (r) =>
        r.type === 'same_object' && r.status === 'proposed' && pair(r, a, b),
    );
  const objects: DisplayObject[] = [];
  for (const object of graph.objects
    .filter((o) => inventory.has(o.id))
    .sort((a, b) => a.id.localeCompare(b.id))) {
    // Require a direct claim to every existing group member; no transitive overlap chains.
    const group = objects.find((g) =>
      g.sceneObjectIds.every((id) => same(id, object.id)),
    );
    if (group) {
      group.sceneObjectIds.push(object.id);
      group.observationIds.push(...observationIds(graph, object.id));
    } else
      objects.push({
        id: object.id,
        name: object.proposedType,
        bbox: object.bbox,
        category: object.category,
        sceneObjectIds: [object.id],
        baselineIds: [],
        observationIds: observationIds(graph, object.id),
        locationKind: 'approximate_inventory',
      });
  }
  for (const object of graph.objects.filter((o) => !inventory.has(o.id))) {
    const groups = objects.filter((g) =>
      g.sceneObjectIds.some((id) => same(id, object.id)),
    );
    if (groups.length === 1) {
      groups[0]!.sceneObjectIds.push(object.id);
      groups[0]!.observationIds.push(...observationIds(graph, object.id));
    }
  }
  for (const candidate of baseline) {
    const category =
      candidate.type === 'jumper_wire'
        ? 'conductor'
        : candidate.type === 'breadboard'
          ? 'board'
          : 'electrical_component';
    const name =
      candidate.type === 'jumper_wire'
        ? `${candidate.color ?? ''} wire`
        : candidate.type;
    const matches = objects.filter((o) =>
      compatible(
        { name, category, bbox: candidate.bbox },
        { name: o.name, category: o.category, bbox: o.bbox },
      ),
    );
    if (matches.length === 1) matches[0]!.baselineIds.push(candidate.id);
    // Wires are observations until physical identity is reconciled; they remain selectable in Evidence.
    else if (!matches.length && candidate.type !== 'jumper_wire')
      objects.push({
        id: candidate.id,
        name: `${candidate.type} candidate`,
        bbox: candidate.bbox,
        category,
        sceneObjectIds: [],
        baselineIds: [candidate.id],
        observationIds: [],
        locationKind: 'sam_candidate',
      });
  }
  const displayed = new Set(objects.flatMap((o) => o.sceneObjectIds));
  return {
    objects,
    evidenceOnlyObjectIds: graph.objects
      .filter((o) => !displayed.has(o.id))
      .map((o) => o.id),
    relations,
  };
}

export function preferredTerminalTargets(graph: SceneGraph) {
  const ids = inventoryObjectIds(graph);
  return graph.objects
    .filter(
      (o) =>
        ids.has(o.id) &&
        !(graph.terminals ?? []).some((t) => t.objectId === o.id),
    )
    .map((o) => ({
      object: o,
      priority: /snap|battery.*connector|connector.*battery/i.test(
        o.proposedType,
      )
        ? 0
        : /led.*(holder|housing|assembly)|(holder|housing).*led/i.test(
              o.proposedType,
            )
          ? 1
          : /\bled\b/i.test(o.proposedType)
            ? 2
            : 9,
    }))
    .filter((o) => o.priority < 9)
    .sort(
      (a, b) =>
        a.priority - b.priority || a.object.id.localeCompare(b.object.id),
    )
    .slice(0, 2)
    .map((o) => o.object.id);
}
