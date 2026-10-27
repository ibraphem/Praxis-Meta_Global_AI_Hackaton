import { z } from "zod";

export const geometryBoxSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().positive(),
  z.number().int().positive(),
]);
export const maskSchema = z
  .object({
    format: z.literal("svg_path"),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    path: z
      .string()
      .min(1)
      .max(18000)
      .regex(/^[MLZ0-9 .\-]+$/),
  })
  .strict()
  .refine((mask) => mask.width * mask.height <= 4_000_000);
export const regionSchema = z
  .object({
    id: z.string().regex(/^wire_region_[1-9]\d*$/),
    type: z.literal("jumper_wire"),
    bbox: geometryBoxSchema,
    color: z.string().min(1).max(40).optional(),
    refinementStatus: z.enum([
      "not_attempted",
      "ambiguous",
      "failed",
      "timed_out",
    ]),
    reason: z.enum([
      "missing_anchor",
      "budget_exhausted",
      "sam_unavailable",
      "no_mask",
      "invalid_mask",
      "ambiguous_mask",
      "prompt_mismatch",
      "duplicate_mask",
      "geometry_budget",
      "provider_error",
      "provider_timeout",
    ]),
    refinementCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
    guidanceEligible: z.literal(false),
  })
  .strict();
export type WireRegion = z.infer<typeof regionSchema>;

export const regionExplanations: Record<WireRegion["reason"], string> = {
  missing_anchor:
    "An individual wire could not be distinguished. Try a closer view.",
  budget_exhausted: "This region was not refined within this analysis budget.",
  sam_unavailable:
    "Precise wire geometry requires SAM refinement in this mode.",
  no_mask: "No segment was returned for the intended wire.",
  invalid_mask: "The wire mask could not be read reliably.",
  ambiguous_mask:
    "The segment may contain multiple wires, disconnected pieces, or an unclear shape.",
  prompt_mismatch:
    "The segment did not match the targeting points for the intended wire.",
  duplicate_mask:
    "This may be a wire already represented by another candidate.",
  geometry_budget: "The mask was too large or complex to inspect reliably.",
  provider_error:
    "The optional geometry refinement failed. Other detections are retained.",
  provider_timeout:
    "The optional geometry refinement timed out. Other detections are retained.",
};

export function regionLabel(id: string): string {
  let index = Number(id.split("_").at(-1));
  let label = "";
  do {
    index--;
    label = String.fromCharCode(65 + (index % 26)) + label;
    index = Math.floor(index / 26);
  } while (index > 0);
  return `Wire region ${label}`;
}
