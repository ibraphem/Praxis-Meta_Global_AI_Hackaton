import { z } from "zod";
import { geometryBoxSchema as boxSchema, maskSchema } from "./geometry";

const id = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sceneCategorySchema = z.enum([
  "electrical_component",
  "power_source",
  "connector",
  "conductor",
  "board",
  "unknown",
]);
export const sceneObjectSchema = z
  .object({
    id,
    proposedType: z.string().trim().min(1).max(160),
    category: sceneCategorySchema,
    bbox: boxSchema,
    recognitionStatus: z.enum(["proposed", "unknown"]),
    segmentationStatus: z.enum([
      "not_attempted",
      "candidates_returned",
      "no_match",
      "failed",
      "unresolved",
    ]),
    terminalIds: z.array(id).max(64),
  })
  .strict();
export const visualObservationSchema = z
  .object({
    id,
    kind: z.enum(["bbox", "mask", "fragment", "keypoint"]),
    source: z.enum(["sam", "muse", "manual"]),
    attemptId: id,
    requestId: id.optional(),
    model: z.string().min(1).max(100),
    bbox: boxSchema,
    mask: maskSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    sourceCandidateId: z.string().min(1).max(100).optional(),
    samSnapshotId: id.optional(),
    samSnapshotHash: hash.optional(),
    prompt: z.string().min(1).max(160).optional(),
  })
  .strict()
  .refine((o) => o.confidence === undefined || o.source === "sam");
// An observation may support several competing hypotheses. No owner field exists.
export const observationAssociationSchema = z
  .object({
    id,
    objectId: id,
    observationId: id,
    relation: z.enum(["whole", "part", "fragment", "unknown"]),
    basis: z.enum([
      "inventory",
      "category_and_overlap",
      "unclassified_observation",
      "prompt_target",
    ]),
    status: z.literal("proposed"),
    attemptId: id,
  })
  .strict();
export const sceneGraphSchema = z
  .object({
    version: z.literal("scene-v1"),
    imageHash: hash,
    image: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    promptVersion: z.literal("open-inventory-v1"),
    objects: z.array(sceneObjectSchema).max(164),
    observations: z.array(visualObservationSchema).max(450),
    associations: z.array(observationAssociationSchema).max(800),
    // Discovery of terminals and electrical relationships is a separate release.
    electricalConnectionStatus: z.literal("unestablished"),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    for (const entity of [
      ...graph.objects,
      ...graph.observations,
      ...graph.associations,
    ]) {
      if (ids.has(entity.id))
        ctx.addIssue({ code: "custom", message: "Duplicate scene identity." });
      ids.add(entity.id);
    }
    const objects = new Set(graph.objects.map((o) => o.id));
    const observations = new Set(graph.observations.map((o) => o.id));
    for (const item of [...graph.objects, ...graph.observations]) {
      const [x, y, w, h] = item.bbox;
      if (x + w > graph.image.width || y + h > graph.image.height)
        ctx.addIssue({
          code: "custom",
          message: "Scene geometry is outside the original image.",
        });
    }
    for (const a of graph.associations)
      if (!objects.has(a.objectId) || !observations.has(a.observationId))
        ctx.addIssue({
          code: "custom",
          message: "Dangling scene association.",
        });
    if (graph.objects.some((o) => o.terminalIds.length))
      ctx.addIssue({
        code: "custom",
        message: "Scene v1 does not establish terminals.",
      });
    if (
      graph.observations.reduce((n, o) => n + (o.mask?.path.length ?? 0), 0) >
      120000
    )
      ctx.addIssue({
        code: "custom",
        message: "Scene preview budget exceeded.",
      });
  });
export const sceneSnapshotRefSchema = z
  .object({
    snapshotId: id,
    snapshotHash: hash,
    imageHash: hash,
    sourceAttemptId: id,
    createdAt: z.number().int().nonnegative(),
    parentSnapshotId: id.optional(),
  })
  .strict();
export const sceneWorkSchema = z
  .object({
    requestId: id,
    attemptId: id,
    objectId: id,
    inputSnapshotId: id,
    inputSnapshotHash: hash,
    prompt: z.string().min(1).max(160),
    crop: boxSchema,
    reason: z.enum([
      "missing_connector",
      "missing_conductor",
      "power_source",
      "unclassified_object",
      "other_component",
    ]),
    status: z.enum([
      "running",
      "succeeded",
      "no_match",
      "failed",
      "timed_out",
      "interrupted",
    ]),
    upstreamOutcome: z.enum(["unknown", "response_received"]),
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
  })
  .strict();
export type SceneGraph = z.infer<typeof sceneGraphSchema>;
export type SceneObject = z.infer<typeof sceneObjectSchema>;
export type SceneObservation = z.infer<typeof visualObservationSchema>;
export type SceneSnapshotRef = z.infer<typeof sceneSnapshotRefSchema>;
export type SceneWork = z.infer<typeof sceneWorkSchema>;
