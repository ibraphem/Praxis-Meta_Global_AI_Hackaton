/** Generate synthetic browser fixtures only. Never seeds production analysis/session state. */
import { readFileSync, writeFileSync } from 'node:fs';
import { syntheticTwoLed } from '../test/fixtures/two-led.js';
import {
  profileComparison,
  connectionProjection,
  planCircuitRepair,
  verifyCircuitRepair,
} from '../src/services/circuit-demo.js';
import { buildConnectivity } from '../src/services/connectivity.js';
import { canonicalHash } from '../src/lib/canonical-json.js';
const path = new URL(
    '../../../praxis-frontend/test/fixtures/',
    import.meta.url,
  ),
  existing = JSON.parse(
    readFileSync(new URL('connectivity.json', path), 'utf8'),
  ),
  job = existing.job,
  sid = 'f7000000-0000-4000-a000-000000000002',
  cid = 'f7000000-0000-4000-a000-000000000003',
  setupId = job.analysisId;
// The camera flow is a completed SAM-only scan; legacy connectivity fixtures used failed SAM.
job.sam.status='succeeded';job.sam.attempts=job.sam.attempts.map((a:any)=>({...a,status:'succeeded',upstreamOutcome:'response_received',retryPolicy:'not_retryable'}));
const { input, profile } = syntheticTwoLed(true);
input.analysisId = job.analysisId;
input.imageHash = job.imageHash;
profile.sessionId = sid;
profile.sourceAnalysisId = setupId;
profile.name = 'SYNTHETIC browser simulation — not physical validation';
profile.qualification = 'verified_human'; // Mock of an already qualified API response; real API forbids synthetic qualification.
job.result.objects.push({
  id: 'jumper_wire_1',
  type: 'jumper_wire',
  bbox: [100, 180, 40, 180],
  mask: {
    format: 'svg_path',
    width: 40,
    height: 180,
    path: 'M 10 0 L 22 0 L 22 180 L 10 180 Z',
  },
  geometryStatus: 'segmented',
  localizationSource: 'sam',
  identityStatus: 'unverified',
  interpretation: 'uncertain',
  reviewStatus: 'sam_unverified',
  guidanceEligible: false,
});
const selected = job.result.objects.find(
  (o: any) => o.type === 'jumper_wire' && o.mask,
).id;
input.components.find((c) => c.id === 'J1')!.objectRef = {
  kind: 'baseline',
  id: selected,
};
const plan = {
  planId: 'e'.repeat(64),
  sessionId: sid,
  sessionRevision: 1,
  captureId: cid,
  purpose: 'assessment',
  profileHash: profile.profileHash,
  frameHash: job.imageHash,
  width: job.image.width,
  height: job.image.height,
  capturedAt: 1,
  preparedAt: 1,
  displayTransform: {
    sourceWidth: 640,
    sourceHeight: 900,
    scaleX: 1,
    scaleY: 1,
    mirrored: false,
    cropped: false,
    coordinateSpace: 'source_pixels',
  },
  providerBaseUrl: 'https://synthetic-provider.invalid',
  samModel: job.settings.samModel,
  museModel: job.settings.museModel,
  budget: {
    samRequests: 4,
    samPixels: job.image.width * job.image.height * 4,
    endpointMuseRequests: 1,
    maxMusePixels: 4000000,
    maxRetries: 0,
  },
  repairId: null,
};
const capture = {
  plan,
  analysisId: job.analysisId,
  uploadedAt: 1,
  endpointPlan: null,
  endpointRequestedAt: null,
  endpointResult: null,
  endpointError: null,
  poseEvidence: { valid: true, reason: 'SYNTHETIC fixed-view simulation' },
  freshReview: {
    inputHash: canonicalHash(input),
    reviewer: 'synthetic_browser',
    reason: 'Synthetic browser test of the presentation controls.',
    reviewedAt: 1,
    wireCandidateId: selected,
    scope: 'human_review',
  },
};
const initial = {
  schemaVersion: 'praxis-circuit-session-view-v1',
  session: {
    sessionId: sid,
    revision: 2,
    createdAt: 0,
    updatedAt: 1,
    setupAnalysisId: setupId,
    profileHash: profile.profileHash,
    activeCaptureId: cid,
    activeRepairId: null,
    state: 'needs_confirmation',
  },
  profile,
  captures: [{ ...capture, freshReview: null }],
  graph: connectionProjection(buildConnectivity(input)),
  comparison: null,
  input,
  repairs: [],
  verifications: [],
  requests: [],
  guidanceCurrent: false,
  physicalValidation: 'pending_real_rig_rehearsal',
  additionalInferenceRequests: 0,
};
const fault = {
  ...initial,
  session: { ...initial.session, revision: 3, state: 'fault_found' },
  comparison: profileComparison(profile, input),
  captures: [capture],
};
const repair = planCircuitRepair({
  sessionId: sid,
  captureId: cid,
  profile,
  input,
  target: { boardId: 'board_1', holeId: 'c6' },
  reviewer: 'synthetic_browser',
  note: 'Synthetic available destination for browser interaction.',
  timestamp: 2,
});
const guidance = {
  ...fault,
  session: {
    ...fault.session,
    state: 'repair_guidance',
    activeRepairId: repair.repairId,
  },
  repairs: [repair],
  guidanceCurrent: true,
};
const fresh = structuredClone(input);
fresh.analysisId = 'f7000000-0000-4000-a000-000000000004';
fresh.imageHash = 'f'.repeat(64);
fresh.associations.find((a) => a.terminalId === 'J1:b')!.target = {
  kind: 'hole',
  boardId: 'board_1',
  holeId: 'c6',
  calibrationRevision: 1,
};
const secondCid = 'f7000000-0000-4000-a000-000000000005',
  freshCapture = {
    ...capture,
    plan: {
      ...plan,
      captureId: secondCid,
      purpose: 'verification',
      frameHash: fresh.imageHash,
      repairId: repair.repairId,
    },
    analysisId: fresh.analysisId,
    freshReview: { ...capture.freshReview, inputHash: canonicalHash(fresh) },
  };
const verifying = {
  ...guidance,
  session: {
    ...guidance.session,
    state: 'verifying',
    activeCaptureId: secondCid,
  },
  captures: [capture, freshCapture],
  input: fresh,
  comparison: profileComparison(profile, fresh),
  graph: connectionProjection(buildConnectivity(fresh)),
  guidanceCurrent: false,
};
const verified = verifyCircuitRepair({
  repair,
  profile,
  captureId: secondCid,
  input: fresh,
  baselineInput: input,
  freshReviewed: true,
  poseValid: true,
});
const resolved = {
  ...verifying,
  session: { ...verifying.session, state: verified.status },
  verifications: [verified],
};
const empty = {
  ...initial,
  session: {
    ...initial.session,
    revision: 0,
    profileHash: null,
    setupAnalysisId: null,
    activeCaptureId: null,
    state: 'setup',
  },
  profile: null,
  captures: [],
  graph: null,
  comparison: null,
  input: null,
};
const secondJob = {
  ...job,
  analysisId: fresh.analysisId,
  imageHash: fresh.imageHash,
};
writeFileSync(
  new URL('camera-demo.json', path),
  JSON.stringify(
    {
      scope: 'SYNTHETIC browser responses only. No real rig validation.',
      empty,
      job,
      secondJob,
      initial,
      fault,
      guidance,
      verifying,
      resolved,
      selected,
    },
    null,
    2,
  ) + '\n',
);
