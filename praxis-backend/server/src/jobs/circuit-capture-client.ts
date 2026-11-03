import { canonicalHash } from '../lib/canonical-json.js';
import { AppError } from '../lib/errors.js';
import type { MetaClient } from '../lib/meta-client.js';
import type { Job, JobStore, JobStage } from './store.js';
import {
  SceneRequestRecorder,
  sceneRequestEvidence,
  sha256,
} from './scene-request-evidence.js';
import {
  capturePlanSchema,
  type CaptureRecord,
} from '../schemas/circuit-session.js';
export function captureRecord(
  store: JobStore,
  captureId: string,
): CaptureRecord {
  const r = store.db
    .prepare('SELECT data FROM circuit_captures WHERE id=?')
    .get(captureId);
  if (!r)
    throw new AppError(
      404,
      'CAPTURE_NOT_FOUND',
      'The prepared capture is unavailable.',
    );
  const value = JSON.parse(r.data as string) as CaptureRecord;
  value.plan = capturePlanSchema.parse(value.plan);
  const { planId, ...core } = value.plan;
  if (canonicalHash(core) !== planId)
    throw Error('The capture manifest failed its integrity check.');
  return value;
}
export function saveCapture(store: JobStore, c: CaptureRecord) {
  store.db
    .prepare('UPDATE circuit_captures SET analysis_id=?,data=? WHERE id=?')
    .run(c.analysisId, JSON.stringify(c), c.plan.captureId);
}
/** Dispatch intent consumes budget even when the process loses the response. No replay. */
export function circuitCaptureClient(
  store: JobStore,
  job: Job,
  owner: string,
  stage: JobStage,
  attemptId: string,
  base: MetaClient,
): MetaClient {
  return {
    async post(path, body, signal, operation) {
      signal.throwIfAborted();
      const context = job.captureContext!,
        record = captureRecord(store, context.captureId),
        plan = record.plan;
      const live = store.get(job.analysisId);
      if (
        live.owner !== owner ||
        live.leaseUntil! < Date.now() ||
        live[stage]?.attempts.at(-1)?.attemptId !== attemptId ||
        record.analysisId !== job.analysisId ||
        plan.planId !== context.planId
      )
        throw new AppError(
          409,
          'STALE_CAPTURE',
          'Capture ownership or plan changed.',
        );
      const sam = stage === 'sam',
        allowed = new Set([
          'sam.breadboard',
          'sam.led',
          'sam.resistor',
          'sam.jumper_wire',
        ]);
      if (
        !operation ||
        (sam
          ? path !== 'responses' || !allowed.has(operation.stage)
          : stage !== 'scene' ||
            path !== 'chat/completions' ||
            operation.stage !== 'muse.endpoints')
      )
        throw new AppError(
          409,
          'UNPLANNED_CAPTURE_REQUEST',
          'This provider operation is outside the frozen capture budget.',
        );
      const dimensions = (operation.imageDimensions ?? []).map(
          ({ width, height }) => ({ width, height }),
        ),
        pixels = dimensions.reduce((n, d) => n + d.width * d.height, 0);
      if (
        !pixels ||
        dimensions.some(
          (d) =>
            !Number.isInteger(d.width) ||
            !Number.isInteger(d.height) ||
            d.width < 1 ||
            d.height < 1,
        )
      )
        throw new AppError(
          409,
          'MISSING_PIXEL_ACCOUNTING',
          'Every provider image must have measured dimensions.',
        );
      if (
        sam &&
        (body.model !== plan.samModel || pixels !== plan.width * plan.height)
      )
        throw new AppError(
          409,
          'CAPTURE_MODEL_MISMATCH',
          'SAM input differs from the frozen manifest.',
        );
      if (
        !sam &&
        (!record.endpointPlan ||
          canonicalHash(body) !== record.endpointPlan.payloadHash ||
          body.model !== plan.museModel ||
          pixels !== record.endpointPlan.pixels)
      )
        throw new AppError(
          409,
          'STALE_ENDPOINT_PLAN',
          'Endpoint request differs from its approved preview.',
        );
      const requestId = canonicalHash({
          planId: plan.planId,
          stage: operation.stage,
        }),
        variant = sam ? 'camera-sam' : 'camera-endpoints';
      let recorder!: SceneRequestRecorder;
      store.transaction(() => {
        const prior = sceneRequestEvidence(store, job.analysisId).filter(
            (r) => r.variant === variant,
          ),
          spent = prior.reduce(
            (n, r) =>
              n +
              (r.inputImageDimensions ?? []).reduce(
                (sum, d) => sum + d.width * d.height,
                0,
              ),
            0,
          );
        if (
          prior.some((r) => r.requestId === requestId) ||
          prior.length >= (sam ? 4 : 1) ||
          spent + pixels >
            (sam ? plan.budget.samPixels : plan.budget.maxMusePixels)
        )
          throw new AppError(
            409,
            'CAPTURE_BUDGET_EXHAUSTED',
            'This request was already attempted or exceeds the frozen request/pixel budget.',
          );
        const dataUrl = job.sam.snapshot?.image.dataUrl ?? '',
          bytes = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
        recorder = new SceneRequestRecorder(
          store,
          {
            requestId,
            analysisId: job.analysisId,
            objectId: 'capture',
            experimentId: plan.planId,
            variant,
            inputSnapshotId:
              job.sam.snapshotRef?.samSnapshotId ?? plan.captureId,
            inputSnapshotHash:
              job.sam.snapshotRef?.samSnapshotHash ?? plan.planId,
            imageHash: job.imageHash,
            crop: [0, 0, plan.width, plan.height],
            prompt: operation.stage,
            cropImage: {
              mimeType: 'image/jpeg',
              sha256: sha256(bytes),
              base64: bytes.toString('base64'),
              bytes: bytes.length,
            },
            inputImageDimensions: dimensions,
            createdAt: Date.now(),
          },
          undefined,
          path,
        );
      });
      const checkOwnership = () => {
        signal.throwIfAborted();
        const current = store.get(job.analysisId);
        if (
          current.owner !== owner ||
          !current.leaseUntil ||
          current.leaseUntil < Date.now() ||
          current[stage]?.attempts.at(-1)?.attemptId !== attemptId ||
          current[stage]?.status !== 'running'
        )
          throw new AppError(
            409,
            'STALE_CAPTURE',
            'Capture ownership was lost before provider dispatch.',
          );
      };
      checkOwnership();
      recorder.transport.request(JSON.stringify(body));
      try {
        return await base.post(path, body, signal, {
          ...operation,
          maxRetries: 0,
          evidence: {
            request: (payload) => {
              checkOwnership();
              if (sha256(payload) !== recorder.record.request!.sha256)
                throw Error('Transport payload changed.');
            },
            response: recorder.transport.response,
          },
        });
      } catch (error) {
        recorder.failed(
          error instanceof AppError ? error.code : 'CAPTURE_REQUEST_FAILED',
          'provider',
        );
        throw error;
      }
    },
  };
}
