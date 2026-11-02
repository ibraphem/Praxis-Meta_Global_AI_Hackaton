import type { JobStore } from './store.js';
import { connectorGates } from './connector-validation-gate.js';
import { ConnectorWorkflowService } from './connector-workflow.js';
import { auditConnectorEvidence } from './connector-evidence-audit.js';
import { canonicalHash } from '../lib/canonical-json.js';
import { AppError } from '../lib/errors.js';
import { decodeMaskToRaster } from '@meta-sam/parser';
import type { JunctionPlan } from '../schemas/connector-junctions.js';
import type { JunctionMask } from '../services/connector-junctions.js';
import { junctionRasterHash } from '../services/connector-junctions.js';
import { applyKeepRing } from '../services/scene-automatic-targeting-v2.js';
import {
  encodeRuns,
  validateAnnotation,
  pixelMetrics,
} from '../services/pixel-reference.js';
export function materializeAcceptedJunctionMask(
  native: JunctionMask,
  image: { width: number; height: number },
  scoredMask: string | undefined,
  ring: { crop: JunctionMask['bbox']; runs: number[][] } | undefined,
) {
  if (
    native.encodedMask.width !== native.bbox[2] ||
    native.encodedMask.height !== native.bbox[3] ||
    native.bbox[2] * native.bbox[3] > 2000000
  )
    throw Error('Accepted native dimensions exceed their binding.');
  if (
    image.width * image.height > 4000000 ||
    native.bbox[0] < 0 ||
    native.bbox[1] < 0 ||
    native.bbox[0] + native.bbox[2] > image.width ||
    native.bbox[1] + native.bbox[3] > image.height
  )
    throw Error('Accepted mask source canvas exceeds its binding.');
  const raw = decodeMaskToRaster(native.encodedMask),
    prediction = new Uint8Array(image.width * image.height);
  for (let y = 0; y < native.bbox[3]; y++)
    for (let x = 0; x < native.bbox[2]; x++)
      prediction[(native.bbox[1] + y) * image.width + native.bbox[0] + x] =
        raw[y * native.bbox[2] + x]!;
  if (
    scoredMask !== 'native' &&
    scoredMask !== 'keep_dark_halo' &&
    !(scoredMask === undefined && !ring)
  )
    throw Error('Accepted mask refinement is unrecognized or ambiguous.');
  if (scoredMask === 'keep_dark_halo' && !ring)
    throw Error('Accepted mask refinement evidence is missing.');
  const scored =
      scoredMask === 'keep_dark_halo'
        ? applyKeepRing(prediction, image, ring!)
        : prediction,
    raster = new Uint8Array(raw.length);
  let left = Infinity,
    top = Infinity,
    right = -1,
    bottom = -1;
  for (let y = 0; y < native.bbox[3]; y++)
    for (let x = 0; x < native.bbox[2]; x++)
      if (scored[(native.bbox[1] + y) * image.width + native.bbox[0] + x]) {
        raster[y * native.bbox[2] + x] = 1;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
  if (right < 0) throw Error('Accepted mask has no foreground.');
  const rasterHash = junctionRasterHash(raster),
    body: JunctionMask = {
      ...native,
      acceptedRaster: {
        runs: encodeRuns(raster, native.bbox[2], native.bbox[3]),
        rasterHash,
      },
    };
  return {
    body,
    scored,
    acceptedRasterHash: rasterHash,
    scoredMask:
      scoredMask === 'keep_dark_halo'
        ? ('keep_dark_halo' as const)
        : ('native' as const),
    refinementHash:
      scoredMask === 'keep_dark_halo' ? canonicalHash(ring) : null,
    acceptedBounds: [
      native.bbox[0] + left,
      native.bbox[1] + top,
      right - left + 1,
      bottom - top + 1,
    ] as JunctionMask['bbox'],
  };
}
export function resolveAcceptedConnectorMask(
  store: JobStore,
  analysisId: string,
  connectorObjectId: string,
) {
  const job = store.get(analysisId),
    gate = connectorGates(store, job).find(
      (g) => g.objectId === connectorObjectId,
    );
  const blocked = () =>
    new AppError(
      409,
      'ACCEPTED_CONNECTOR_C_REQUIRED',
      'Phase 4B requires the exact independently validated Strategy C connector-only native mask for this scene.',
    );
  if (gate?.status !== 'passed' || !gate.evaluationId) throw blocked();
  const row = store.db
    .prepare(
      'SELECT data FROM connector_retrospective_evaluations WHERE hash=?',
    )
    .get(gate.evaluationId);
  if (!row) throw blocked();
  const evaluation = JSON.parse(row.data as string);
  if (
    evaluation.strategy !== 'C-body-aware-v2' ||
    evaluation.status !== 'passed' ||
    !evaluation.independentGroundTruth
  )
    throw blocked();
  const source = new ConnectorWorkflowService(store).evidence(
      evaluation.workflowId,
      analysisId,
    ),
    audit = auditConnectorEvidence(source);
  if (
    !audit.provenanceValid ||
    !audit.previewAgreement ||
    audit.reportHash !== evaluation.reportHash
  )
    throw blocked();
  const accepted = evaluation.metrics.filter(
    (m: { accepted: boolean }) => m.accepted,
  );
  if (accepted.length !== 1) throw blocked();
  const report = source.experiment!.report as {
    measurements: Array<{
      variant: string;
      scope: string;
      native?: JunctionMask[];
      observations?: Array<{ id: string; bbox: JunctionMask['bbox'] }>;
    }>;
  };
  const measurement = report.measurements.find(
      (m) => m.variant === 'C-body-aware-v2' && m.scope === 'connector_only',
    ),
    native = measurement?.native?.find(
      (n) => n.observationId === accepted[0].observationId,
    ),
    observation = measurement?.observations?.find(
      (o) => o.id === native?.observationId,
    );
  if (
    !native ||
    !observation ||
    native.encodedMask.width !== observation.bbox[2] ||
    native.encodedMask.height !== observation.bbox[3] ||
    !decodeMaskToRaster(native.encodedMask).some(Boolean)
  )
    throw blocked();
  const plan = source.workflow.contract.plan,
    rawBody: JunctionMask = {
      observationId: native.observationId,
      encodedMask: native.encodedMask,
      bbox: observation.bbox,
    };
  const reference = store.db
    .prepare('SELECT data FROM connector_references WHERE hash=?')
    .get(evaluation.referenceHash);
  if (!reference) throw blocked();
  const ref = JSON.parse(reference.data as string),
    ring =
      plan.automaticTargeting?.version === 'automatic-targeting-v2'
        ? plan.automaticTargeting.diagnostics.keepRing
        : undefined;
  if (
    !ref.independent ||
    ref.content.source !== 'human_review' ||
    !['manual_brush', 'manual_external'].includes(
      ref.content.annotationMethod,
    ) ||
    ref.content.predictionExposure !== 'never_seen' ||
    !ref.content.originalImageOnly ||
    !ref.content.independentAttestation
  )
    throw blocked();
  let materialized: ReturnType<typeof materializeAcceptedJunctionMask>;
  try {
    materialized = materializeAcceptedJunctionMask(
      rawBody,
      job.image,
      accepted[0].scoredMask,
      ring,
    );
    const annotated = validateAnnotation(ref.content, ref.image, true),
      scores = pixelMetrics(
        materialized.scored,
        annotated.regions.connector,
        annotated.regions.redWire,
        annotated.regions.blackWire,
        annotated.regions.uncertain,
      );
    for (const field of [
      'iou',
      'recall',
      'precision',
      'leakage',
      'foregroundPixels',
    ] as const) {
      const value = scores[field],
        recorded = accepted[0][field];
      if (
        value === null
          ? recorded !== null
          : typeof recorded !== 'number' || Math.abs(value - recorded) > 1e-12
      )
        throw Error('Accepted pixels differ from their recorded evaluation.');
    }
  } catch {
    throw blocked();
  }
  const body = materialized.body;
  const segmentation: JunctionPlan['segmentation'] = {
    workflowId: source.workflow.workflowId,
    experimentId: source.experiment!.experimentId,
    evaluationId: gate.evaluationId,
    observationId: body.observationId,
    nativeHash: canonicalHash(body.encodedMask),
    acceptedRasterHash: materialized.acceptedRasterHash,
    scoredMask: materialized.scoredMask,
    refinementHash: materialized.refinementHash,
    acceptedBounds: materialized.acceptedBounds,
    bbox: body.bbox,
  };
  const acceptanceEvidence = {
    evaluation,
    reference: JSON.parse(reference.data as string),
    workflow: source.workflow,
    experiment: source.experiment,
    requests: source.requests.filter((r) => r.variant === 'C-body-aware-v2'),
    audit,
  };
  return {
    job,
    body,
    segmentation,
    acceptanceEvidence,
    samRef: plan.samSnapshotRef,
    sourceSnapshot: source.sourceSnapshot,
  };
}
