import { z } from "zod";
import {
  circuitProfileSchema,
  capturePlanSchema,
  repairInstructionSchema,
} from "../../praxis-backend/server/src/schemas/circuit-session";
import { circuitInputSchema } from "../../praxis-backend/server/src/schemas/connectivity";
export {
  demoPartIds,
  profilePartsSchema,
} from "../../praxis-backend/server/src/schemas/circuit-session";
export type {
  CircuitSessionView,
  CircuitProfile,
  RepairInstruction,
  CaptureRecord,
} from "../../praxis-backend/server/src/schemas/circuit-session";
import type { CircuitSessionView } from "../../praxis-backend/server/src/schemas/circuit-session";
const session = z
  .object({
    sessionId: z.uuid(),
    revision: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
    setupAnalysisId: z.uuid().nullable(),
    profileHash: z.string().nullable(),
    activeCaptureId: z.uuid().nullable(),
    activeRepairId: z.string().nullable(),
    state: z.enum([
      "setup",
      "ready",
      "analyzing",
      "needs_confirmation",
      "scoped_no_fault",
      "fault_found",
      "repair_guidance",
      "verifying",
      "resolved",
      "not_resolved",
      "unable_to_verify",
    ]),
  })
  .strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  identity = z.string().min(1).max(200),
  dimensions = z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .strict();
const projection = z
  .object({
    nodes: z.array(
      z
        .object({
          id: identity,
          members: z.array(identity),
          label: z.string(),
          netId: z.string().nullable(),
        })
        .strict(),
    ),
    wires: z.array(
      z
        .object({
          id: identity,
          label: z.string(),
          from: identity,
          to: identity,
          kind: z.literal("wire"),
          confirmed: z.boolean(),
          objectRef: z
            .object({
              kind: z.enum(["baseline", "scene", "manual"]),
              id: identity,
            })
            .strict(),
          bbox: z
            .tuple([z.number(), z.number(), z.number(), z.number()])
            .nullable(),
        })
        .strict(),
    ),
    devices: z.array(
      z
        .object({
          id: identity,
          label: z.string(),
          kind: z.literal("device"),
          type: z.string(),
          state: z.enum(["open", "closed", "unknown"]).nullable(),
          ports: z.array(
            z
              .object({
                terminalId: identity,
                nodeId: identity,
                role: z.string().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    netlist: z.array(
      z.object({ id: identity, terminals: z.array(identity) }).strict(),
    ),
  })
  .strict();
const verification = z
  .object({
    verificationId: hash,
    repairId: hash,
    captureId: z.uuid(),
    analysisId: z.uuid(),
    imageHash: hash,
    profileHash: hash,
    graphHash: hash.nullable(),
    status: z.enum(["resolved", "not_resolved", "unable_to_verify"]),
    reason: z.string(),
    verificationBasis: z.enum([
      "fresh_capture_manual_review",
      "insufficient_fresh_evidence",
    ]),
    electricalOperationVerified: z.literal(false),
    createdAt: z.number(),
  })
  .strict();
const shape = z
  .object({
    schemaVersion: z.literal("praxis-circuit-session-view-v1"),
    session,
    profile: circuitProfileSchema.nullable(),
    captures: z
      .array(
        z
          .object({
            plan: capturePlanSchema,
            analysisId: z.uuid().nullable(),
            uploadedAt: z.number().nullable(),
            endpointPlan: z
              .object({
                hash,
                context: z.unknown(),
                payloadHash: hash,
                dimensions: z.array(dimensions).min(1).max(4),
                pixels: z.number().int().positive().max(4000000),
                samSnapshotHash: hash,
                preparedAt: z.number(),
              })
              .strict()
              .nullable(),
            endpointRequestedAt: z.number().nullable(),
            endpointResult: z.unknown(),
            endpointError: z.string().nullable(),
            poseEvidence: z.unknown(),
            freshReview: z
              .object({
                inputHash: hash,
                reviewer: z.string(),
                reason: z.string(),
                reviewedAt: z.number(),
                wireCandidateId: identity,
                scope: z.literal("human_review"),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(30),
    graph: projection.nullable(),
    comparison: z
      .object({
        findings: z.array(
          z
            .object({
              id: identity,
              ruleId: identity,
              status: z.enum([
                "confirmed_fault",
                "possible_fault",
                "insufficient_evidence",
                "no_fault",
              ]),
              reason: z.string(),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .nullable(),
    input: circuitInputSchema.nullable(),
    repairs: z.array(repairInstructionSchema),
    verifications: z.array(verification),
    requests: z.array(
      z
        .object({
          captureId: z.uuid(),
          requestId: hash,
          stage: z.string(),
          dimensions: z.array(dimensions),
          pixels: z.number().int().nonnegative(),
          status: z.enum(["not_sent", "response_received", "unknown"]),
          latencyMs: z.number().nonnegative().nullable(),
          failureCode: z.string().nullable(),
        })
        .strict(),
    ),
    guidanceCurrent: z.boolean(),
    physicalValidation: z.literal("pending_real_rig_rehearsal"),
    additionalInferenceRequests: z.literal(0),
  })
  .strict();
export function parseCircuitSession(
  value: unknown,
  id?: string,
): CircuitSessionView {
  const parsed = shape.parse(value);
  if (id && parsed.session.sessionId !== id)
    throw Error("Session response identity changed.");
  return parsed as unknown as CircuitSessionView;
}
export async function hashBytes(bytes: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
