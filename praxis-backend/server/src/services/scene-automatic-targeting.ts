import { buildObjectPrompt, decodeMaskToRaster } from '@meta-sam/parser';
import type { SceneGraph } from '../schemas/scene.js';
import type { EncodedMask } from '../schemas/geometry.js';
import type { BoundingBox } from '../schemas/vision.js';

export interface TargetingMask {
  observationId: string;
  encodedMask: EncodedMask;
}
/** An experimental proposal generator. No manual points/profiles, hidden contacts or identity claims. */
export function proposeAutomaticTargeting(
  graph: SceneGraph,
  objectId: string,
  crop: BoundingBox,
  native: TargetingMask[],
) {
  const object = graph.objects.find((o) => o.id === objectId);
  if (!object) throw new Error('Automatic target is absent from the scene.');
  const contains = (b: BoundingBox, x: number, y: number) =>
    x >= b[0] && y >= b[1] && x < b[0] + b[2] && y < b[1] + b[3];
  if (
    !contains(crop, object.bbox[0], object.bbox[1]) ||
    !contains(
      crop,
      object.bbox[0] + object.bbox[2] - 1,
      object.bbox[1] + object.bbox[3] - 1,
    )
  )
    throw new Error('Automatic target box is outside the crop.');
  const box = [
    object.bbox[0] - crop[0],
    object.bbox[1] - crop[1],
    object.bbox[2],
    object.bbox[3],
  ] as BoundingBox;
  const prompt = (points: [number, number][]) =>
    buildObjectPrompt({
      size: { width: crop[2], height: crop[3] },
      objects: [
        {
          id: 0,
          prompts: [
            {
              box: {
                left: box[0],
                top: box[1],
                right: box[0] + box[2],
                bottom: box[1] + box[3],
              },
              ...(points.length
                ? {
                    points: points.map(([x, y]) => ({
                      x: x - crop[0],
                      y: y - crop[1],
                      label: 'positive' as const,
                    })),
                  }
                : {}),
            },
          ],
        },
      ],
    });
  const variants = [
    {
      name: 'A-auto-inventory-box',
      scope: 'connector_only',
      crop,
      prompt: prompt([]),
    },
  ];
  const cues: Array<{
    observationId: string;
    point: [number, number];
    interiorDistance: number;
  }> = [];
  let decodedPixels = 0;
  for (const observation of graph.observations) {
    // Only the original broad SAM pass may seed points. Guided/manual masks could leak benchmark targeting.
    if (
      observation.source !== 'sam' ||
      !observation.samSnapshotId ||
      !graph.associations.some(
        (a) =>
          a.objectId === objectId &&
          a.observationId === observation.id &&
          a.basis === 'category_and_overlap',
      ) ||
      graph.maskIdentityReviews?.some(
        (r) =>
          r.objectId === objectId &&
          r.observationId === observation.id &&
          r.decision === 'rejected',
      )
    )
      continue;
    const mask = native.find(
      (n) => n.observationId === observation.id,
    )?.encodedMask;
    if (
      !mask ||
      mask.width !== observation.bbox[2] ||
      mask.height !== observation.bbox[3] ||
      decodedPixels + mask.width * mask.height > 2000000
    )
      continue;
    decodedPixels += mask.width * mask.height;
    let raster: Uint8Array;
    try {
      raster = decodeMaskToRaster(mask);
    } catch {
      continue;
    }
    const distance = new Uint32Array(raster.length);
    const { width: w, height: h } = mask;
    // Distance to the candidate boundary, with zero-valued raster margins treated as background.
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (raster[i])
          distance[i] =
            1 + Math.min(x ? distance[i - 1]! : 0, y ? distance[i - w]! : 0);
      }
    for (let y = h - 1; y >= 0; y--)
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (raster[i])
          distance[i] = Math.min(
            distance[i]!,
            1 +
              Math.min(
                x + 1 < w ? distance[i + 1]! : 0,
                y + 1 < h ? distance[i + w]! : 0,
              ),
          );
      }
    let best: { point: [number, number]; interiorDistance: number } | undefined;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const px = observation.bbox[0] + x,
          py = observation.bbox[1] + y,
          d = distance[y * w + x]!;
        if (
          d < 2 ||
          !contains(object.bbox, px, py) ||
          !contains(crop, px, py) ||
          graph.objects.some(
            (o) =>
              o.id !== objectId &&
              o.category !== 'board' &&
              contains(o.bbox, px, py),
          )
        )
          continue;
        if (!best || d > best.interiorDistance)
          best = { point: [px, py], interiorDistance: d };
      }
    if (best) cues.push({ observationId: observation.id, ...best });
  }
  cues.sort(
    (a, b) =>
      b.interiorDistance - a.interiorDistance ||
      a.observationId.localeCompare(b.observationId),
  );
  const cue = cues[0];
  if (cue)
    variants.push({
      name: 'B-auto-baseline-interior',
      scope: 'connector_only',
      crop,
      prompt: prompt([cue.point]),
    });
  return {
    version: 'automatic-targeting-v1' as const,
    objectId,
    source: 'persisted_inventory_and_baseline_sam',
    inventoryBox: object.bbox,
    pointStatus: cue ? 'proposed' : 'abstained',
    pointCues: cue ? [cue] : [],
    variants,
    note: 'Approximate inventory-box arm is always a proposal. Interior points require independent broad-pass mask pixels, exclude neighboring object boxes, and are omitted when unsupported. No manual targeting, physical boundary verification or electrical claims.',
  };
}
