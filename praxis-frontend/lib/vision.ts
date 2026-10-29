import { z } from "zod";
import { diagnosticsSchema } from "./diagnostics";
import { maskSchema, regionSchema } from "./geometry";
import {
  breadboardAuditSchema,
  breadboardGroupingSchema,
  validateBreadboards,
} from "./breadboards";

/** Public API contract. No server configuration or credentials belong here. */
export const componentTypes = [
  "breadboard",
  "led",
  "resistor",
  "jumper_wire",
] as const;
export type ComponentType = (typeof componentTypes)[number];

export const categories: Record<
  ComponentType,
  { label: string; plural: string; color: string }
> = {
  breadboard: { label: "Breadboard", plural: "Breadboards", color: "#527a68" },
  led: { label: "LED", plural: "LEDs", color: "#bb570d" },
  resistor: { label: "Resistor", plural: "Resistors", color: "#8564a3" },
  jumper_wire: {
    label: "Jumper wire",
    plural: "Jumper wires",
    color: "#387a9b",
  },
};

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const componentSchema = z
  .object({
    id: z.string().regex(/^(breadboard|led|resistor|jumper_wire)_[1-9]\d*$/),
    type: z.enum(componentTypes),
    bbox: z.tuple([
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
      z.number().int().positive(),
      z.number().int().positive(),
    ]),
    color: z.string().min(1).max(40).optional(),
    confidence: z.number().min(0).max(1).optional(),
    localizationSource: z.enum(["sam", "muse", "derived"]).optional(),
    breadboardGrouping: breadboardGroupingSchema.optional(),
    interpretation: z.enum(["confirmed", "uncertain"]),
    reviewStatus: z.literal("sam_unverified").optional(),
    detectionSource: z.enum(["sam", "muse"]).optional(),
    geometryStatus: z.enum(["segmented", "box_only"]).optional(),
    mask: maskSchema.optional(),
    guidanceEligible: z.literal(false).optional(),
    identityStatus: z.literal("unverified").optional(),
  })
  .strict();

export const analysisSchema = z
  .object({
    image: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    objects: z.array(componentSchema).max(100),
    proposals: z.array(regionSchema).max(128).optional(),
    breadboardAudit: breadboardAuditSchema.optional(),
    diagnostics: diagnosticsSchema.optional(),
    provenance: z
      .object({
        mode: z.enum(["combined", "reasoning-only", "sam-only"]),
        segmentationModel: z.string().min(1).max(100).optional(),
        reasoningModel: z.string().min(1).max(100),
        wireAudit: z
          .object({
            samCandidates: z.number().int().min(0).max(100),
            acceptedSam: z.number().int().min(0).max(100),
            recoveredByMuse: z.number().int().min(0).max(100),
            regionsProposedByMuse: z.number().int().min(0).max(16).optional(),
            refinementAttempts: z.number().int().min(0).max(16).optional(),
            unresolvedRegions: z.number().int().min(0).max(128).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((analysis, context) => {
    validateBreadboards(analysis, context);
    if (
      analysis.provenance.mode === "sam-only" &&
      (analysis.breadboardAudit ||
        analysis.objects.some(
          (o) =>
            o.interpretation !== "uncertain" ||
            o.reviewStatus !== "sam_unverified" ||
            o.localizationSource !== "sam" ||
            o.breadboardGrouping,
        ))
    )
      context.addIssue({
        code: "custom",
        message: "SAM-only results must remain unverified.",
      });
    const ids = new Set<string>();
    for (const object of analysis.objects) {
      const [x, y, width, height] = object.bbox;
      if (
        ids.has(object.id) ||
        !object.id.startsWith(`${object.type}_`) ||
        x + width > analysis.image.width ||
        y + height > analysis.image.height ||
        (object.localizationSource === "muse" &&
          object.confidence !== undefined) ||
        (object.type === "jumper_wire" &&
          (!object.mask ||
            object.geometryStatus !== "segmented" ||
            object.guidanceEligible !== false ||
            object.identityStatus !== "unverified")) ||
        (!!object.mask && object.localizationSource !== "sam")
      ) {
        context.addIssue({
          code: "custom",
          message: "Invalid component identity or coordinates.",
        });
      }
      ids.add(object.id);
    }
    if (
      analysis.objects.reduce(
        (sum, object) => sum + (object.mask?.path.length ?? 0),
        0,
      ) > 120000
    )
      context.addIssue({
        code: "custom",
        message: "Geometry payload budget exceeded.",
      });
    for (const region of analysis.proposals ?? []) {
      if (
        ids.has(region.id) ||
        region.bbox[0] + region.bbox[2] > analysis.image.width ||
        region.bbox[1] + region.bbox[3] > analysis.image.height
      )
        context.addIssue({
          code: "custom",
          message: "Invalid region bounds or identity.",
        });
      ids.add(region.id);
    }
  });

export type Analysis = z.infer<typeof analysisSchema>;
export type Component = z.infer<typeof componentSchema>;

export function componentLabel(
  object: Pick<Component, "id" | "type"> &
    Partial<Pick<Component, "reviewStatus">>,
): string {
  if (object.reviewStatus === "sam_unverified" && object.type === "breadboard")
    return `SAM board region ${object.id.split("_").at(-1)}`;
  return `${categories[object.type].label} ${object.id.split("_").at(-1)}`;
}
