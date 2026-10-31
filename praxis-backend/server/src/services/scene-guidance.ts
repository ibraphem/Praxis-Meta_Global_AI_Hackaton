import type { SceneGraph, SceneObject, SceneWork } from '../schemas/scene.js';
import type { BoundingBox } from '../schemas/vision.js';

export interface SceneTarget {
  objectId: string;
  prompt: string;
  crop: BoundingBox;
  reason: SceneWork['reason'];
  priority: number;
}
/** Deterministic evidence priorities. No model-estimated cost or automatic pin inference. */
export function planSceneTargets(
  graph: SceneGraph,
  image: { width: number; height: number },
  maxCropPixels: number,
): SceneTarget[] {
  const priorities = {
    connector: 0,
    conductor: 1,
    power_source: 2,
    unknown: 3,
    electrical_component: 4,
    board: 5,
  };
  const reasons: Record<SceneObject['category'], SceneWork['reason']> = {
    connector: 'missing_connector',
    conductor: 'missing_conductor',
    power_source: 'power_source',
    unknown: 'unclassified_object',
    electrical_component: 'other_component',
    board: 'other_component',
  };
  return graph.objects
    .filter(
      (o) => o.segmentationStatus === 'not_attempted' && o.category !== 'board',
    )
    .flatMap((o) => {
      const [x, y, w, h] = o.bbox;
      const padding = Math.max(4, Math.round(Math.max(w, h) * 0.15));
      const left = Math.max(0, x - padding),
        top = Math.max(0, y - padding);
      const crop: BoundingBox = [
        left,
        top,
        Math.min(image.width, x + w + padding) - left,
        Math.min(image.height, y + h + padding) - top,
      ];
      if (crop[2] * crop[3] > maxCropPixels) return [];
      return [
        {
          objectId: o.id,
          prompt: o.proposedType,
          crop,
          priority:
            o.category === 'connector' &&
            /snap|battery.*connector|connector.*battery/i.test(o.proposedType)
              ? 0
              : o.category !== 'conductor' &&
                  /led.*(holder|housing|assembly)|(holder|housing).*led/i.test(
                    o.proposedType,
                  )
                ? 1
                : o.category === 'conductor'
                  ? 2
                  : 3 + priorities[o.category],
          reason: reasons[o.category],
        },
      ];
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.crop[2] * a.crop[3] - b.crop[2] * b.crop[3] ||
        a.objectId.localeCompare(b.objectId),
    );
}
