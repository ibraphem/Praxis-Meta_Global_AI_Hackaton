import { runtimeSchema } from './runtime.js';
import { z } from 'zod';
import {
  selectionEvidenceSchema,
  wireSelectionSchema,
  candidateLayerSchema,
} from './wire-selection.js';
import { maskSchema, regionSchema, type EncodedMask } from './geometry.js';
import {
  breadboardAuditSchema,
  breadboardGroupingSchema,
  validateBreadboards,
} from './breadboards.js';

export const componentTypeSchema = z.enum([
  'breadboard',
  'led',
  'resistor',
  'jumper_wire',
]);
export type ComponentType = z.infer<typeof componentTypeSchema>;

export const bboxSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().positive(),
  z.number().int().positive(),
]);
export type BoundingBox = z.infer<typeof bboxSchema>;

export const componentSchema = z
  .object({
    id: z.string().regex(/^(breadboard|led|resistor|jumper_wire)_[1-9]\d*$/),
    type: componentTypeSchema,
    bbox: bboxSchema,
    color: z.string().trim().min(1).max(40).optional(),
    // Only SAM-supplied detection confidence; never an LLM's self-assessment.
    confidence: z.number().min(0).max(1).optional(),
    localizationSource: z.enum(['sam', 'muse', 'derived']).optional(),
    breadboardGrouping: breadboardGroupingSchema.optional(),
    interpretation: z.enum(['confirmed', 'uncertain']),
    reviewStatus: z.literal('sam_unverified').optional(),
    detectionSource: z.enum(['sam', 'muse']).optional(),
    geometryStatus: z.enum(['segmented', 'box_only']).optional(),
    mask: maskSchema.optional(),
    touchesCropBoundary: z.boolean().optional(),
    cropOrigin: bboxSchema.optional(),
    guidanceEligible: z.literal(false).optional(),
    identityStatus: z.literal('unverified').optional(),
    selectionEvidence: selectionEvidenceSchema.optional(),
  })
  .strict();
export type Component = z.infer<typeof componentSchema>;

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
    provenance: z
      .object({
        mode: z.enum(['combined', 'reasoning-only', 'sam-only']),
        segmentationModel: z.string().optional(),
        reasoningModel: z.string(),
        jobAnalysisId: z.uuid().optional(),
        samSnapshotId: z.uuid().optional(),
        samSnapshotHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        snapshotProcessingVersion: z.string().min(1).max(100).optional(),
        wireSelection: wireSelectionSchema.optional(),
        candidateLayer: candidateLayerSchema.optional(),
        runtime: runtimeSchema.optional(),
        wireAudit: z
          .object({
            samCandidates: z.number().int().nonnegative(),
            acceptedSam: z.number().int().nonnegative(),
            recoveredByMuse: z.number().int().nonnegative(),
            regionsProposedByMuse: z.number().int().nonnegative().optional(),
            refinementAttempts: z.number().int().nonnegative().optional(),
            unresolvedRegions: z.number().int().nonnegative().optional(),
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
      analysis.provenance.mode === 'sam-only' &&
      (analysis.breadboardAudit ||
        analysis.objects.some(
          (o) =>
            o.interpretation !== 'uncertain' ||
            o.reviewStatus !== 'sam_unverified' ||
            o.localizationSource !== 'sam' ||
            o.breadboardGrouping,
        ))
    )
      context.addIssue({
        code: 'custom',
        message: 'SAM-only results must remain unverified.',
      });
    const ids = new Set<string>();
    for (const [index, object] of analysis.objects.entries()) {
      const [x, y, width, height] = object.bbox;
      if (
        x + width > analysis.image.width ||
        y + height > analysis.image.height ||
        ids.has(object.id) ||
        !object.id.startsWith(`${object.type}_`) ||
        (object.localizationSource === 'muse' &&
          object.confidence !== undefined) ||
        (object.type === 'jumper_wire' &&
          (!object.mask ||
            object.geometryStatus !== 'segmented' ||
            object.guidanceEligible !== false ||
            object.identityStatus !== 'unverified')) ||
        (!!object.mask && object.localizationSource !== 'sam')
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Invalid object identity or bounds.',
          path: ['objects', index],
        });
      }
      ids.add(object.id);
    }
    if (
      analysis.objects.reduce(
        (size, object) => size + (object.mask?.path.length ?? 0),
        0,
      ) > 120000
    )
      context.addIssue({
        code: 'custom',
        message: 'Geometry payload budget exceeded.',
      });
    for (const region of analysis.proposals ?? []) {
      if (
        region.bbox[0] + region.bbox[2] > analysis.image.width ||
        region.bbox[1] + region.bbox[3] > analysis.image.height ||
        ids.has(region.id)
      )
        context.addIssue({
          code: 'custom',
          message: 'Invalid region bounds or identity.',
        });
      ids.add(region.id);
    }
  });
export type Analysis = z.infer<typeof analysisSchema>;

export interface PreparedImage {
  width: number;
  height: number;
  /** Orientation-corrected, metadata-stripped JPEG. Never log; persisted only in the private job store. */
  dataUrl: string;
}

export interface Detection {
  type: ComponentType;
  bbox: BoundingBox;
  confidence?: number;
  localizationSource?: 'sam' | 'muse';
  /** Private checkpoints only. Never expose encoded provider masks or sampler IDs in API responses. */
  encodedMask?: EncodedMask;
  samObjectId?: number;
  recoverySource?: 'sam_crop';
  cropOrigin?: BoundingBox;
  recoveryPromptMatched?: boolean;
}

export interface Candidate extends Detection {
  id: string;
}
