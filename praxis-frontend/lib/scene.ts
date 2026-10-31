import { z } from "zod";
import { geometryBoxSchema as boxSchema, maskSchema } from "./geometry";
const pointSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);

const id = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const identityReviewSchema = z
  .object({
    id,
    relationId: z.string().min(1).max(240),
    decision: z.enum(["same_object", "different_objects", "uncertain"]),
    source: z.literal("human_review"),
    inputSnapshotId: id,
    inputSnapshotHash: hash,
    reviewedAt: z.number().int().nonnegative(),
  })
  .strict();
// Ambiguity preserves competing identities; membership never establishes same-object identity.
export const ambiguityClusterSchema = z
  .object({
    id,
    memberObjectIds: z.array(id).min(2).max(164),
    evidence: z
      .array(
        z
          .object({
            proposalObjectId: id,
            candidateObjectId: id,
            observationId: id,
            attemptId: id,
            eligible: z.boolean(),
            semanticOverlap: z.number().min(0).max(1),
            iou: z.number().min(0).max(1),
            containment: z.number().min(0).max(1),
            ratio: z.number().min(1),
            sharedBoardAnchor: id.nullable(),
            sharedSegmentation: z.array(id).max(450),
            wireSafeguard: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(800),
    relatedClusterIds: z.array(id).max(164),
  })
  .strict();
export const ambiguityReviewSchema = z
  .object({
    id,
    clusterId: id,
    memberObjectIds: z.array(id).min(2).max(164),
    decision: z.enum(["same_object", "different_objects", "uncertain"]),
    source: z.literal("human_review"),
    inputSnapshotId: id,
    inputSnapshotHash: hash,
    reviewedAt: z.number().int().nonnegative(),
  })
  .strict();
export const maskIdentityReviewSchema = z
  .object({
    id,
    objectId: id,
    observationId: id,
    decision: z.enum(["accepted", "rejected", "uncertain"]),
    source: z.enum(["human_review", "assistant_visual"]),
    reason: z.string().trim().min(8).max(600),
    inputSnapshotId: id,
    inputSnapshotHash: hash,
    reviewedAt: z.number().int().nonnegative(),
  })
  .strict();
export const objectRelationSchema = z
  .object({
    id: z.string().min(1).max(240),
    fromObjectId: id,
    toObjectId: id,
    type: z.enum(["same_object", "part_of"]),
    status: z.enum(["proposed", "unresolved"]),
    basis: z.enum(["semantic_geometry", "shared_observation", "model_visual"]),
    observationIds: z.array(id).min(1).max(64),
    source: z.enum(["local", "muse"]),
    algorithmVersion: z.literal("object-reconciliation-v1").optional(),
    attemptId: id.optional(),
  })
  .strict();
export const terminalSchema = z
  .object({
    id,
    objectId: id,
    label: z.string().min(1).max(40),
    physicalKind: z.enum([
      "pin",
      "lead",
      "contact",
      "breadboard_hole",
      "rail",
      "unknown",
    ]),
    location: pointSchema.nullable(),
    locationStatus: z.enum(["observed", "unresolved"]),
    locationEvidence: z.enum([
      "visible_terminal",
      "visible_lead",
      "occluded",
      "insufficient",
    ]),
    reference: z
      .object({
        position: pointSchema,
        evidence: z.enum([
          "exposed_conductive_lead",
          "insulated_housing_junction",
        ]),
      })
      .strict()
      .optional(),
    pinLabel: z.string().min(1).max(40).nullable(),
    electricalRole: z.string().min(1).max(40).nullable(),
    roleStatus: z.enum(["proposed", "unresolved"]),
    roleMarking: z.string().min(1).max(80).nullable(),
    observationIds: z.array(id).min(1).max(16),
    attemptId: id,
    requestId: id,
    model: z.string().min(1).max(100),
    promptVersion: z
      .enum(["physical-terminals-v1", "physical-terminals-v2"])
      .optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const visible = ["visible_terminal", "visible_lead"].includes(
      t.locationEvidence,
    );
    if (
      t.promptVersion === "physical-terminals-v2" &&
      t.locationEvidence === "visible_lead"
    )
      ctx.addIssue({
        code: "custom",
        message: "Exposed leads are reference points, not terminal contacts.",
      });
    if (
      visible !== (t.location !== null) ||
      visible !== (t.locationStatus === "observed")
    )
      ctx.addIssue({
        code: "custom",
        message: "Terminal positions require visible physical evidence.",
      });
    if ((t.electricalRole !== null || t.pinLabel !== null) && !t.roleMarking)
      ctx.addIssue({
        code: "custom",
        message: "Pin labels and electrical roles require a visible marking.",
      });
    if (
      t.roleMarking &&
      /^(red|black|white|blue|green|yellow|orange|brown|purple)(\s+(wire|lead|insulation))?$/i.test(
        t.roleMarking,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Wire color is not an electrical role marking.",
      });
    if ((t.electricalRole !== null) !== (t.roleStatus === "proposed"))
      ctx.addIssue({
        code: "custom",
        message: "Role status must match the role proposal.",
      });
  });
export const attachmentSchema = z
  .object({
    id,
    terminalId: id,
    conductorObjectId: id,
    evidence: z.enum([
      "visible_attachment",
      "occluded_path",
      "proximity",
      "insufficient",
    ]),
    position: pointSchema.nullable(),
    status: z.enum(["proposed", "unresolved"]),
    observationIds: z.array(id).min(1).max(16),
    attemptId: id,
    requestId: id,
    electricalConnectionStatus: z.literal("unestablished"),
  })
  .strict()
  .refine(
    (a) =>
      (a.evidence === "visible_attachment") === (a.status === "proposed") &&
      (a.evidence === "visible_attachment"
        ? a.position !== null
        : a.position === null),
  );
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
      "terminal_localization",
    ]),
    status: z.literal("proposed"),
    attemptId: id,
  })
  .strict();
export const sceneGraphSchema = z
  .object({
    version: z.enum(["scene-v1", "scene-v2"]),
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
    relations: z.array(objectRelationSchema).max(400).optional(),
    identityReviews: z.array(identityReviewSchema).max(400).optional(),
    ambiguityClusters: z.array(ambiguityClusterSchema).max(164).optional(),
    ambiguityReviews: z.array(ambiguityReviewSchema).max(400).optional(),
    maskIdentityReviews: z.array(maskIdentityReviewSchema).max(400).optional(),
    terminals: z.array(terminalSchema).max(64).optional(),
    attachments: z.array(attachmentSchema).max(128).optional(),
    electricalConnectionStatus: z.literal("unestablished"),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    for (const entity of [
      ...graph.objects,
      ...graph.observations,
      ...graph.associations,
      ...(graph.relations ?? []),
      ...(graph.terminals ?? []),
      ...(graph.attachments ?? []),
      ...(graph.identityReviews ?? []),
      ...(graph.ambiguityClusters ?? []),
      ...(graph.ambiguityReviews ?? []),
      ...(graph.maskIdentityReviews ?? []),
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
    if (
      graph.version === "scene-v1" &&
      (graph.objects.some((o) => o.terminalIds.length) ||
        graph.terminals?.length ||
        graph.attachments?.length ||
        graph.relations?.length ||
        graph.identityReviews?.length ||
        graph.ambiguityClusters?.length ||
        graph.ambiguityReviews?.length ||
        graph.maskIdentityReviews?.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Scene v1 does not establish terminals.",
      });
    const terminals = new Map((graph.terminals ?? []).map((t) => [t.id, t]));
    const inside = (p: [number, number] | null) =>
      !p || (p[0] < graph.image.width && p[1] < graph.image.height);
    const clusters = new Map(
      (graph.ambiguityClusters ?? []).map((c) => [c.id, c]),
    );
    for (const cluster of graph.ambiguityClusters ?? []) {
      const members = new Set(cluster.memberObjectIds);
      if (
        members.size !== cluster.memberObjectIds.length ||
        cluster.memberObjectIds.some((o) => !objects.has(o)) ||
        new Set(cluster.relatedClusterIds).size !==
          cluster.relatedClusterIds.length ||
        cluster.relatedClusterIds.some(
          (c) => c === cluster.id || !clusters.has(c),
        ) ||
        cluster.evidence.some(
          (e) =>
            e.proposalObjectId === e.candidateObjectId ||
            !members.has(e.proposalObjectId) ||
            !members.has(e.candidateObjectId) ||
            !graph.associations.some(
              (a) =>
                a.objectId === e.proposalObjectId &&
                a.observationId === e.observationId &&
                a.basis === "inventory",
            ) ||
            e.sharedSegmentation.some((o) => !observations.has(o)) ||
            (e.sharedBoardAnchor !== null &&
              !graph.objects.some(
                (o) => o.id === e.sharedBoardAnchor && o.category === "board",
              )),
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid ambiguity cluster references.",
        });
    }
    for (const review of graph.ambiguityReviews ?? []) {
      const cluster = clusters.get(review.clusterId);
      if (
        !cluster ||
        new Set(review.memberObjectIds).size !==
          review.memberObjectIds.length ||
        review.memberObjectIds.some(
          (id) => !cluster.memberObjectIds.includes(id),
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid ambiguity review membership.",
        });
    }
    for (const review of graph.identityReviews ?? [])
      if (
        !graph.relations?.some(
          (r) => r.id === review.relationId && r.type === "same_object",
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Identity review requires an existing same-object claim.",
        });
    for (const review of graph.maskIdentityReviews ?? [])
      if (
        !graph.associations.some(
          (a) =>
            a.objectId === review.objectId &&
            a.observationId === review.observationId &&
            a.basis === "prompt_target",
        ) ||
        !graph.observations.some(
          (o) =>
            o.id === review.observationId &&
            o.kind === "mask" &&
            o.source === "sam",
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Mask identity review requires guided mask evidence for the exact object.",
        });
    for (const relation of graph.relations ?? []) {
      if (
        !objects.has(relation.fromObjectId) ||
        !objects.has(relation.toObjectId) ||
        relation.fromObjectId === relation.toObjectId ||
        relation.observationIds.some((o) => !observations.has(o))
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid object relation evidence.",
        });
    }
    const children = new Map<string, string[]>();
    for (const r of graph.relations ?? [])
      if (r.type === "part_of" && r.status === "proposed")
        children.set(r.fromObjectId, [
          ...(children.get(r.fromObjectId) ?? []),
          r.toObjectId,
        ]);
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const cycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const parent of children.get(id) ?? [])
        if (cycle(parent)) return true;
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if ([...objects].some(cycle))
      ctx.addIssue({
        code: "custom",
        message: "Part relations cannot form a cycle.",
      });
    for (const terminal of graph.terminals ?? []) {
      if (
        !objects.has(terminal.objectId) ||
        !inside(terminal.location) ||
        (terminal.reference && !inside(terminal.reference.position)) ||
        terminal.observationIds.some((o) => !observations.has(o)) ||
        !graph.objects
          .find((o) => o.id === terminal.objectId)
          ?.terminalIds.includes(terminal.id)
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid terminal ownership, geometry or evidence.",
        });
    }
    for (const object of graph.objects)
      if (
        object.terminalIds.some(
          (t) => terminals.get(t)?.objectId !== object.id,
        ) ||
        new Set(object.terminalIds).size !== object.terminalIds.length
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid terminal references.",
        });
    for (const attachment of graph.attachments ?? []) {
      if (
        !terminals.has(attachment.terminalId) ||
        (attachment.status === "proposed" &&
          terminals.get(attachment.terminalId)?.promptVersion ===
            "physical-terminals-v2" &&
          terminals.get(attachment.terminalId)?.locationEvidence !==
            "visible_terminal") ||
        graph.objects.find((o) => o.id === attachment.conductorObjectId)
          ?.category !== "conductor" ||
        !inside(attachment.position) ||
        attachment.observationIds.some((o) => !observations.has(o))
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid attachment references or evidence.",
        });
    }
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
export type ObjectRelation = z.infer<typeof objectRelationSchema>;
export type Terminal = z.infer<typeof terminalSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export const terminalWorkSchema = z
  .object({
    requestId: id,
    attemptId: id,
    objectId: id,
    inputSnapshotId: id,
    inputSnapshotHash: hash,
    crop: boxSchema,
    status: z.enum([
      "running",
      "succeeded",
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
export type TerminalWork = z.infer<typeof terminalWorkSchema>;
