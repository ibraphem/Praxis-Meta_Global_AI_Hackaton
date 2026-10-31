import { z } from 'zod';
import { buildObjectPrompt, decodeMaskToRaster } from '@meta-sam/parser';
import type { SceneObservation } from '../schemas/scene.js';
import type { NativeSceneObservation } from './scene.js';

const point = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
const box = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().positive(),
  z.number().int().positive(),
]);
export const boundaryProfileSchema = z
  .object({
    version: z.literal('connector-boundary-profile-v1'),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.literal('assistant_visual'),
    frozenAt: z.number().int().nonnegative(),
    independentGroundTruth: z.literal(false),
    bodyDefinition: z.string().min(20).max(1000),
    assemblyDefinition: z.string().min(20).max(1000),
    bodyBox: box,
    assemblyBox: box,
    positivePoints: z.tuple([point, point]),
    leadPoint: point,
    exclusion: z
      .object({ battery: point, background: point, otherConductor: point })
      .strict(),
    redConductorObjectId: z.uuid(),
    probes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            region: z.enum([
              'body',
              'red_lead',
              'black_lead',
              'battery',
              'background',
            ]),
            position: point,
          })
          .strict(),
      )
      .min(5)
      .max(32),
    annotationLimitations: z.string().min(20).max(1000),
  })
  .strict()
  .superRefine((p, ctx) => {
    const seeds = [
      ...p.positivePoints,
      p.leadPoint,
      ...Object.values(p.exclusion),
    ].map((p) => p.join(','));
    if (
      new Set(p.probes.map((p) => p.id)).size !== p.probes.length ||
      new Set(p.probes.map((p) => p.position.join(','))).size !==
        p.probes.length ||
      p.probes.some((p) => seeds.includes(p.position.join(',')))
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Held-out probes must be distinct from each other and every prompt seed.',
      });
    for (const region of [
      'body',
      'red_lead',
      'black_lead',
      'battery',
      'background',
    ])
      if (!p.probes.some((p) => p.region === region))
        ctx.addIssue({
          code: 'custom',
          message: 'All physical regions require pre-registered probes.',
        });
  });
export type BoundaryProfile = z.infer<typeof boundaryProfileSchema>;
export function buildBoundaryVariants(
  profile: BoundaryProfile,
  crop: [number, number, number, number],
) {
  const inside = (p: [number, number]) =>
    p[0] >= crop[0] &&
    p[1] >= crop[1] &&
    p[0] < crop[0] + crop[2] &&
    p[1] < crop[1] + crop[3];
  for (const p of [
    ...profile.positivePoints,
    profile.leadPoint,
    ...Object.values(profile.exclusion),
    ...profile.probes.map((p) => p.position),
  ])
    if (!inside(p))
      throw new Error(
        'Boundary points/probes must lie inside the common image crop.',
      );
  const defs = [
    {
      name: 'A-body-one-positive',
      scope: 'connector_only' as const,
      box: profile.bodyBox,
      positive: [profile.positivePoints[0]],
      negative: [
        profile.leadPoint,
        profile.exclusion.battery,
        profile.exclusion.background,
      ],
    },
    {
      name: 'B-body-two-positive',
      scope: 'connector_only' as const,
      box: profile.bodyBox,
      positive: profile.positivePoints,
      negative: [
        profile.leadPoint,
        profile.exclusion.battery,
        profile.exclusion.background,
      ],
    },
    {
      name: 'C-body-plus-red-lead',
      scope: 'connector_plus_red_lead' as const,
      box: profile.assemblyBox,
      positive: [...profile.positivePoints, profile.leadPoint],
      negative: [
        profile.exclusion.otherConductor,
        profile.exclusion.battery,
        profile.exclusion.background,
      ],
    },
  ];
  return defs.map((v) => {
    const [x, y, w, h] = v.box;
    if (
      !inside([x, y]) ||
      !inside([x + w - 1, y + h - 1]) ||
      v.positive.some(
        (p) => p[0] < x || p[1] < y || p[0] >= x + w || p[1] >= y + h,
      )
    )
      throw new Error(
        'Positive points must lie inside their declared targeting box.',
      );
    const prompt = buildObjectPrompt({
      size: { width: crop[2], height: crop[3] },
      objects: [
        {
          id: 0,
          prompts: [
            {
              box: {
                left: x - crop[0],
                top: y - crop[1],
                right: x + w - crop[0],
                bottom: y + h - crop[1],
              },
              points: [
                ...v.positive.map((p) => ({
                  x: p[0] - crop[0],
                  y: p[1] - crop[1],
                  label: 'positive' as const,
                })),
                ...v.negative.map((p) => ({
                  x: p[0] - crop[0],
                  y: p[1] - crop[1],
                  label: 'negative' as const,
                })),
              ],
            },
          ],
        },
      ],
    });
    return { name: v.name, scope: v.scope, prompt, crop };
  });
}
/** Native raster probes are sparse observations, never a ground-truth mask or automatic acceptance. */
export function evaluateBoundaryMask(
  observation: SceneObservation,
  native: NativeSceneObservation,
  profile: BoundaryProfile,
) {
  if (observation.id !== native.observationId)
    throw new Error('Native mask/observation binding mismatch.');
  if (
    native.encodedMask.width !== observation.bbox[2] ||
    native.encodedMask.height !== observation.bbox[3]
  )
    throw new Error(
      'Native raster must map one-to-one to its original-image bbox.',
    );
  if (native.encodedMask.width * native.encodedMask.height > 2000000)
    throw new Error('Native raster exceeds evaluation quota.');
  const raster = decodeMaskToRaster(native.encodedMask),
    [x, y] = observation.bbox;
  const probes = profile.probes.map((p) => {
    const ix = p.position[0] - x,
      iy = p.position[1] - y;
    return {
      ...p,
      masked:
        ix >= 0 &&
        iy >= 0 &&
        ix < native.encodedMask.width &&
        iy < native.encodedMask.height
          ? Boolean(raster[iy * native.encodedMask.width + ix])
          : false,
    };
  });
  const byRegion = Object.fromEntries(
    ['body', 'red_lead', 'black_lead', 'battery', 'background'].map(
      (region) => {
        const group = probes.filter((p) => p.region === region);
        return [
          region,
          {
            masked: group.filter((p) => p.masked).length,
            probes: group.length,
          },
        ];
      },
    ),
  );
  const inside = (
    px: number,
    py: number,
    b: [number, number, number, number],
  ) => px >= b[0] && py >= b[1] && px < b[0] + b[2] && py < b[1] + b[3];
  let bodyExtentForeground = 0,
    assemblyExtentForeground = 0,
    lowerLeadZoneForeground = 0;
  for (let iy = 0; iy < native.encodedMask.height; iy++)
    for (let ix = 0; ix < native.encodedMask.width; ix++)
      if (raster[iy * native.encodedMask.width + ix]) {
        const px = x + ix,
          py = y + iy;
        if (inside(px, py, profile.bodyBox)) bodyExtentForeground++;
        if (inside(px, py, profile.assemblyBox)) {
          assemblyExtentForeground++;
          if (py >= profile.bodyBox[1] + profile.bodyBox[3])
            lowerLeadZoneForeground++;
        }
      }
  return {
    areaPixels: raster.reduce((n, v) => n + v, 0),
    bbox: observation.bbox,
    extentMeasurements: {
      bodyExtentForeground,
      assemblyExtentForeground,
      lowerLeadZoneForeground,
      note: 'Foreground pixel counts within predeclared targeting extents, not reference-mask accuracy or automatic acceptance.',
    },
    probes,
    byRegion,
    source: 'assistant_visual_sparse_probes',
    independentGroundTruth: false,
    automaticAcceptance: false,
    note: 'Probe hits assess specified visible pixels only. They do not measure complete object coverage, IoU against truth, or verified physical identity.',
  };
}
