import { z } from 'zod';

export const boxSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().positive(),
  z.number().int().positive(),
]);
export const pointSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
export const maskSchema = z
  .object({
    format: z.literal('svg_path'),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    // Geometry only: never accept SVG markup, URLs, styles, or executable content.
    path: z
      .string()
      .min(1)
      .max(18000)
      .regex(/^[MLZ0-9 .\-]+$/),
  })
  .strict()
  .refine((mask) => mask.width * mask.height <= 4_000_000);
export type MaskGeometry = z.infer<typeof maskSchema>;

export const regionReasons = [
  'missing_anchor',
  'budget_exhausted',
  'sam_unavailable',
  'no_mask',
  'invalid_mask',
  'ambiguous_mask',
  'prompt_mismatch',
  'duplicate_mask',
  'geometry_budget',
  'provider_error',
  'provider_timeout',
] as const;
export type RegionReason = (typeof regionReasons)[number];
export const regionSchema = z
  .object({
    id: z.string().regex(/^wire_region_[1-9]\d*$/),
    type: z.literal('jumper_wire'),
    bbox: boxSchema,
    color: z.string().min(1).max(40).optional(),
    refinementStatus: z.enum([
      'not_attempted',
      'ambiguous',
      'failed',
      'timed_out',
    ]),
    reason: z.enum(regionReasons),
    refinementCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
    guidanceEligible: z.literal(false),
  })
  .strict();
export type WireRegion = z.infer<typeof regionSchema>;

export interface WirePrompt {
  id: number;
  bbox: [number, number, number, number];
  positivePoints: [number, number][];
  negativePoints: [number, number][];
}
export interface EncodedMask {
  width: number;
  height: number;
  encoding: 'one_bit' | 'lossless';
  payload: string;
}
