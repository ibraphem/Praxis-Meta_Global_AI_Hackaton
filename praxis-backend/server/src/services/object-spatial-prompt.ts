import { buildObjectPrompt } from '@meta-sam/parser';
import type { BoundingBox } from '../schemas/vision.js';
export type PixelPoint = [number, number];
export const containsPixel = (b: BoundingBox, x: number, y: number) =>
  x >= b[0] && y >= b[1] && x < b[0] + b[2] && y < b[1] + b[3];
/** Serialization only. Callers retain separate manual/automatic evidence provenance. */
export function objectSpatialPrompt(
  crop: BoundingBox,
  box: BoundingBox,
  positive: PixelPoint[] = [],
  negative: PixelPoint[] = [],
) {
  const valid = (p: PixelPoint) =>
    p.every(Number.isInteger) && containsPixel(crop, ...p);
  if (
    !valid([box[0], box[1]]) ||
    !valid([box[0] + box[2] - 1, box[1] + box[3] - 1]) ||
    positive.some((p) => !valid(p) || !containsPixel(box, ...p)) ||
    negative.some((p) => !valid(p)) ||
    positive.some((p) => negative.some((n) => p[0] === n[0] && p[1] === n[1]))
  )
    throw new Error(
      'Spatial box and positive/negative pixels must be consistent with the image crop.',
    );
  return buildObjectPrompt({
    size: { width: crop[2], height: crop[3] },
    objects: [
      {
        id: 0,
        prompts: [
          {
            box: {
              left: box[0] - crop[0],
              top: box[1] - crop[1],
              right: box[0] + box[2] - crop[0],
              bottom: box[1] + box[3] - crop[1],
            },
            ...(positive.length || negative.length
              ? {
                  points: [
                    ...positive.map((p) => ({
                      x: p[0] - crop[0],
                      y: p[1] - crop[1],
                      label: 'positive' as const,
                    })),
                    ...negative.map((p) => ({
                      x: p[0] - crop[0],
                      y: p[1] - crop[1],
                      label: 'negative' as const,
                    })),
                  ],
                }
              : {}),
          },
        ],
      },
    ],
  });
}
