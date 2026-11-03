import { z } from 'zod';
import {
  circuitInputSchema,
  circuitReferenceSchema,
  circuitPointSchema,
} from './connectivity.ts';
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export const demoPartIds = ['P1', 'R1', 'D1', 'S1', 'R2', 'J1', 'D2'] as const;
export const profilePartsSchema = z
  .object({
    supplyVolts: z.number().positive().max(5.5),
    r1Ohms: z.number().positive().max(1000000),
    r2Ohms: z.number().positive().max(1000000),
    ledSource: z.string().trim().max(2000),
    switchPart: z.string().trim().max(200),
    switchContacts: z.string().trim().max(2000),
    schematicSource: z.string().trim().max(2000),
  })
  .strict();
export const circuitProfileSchema = z.object({
  schemaVersion: z.literal('praxis-circuit-profile-v1'),
  profileHash: digestSchema,
  sessionId: z.uuid(),
  createdAt: z.number(),
  name: z.string(),
  qualification: z.enum(['draft', 'verified_human', 'synthetic_fixture']),
  validationScope: z.enum(['photograph', 'synthetic_fixture']),
  sourceAnalysisId: z.uuid(),
  sourceInputHash: digestSchema,
  sourcePerceptionHash: digestSchema,
  sourceGraphHash: digestSchema,
  reviewer: z.string().min(1).max(100),
  reason: z.string().min(8).max(2000),
  parts: profilePartsSchema,
  mapping: z.record(z.enum(demoPartIds), identity),
  reference: circuitReferenceSchema,
  input: circuitInputSchema,
  anchoredTerminalId: identity.nullable(),
  movingTerminalId: identity.nullable(),
  requiredFromTerminalId: identity.nullable(),
  requiredToTerminalId: identity.nullable(),
  poseAnchors: z.array(circuitPointSchema).length(4),
  posePolicy: z.literal('fixed-camera-patches-v1'),
});
export type CircuitProfile = z.infer<typeof circuitProfileSchema>;
export const capturePurposeSchema = z.enum([
  'setup',
  'assessment',
  'verification',
]);
export const capturePlanSchema = z.object({
  planId: digestSchema,
  sessionId: z.uuid(),
  sessionRevision: z.number().int().nonnegative(),
  captureId: z.uuid(),
  purpose: capturePurposeSchema,
  profileHash: digestSchema.nullable(),
  frameHash: digestSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  capturedAt: z.number().int().positive(),
  preparedAt: z.number(),
  displayTransform: z
    .object({
      sourceWidth: z.number().int().positive(),
      sourceHeight: z.number().int().positive(),
      scaleX: z.number().positive(),
      scaleY: z.number().positive(),
      mirrored: z.literal(false),
      cropped: z.literal(false),
      coordinateSpace: z.literal('source_pixels'),
    })
    .strict(),
  providerBaseUrl: z.url(),
  samModel: z.string(),
  museModel: z.string(),
  budget: z
    .object({
      samRequests: z.literal(4),
      samPixels: z.number().int().positive().max(6000000),
      endpointMuseRequests: z.literal(1),
      maxMusePixels: z.literal(4000000),
      maxRetries: z.literal(0),
    })
    .strict(),
  repairId: digestSchema.nullable(),
});
export type CapturePlan = z.infer<typeof capturePlanSchema>;
export interface CaptureContext {
  planId: string;
  captureId: string;
  sessionId: string;
}
export interface CaptureRecord {
  plan: CapturePlan;
  analysisId: string | null;
  uploadedAt: number | null;
  endpointPlan: {
    hash: string;
    context: unknown;
    payloadHash: string;
    dimensions: { width: number; height: number }[];
    pixels: number;
    samSnapshotHash: string;
    preparedAt: number;
  } | null;
  endpointRequestedAt: number | null;
  endpointResult: unknown | null;
  endpointError: string | null;
  poseEvidence: unknown | null;
  freshReview: {
    inputHash: string;
    reviewer: string;
    reason: string;
    reviewedAt: number;
    wireCandidateId: string;
    scope: 'human_review';
  } | null;
}
export interface CircuitSession {
  sessionId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  setupAnalysisId: string | null;
  profileHash: string | null;
  activeCaptureId: string | null;
  activeRepairId: string | null;
  state:
    | 'setup'
    | 'ready'
    | 'analyzing'
    | 'needs_confirmation'
    | 'scoped_no_fault'
    | 'fault_found'
    | 'repair_guidance'
    | 'verifying'
    | 'resolved'
    | 'not_resolved'
    | 'unable_to_verify';
}
export const repairInstructionSchema = z.object({
  schemaVersion: z.literal('praxis-repair-instruction-v1'),
  repairId: digestSchema,
  sessionId: z.uuid(),
  profileHash: digestSchema,
  sourceCaptureId: z.uuid(),
  sourceAnalysisId: z.uuid(),
  sourceImageHash: digestSchema,
  sourceGraphHash: digestSchema,
  sourceInputHash: digestSchema,
  sourceRevision: z.number().int(),
  findingHash: digestSchema,
  componentId: identity,
  terminalId: identity,
  anchoredTerminalId: identity,
  from: z.object({ boardId: identity, holeId: identity }).strict(),
  to: z.object({ boardId: identity, holeId: identity }).strict(),
  fromPosition: circuitPointSchema,
  toPosition: circuitPointSchema,
  sourceEvidenceIds: z.array(identity).min(1),
  destinationEvidence: z
    .object({
      reviewer: z.string().min(1),
      note: z.string().min(8),
      timestamp: z.number(),
    })
    .strict(),
  text: z.string(),
  createdAt: z.number(),
});
export type RepairInstruction = z.infer<typeof repairInstructionSchema>;
export interface VerificationResult {
  verificationId: string;
  repairId: string;
  captureId: string;
  analysisId: string;
  imageHash: string;
  profileHash: string;
  graphHash: string | null;
  status: 'resolved' | 'not_resolved' | 'unable_to_verify';
  reason: string;
  verificationBasis:
    'fresh_capture_manual_review' | 'insufficient_fresh_evidence';
  electricalOperationVerified: false;
  createdAt: number;
}
export interface CircuitSessionView {
  schemaVersion: 'praxis-circuit-session-view-v1';
  session: CircuitSession;
  profile: CircuitProfile | null;
  captures: CaptureRecord[];
  graph: ReturnType<
    typeof import('../services/circuit-demo.js').connectionProjection
  > | null;
  comparison: ReturnType<
    typeof import('../services/circuit-demo.js').profileComparison
  > | null;
  input: import('./connectivity.js').CircuitInput | null;
  repairs: RepairInstruction[];
  verifications: VerificationResult[];
  requests: {
    captureId: string;
    requestId: string;
    stage: string;
    dimensions: { width: number; height: number }[];
    pixels: number;
    status: string;
    latencyMs: number | null;
    failureCode: string | null;
  }[];
  guidanceCurrent: boolean;
  physicalValidation: 'pending_real_rig_rehearsal';
  additionalInferenceRequests: 0;
}
