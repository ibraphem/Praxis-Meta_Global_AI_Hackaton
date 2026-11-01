import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { MetaClient } from '../lib/meta-client.js';
import { AnalysisTrace } from '../lib/diagnostics.js';
import { AppError } from '../lib/errors.js';
import {
  boundaryProfileSchema,
  buildBoundaryVariants,
  type BoundaryProfile,
} from '../services/connector-boundary.js';
import { buildWirePrompt } from '../services/sam.js';
import { proposeAutomaticTargeting } from '../services/scene-automatic-targeting.js';
import { proposeAutomaticTargetingV2 } from '../services/scene-automatic-targeting-v2.js';
import { connectorProtocolV2 } from '../services/connector-protocol-v2.js';
import sharp from 'sharp';
import { prepareSceneCrop, segmentSceneTarget } from '../services/scene.js';
import { getSceneSnapshot } from './scene-snapshots.js';
import { SceneRequestRecorder, sha256 } from './scene-request-evidence.js';
import { admittedClient } from './model-admission.js';
import type { JobStore } from './store.js';
import { canonicalHash } from '../lib/canonical-json.js';
import {
  connectorAccounting,
  type ConnectorAccountingMeasurement,
} from './connector-lifecycle.js';

async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}
export async function prepareConnectorExperiment(
  store: JobStore,
  analysisId: string,
  objectId: string,
  point: [number, number],
  negative: [number, number],
  options?: {
    profile?: BoundaryProfile;
    automatic?: boolean;
    automaticVersion?: 'v1' | 'v2';
  },
) {
  const job = store.get(analysisId),
    scene = job.scene;
  if (!scene?.snapshotRef || !scene.graph)
    throw new AppError(
      409,
      'SCENE_REQUIRED',
      'Use a persisted scene inventory.',
    );
  const saved = getSceneSnapshot(store, scene.snapshotRef.snapshotId);
  const object = saved.graph.objects.find((o) => o.id === objectId);
  if (
    !object ||
    object.category !== 'connector' ||
    !scene.graph.associations.some(
      (a) => a.objectId === objectId && a.basis === 'inventory',
    )
  )
    throw new AppError(
      400,
      'INVALID_CONNECTOR_TARGET',
      'Choose the exact inventory connector object ID.',
    );
  const samRef = job.recovery.snapshotRef ?? job.sam.snapshotRef;
  if (!samRef)
    throw new AppError(
      409,
      'SAM_REQUIRED',
      'Use a persisted image checkpoint.',
    );
  const image = store.getSnapshot(samRef.samSnapshotId).snapshot.image;
  const [x, y, w, h] = object.bbox,
    pad = Math.max(4, Math.round(Math.max(w, h) * 0.15)),
    widePad = Math.ceil(Math.max(w, h) * 0.65);
  const crop = (padding: number): [number, number, number, number] => {
    const l = Math.max(0, x - padding),
      t = Math.max(0, y - padding);
    return [
      l,
      t,
      Math.min(image.width, x + w + padding) - l,
      Math.min(image.height, y + h + padding) - t,
    ];
  };
  const narrow =
      scene.work.find((o) => o.objectId === objectId)?.crop ?? crop(pad),
    wide = crop(widePad);
  const relative = (p: [number, number]): [number, number] => [
    p[0] - wide[0],
    p[1] - wide[1],
  ];
  const spatial = options?.automatic
    ? ''
    : buildWirePrompt(
        [
          {
            id: 0,
            bbox: [x - wide[0], y - wide[1], w, h],
            positivePoints: [relative(point)],
            negativePoints: [relative(negative)],
          },
        ],
        { width: wide[2], height: wide[3] },
      );
  let variants: Array<{
    name: string;
    prompt: string;
    crop: [number, number, number, number];
    scope?: string;
  }> = [
    { name: 'A-short-original', prompt: 'battery connector', crop: narrow },
    { name: 'B-short-context', prompt: 'battery connector', crop: wide },
    { name: 'C-spatial-context', prompt: spatial, crop: wide },
  ];
  const profile = options?.profile
    ? boundaryProfileSchema.parse(options.profile)
    : undefined;
  if (profile) {
    if (
      profile.imageHash !== job.imageHash ||
      !scene.graph.objects.some(
        (o) =>
          o.id === profile.redConductorObjectId && o.category === 'conductor',
      )
    )
      throw new AppError(
        409,
        'BOUNDARY_SOURCE_MISMATCH',
        'Boundary annotation and conductor must belong to the persisted photograph.',
      );
    variants = buildBoundaryVariants(profile, wide);
  }
  if (profile && options?.automatic)
    throw new Error('Automatic targeting cannot consume a manual profile.');
  const native = options?.automatic
    ? store
        .getSnapshot(samRef.samSnapshotId)
        .snapshot.candidates.flatMap((candidate) => {
          if (!candidate.encodedMask) return [];
          return saved.graph.observations
            .filter(
              (o) =>
                o.sourceCandidateId === candidate.id &&
                o.samSnapshotId === samRef.samSnapshotId &&
                o.samSnapshotHash === samRef.samSnapshotHash,
            )
            .map((o) => ({
              observationId: o.id,
              encodedMask: candidate.encodedMask!,
            }));
        })
    : [];
  const v2 = options?.automatic && options.automaticVersion === 'v2';
  if (v2 && wide[2] * wide[3] > 2000000)
    throw new AppError(
      400,
      'CROP_BUDGET',
      'Experiment crop exceeds two million pixels.',
    );
  const rgb = v2
    ? await sharp(await prepareSceneCrop(image, wide))
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer()
    : undefined;
  const automaticTargeting = options?.automatic
    ? v2
      ? proposeAutomaticTargetingV2(saved.graph, objectId, wide, native, {
          width: wide[2],
          height: wide[3],
          rgb: rgb!,
        })
      : proposeAutomaticTargeting(saved.graph, objectId, wide, native)
    : undefined;
  if (automaticTargeting) variants = automaticTargeting.variants;
  const prepared = [];
  for (const v of variants) {
    if (v.crop[2] * v.crop[3] > 2000000)
      throw new AppError(
        400,
        'CROP_BUDGET',
        'Experiment crop exceeds two million pixels.',
      );
    const bytes = await prepareSceneCrop(image, v.crop);
    prepared.push({
      ...v,
      imageSha256: sha256(bytes),
      imageBytes: bytes.length,
    });
  }
  const totalPixels = prepared.reduce((n, v) => n + v.crop[2] * v.crop[3], 0);
  if (totalPixels > 6000000)
    throw new AppError(
      400,
      'EXPERIMENT_BUDGET',
      'Experiment exceeds six million input pixels.',
    );
  const spec = {
    version: v2
      ? 'connector-automatic-plan-v2'
      : automaticTargeting
        ? 'connector-automatic-plan-v1'
        : profile
          ? 'connector-boundary-plan-v1'
          : 'connector-experiment-plan-v1',
    providerBaseUrl: store.config.META_BASE_URL,
    analysisId,
    objectId,
    object,
    imageHash: job.imageHash,
    sceneSnapshotRef: scene.snapshotRef,
    samSnapshotRef: samRef,
    model: job.settings.samModel,
    maxRequests: 3,
    maxPixels: 6000000,
    perRequestTimeoutMs: Math.min(
      store.config.SCENE_STAGE_TIMEOUT_MS,
      store.config.PROVIDER_TIMEOUT_MS,
    ),
    automaticRetries: 0,
    museRequests: 0,
    totalPixels,
    spatialSeed: {
      source: automaticTargeting ? 'local_automatic' : 'assistant_visual',
      point: automaticTargeting ? null : point,
      negative: automaticTargeting ? null : negative,
      meaning:
        'Physical-object targeting only; not a terminal, polarity or electrical claim.',
    },
    variants: prepared,
    ...(profile ? { profile } : {}),
    ...(automaticTargeting ? { automaticTargeting } : {}),
    ...(v2 ? { evaluationProtocol: connectorProtocolV2 } : {}),
    ...(automaticTargeting
      ? {
          hashAlgorithm: 'canonical-json-sha256-v1',
          requestSpecifications: prepared.map((v) => ({
            variant: v.name,
            model: job.settings.samModel,
            providerBaseUrl: store.config.META_BASE_URL,
            requestedModelVersion: job.settings.samModel,
            resolvedProviderVersion: null,
            coordinateSystem: 'crop_pixels_xywh_original_image',
            crop: v.crop,
            originalImageDimensions: {
              width: image.width,
              height: image.height,
            },
            cropImageHash: v.imageSha256,
            sourceImageHash: job.imageHash,
            sourceSnapshotHash: saved.ref.snapshotHash,
            prompt: v.prompt,
            stream: false,
            metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
          })),
        }
      : {}),
  };
  return {
    ...spec,
    planHash: automaticTargeting
      ? canonicalHash(spec)
      : sha256(JSON.stringify(spec)),
  };
}
export type ConnectorExperimentPlan = Awaited<
  ReturnType<typeof prepareConnectorExperiment>
>;
export function prepareAutomaticConnectorExperiment(
  store: JobStore,
  analysisId: string,
  objectId: string,
  version: 'v1' | 'v2' = 'v1',
) {
  return prepareConnectorExperiment(
    store,
    analysisId,
    objectId,
    [0, 0],
    [0, 0],
    { automatic: true, automaticVersion: version },
  );
}
export async function runConnectorExperiment(
  store: JobStore,
  plan: ConnectorExperimentPlan,
  config: Config,
  options: {
    client?: MetaClient;
    signal?: AbortSignal;
    onReserved?: (id: string) => void;
  } = {},
) {
  const validate = async () => {
    if (config.META_BASE_URL !== plan.providerBaseUrl)
      throw new AppError(
        409,
        'PROVIDER_CONFIGURATION_CHANGED',
        'Prepared provider destination differs from the execution configuration.',
      );
    const { planHash, ...spec } = plan;
    if (
      (plan.hashAlgorithm
        ? canonicalHash(spec)
        : sha256(JSON.stringify(spec))) !== planHash
    )
      throw new AppError(
        409,
        'INVALID_EXPERIMENT_PLAN',
        'Prepared experiment plan was modified.',
      );
    const current = await prepareConnectorExperiment(
      store,
      plan.analysisId,
      plan.objectId,
      plan.spatialSeed.point ?? [0, 0],
      plan.spatialSeed.negative ?? [0, 0],
      plan.automaticTargeting
        ? {
            automatic: true,
            automaticVersion:
              plan.automaticTargeting.version === 'automatic-targeting-v2'
                ? 'v2'
                : 'v1',
          }
        : plan.profile
          ? { profile: plan.profile }
          : undefined,
    );
    if (current.planHash !== plan.planHash)
      throw new AppError(
        409,
        'STALE_EXPERIMENT_PLAN',
        'Prepared experiment evidence changed. No request was dispatched.',
      );
  };
  await validate();
  const reservation = store.experiments.reserve(
      plan.analysisId,
      plan.samSnapshotRef.samSnapshotId,
    ),
    owner = reservation.owner!;
  const lost = new AbortController(),
    signal = AbortSignal.any([
      lost.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
  const heartbeat = setInterval(() => {
    try {
      if (!store.experiments.renew(reservation.experimentId, owner))
        lost.abort(new Error('Experiment ownership lost'));
    } catch {
      lost.abort(new Error('Experiment ownership lost'));
    }
  }, 3000);
  heartbeat.unref();
  const report = {
    version:
      plan.automaticTargeting?.version === 'automatic-targeting-v2'
        ? 'connector-automatic-experiment-v2'
        : plan.automaticTargeting
          ? 'connector-automatic-experiment-v1'
          : plan.profile
            ? 'connector-boundary-experiment-v1'
            : 'connector-experiment-v1',
    experimentId: reservation.experimentId,
    plan,
    status: 'running' as 'running' | 'completed' | 'failed' | 'interrupted',
    startedAt: Date.now(),
    finishedAt: null as number | null,
    errorCode: undefined as string | undefined,
    chargedRequests: 0,
    chargedPixels: 0,
    measurements: [] as Array<
      {
        variant: string;
        requestId: string;
        objectId: string;
        scope?: string;
        status: string;
        upstreamOutcome: string;
        startedAt: number;
        finishedAt: number | null;
        diagnostics?: ReturnType<AnalysisTrace['snapshot']>;
        observations?: unknown[];
        native?: unknown[];
        errorCode?: string;
      } & ConnectorAccountingMeasurement
    >,
    accounting: connectorAccounting({
      chargedRequests: 0,
      chargedPixels: 0,
      measurements: [],
    }),
    note: 'Independent three-request experiment ledger. Reuses inventory; never changes the production budget, graph, IDs, observations, terminals or connectivity. Spatial points are targeting proposals. Candidate delivery is not physical identity verification.',
  };
  const persist = () => {
    report.accounting = connectorAccounting(report);
    if (
      !store.experiments.record(
        reservation.experimentId,
        owner,
        report,
        report.status,
      )
    )
      throw new Error('Experiment ownership lost while persisting');
  };
  let finalized = false;
  const finalize = (status: 'completed' | 'failed' | 'interrupted') => {
    report.status = status;
    report.finishedAt = Date.now();
    // The report and final measurement are committed in one registry transaction.
    // Terminal writes release ownership, so never write the report again afterward.
    persist();
    finalized = true;
    return report;
  };
  try {
    options.onReserved?.(reservation.experimentId);
    persist();
    await validate();
    const image = store.getSnapshot(plan.samSnapshotRef.samSnapshotId).snapshot
      .image;
    const settings = {
      ...config,
      META_SAM_MODEL: plan.model,
      SCENE_STAGE_TIMEOUT_MS: plan.perRequestTimeoutMs,
    };
    const client = admittedClient(
      store,
      { experimentId: reservation.experimentId, owner },
      options.client,
    );
    for (const variant of plan.variants) {
      signal.throwIfAborted();
      if (
        report.chargedRequests >= 3 ||
        report.chargedPixels + variant.crop[2] * variant.crop[3] > 6000000
      )
        throw new Error('Experiment budget exhausted');
      const requestId = randomUUID(),
        trace = new AnalysisTrace(requestId, () => {});
      const measurement = {
        variant: variant.name,
        requestId,
        objectId: plan.objectId,
        ...(variant.scope ? { scope: variant.scope } : {}),
        status: 'running',
        upstreamOutcome: 'unknown',
        phase: 'admitted',
        evaluationStatus: 'not_evaluated',
        pixels: variant.crop[2] * variant.crop[3],
        events: [{ phase: 'admitted', at: Date.now() }],
        startedAt: Date.now(),
        finishedAt: null,
      } as (typeof report.measurements)[number];
      report.measurements.push(measurement);
      report.chargedRequests++;
      report.chargedPixels += variant.crop[2] * variant.crop[3];
      persist();
      let recorder: SceneRequestRecorder | undefined;
      const deadline = new AbortController();
      const timeout = setTimeout(
        () =>
          deadline.abort(
            new AppError(
              504,
              'EXPERIMENT_TIMEOUT',
              'Connector request deadline expired.',
            ),
          ),
        plan.perRequestTimeoutMs,
      );
      const requestSignal = AbortSignal.any([signal, deadline.signal]);
      try {
        const result = await bounded(
          segmentSceneTarget(
            settings,
            client,
            image,
            {
              objectId: plan.objectId,
              prompt: plan.object.proposedType,
              crop: variant.crop,
              reason: 'missing_connector',
              priority: 0,
            },
            reservation.experimentId,
            requestSignal,
            trace,
            {
              prompt: variant.prompt,
              record: (bytes) => {
                if (sha256(bytes) !== variant.imageSha256)
                  throw new Error('Prepared crop bytes changed');
                recorder = new SceneRequestRecorder(
                  store,
                  {
                    requestId,
                    analysisId: plan.analysisId,
                    objectId: plan.objectId,
                    experimentId: reservation.experimentId,
                    variant: variant.name,
                    inputSnapshotId: plan.sceneSnapshotRef.snapshotId,
                    inputSnapshotHash: plan.sceneSnapshotRef.snapshotHash,
                    imageHash: plan.imageHash,
                    crop: variant.crop,
                    prompt: variant.prompt,
                    createdAt: Date.now(),
                    cropImage: {
                      mimeType: 'image/jpeg',
                      sha256: sha256(bytes),
                      base64: bytes.toString('base64'),
                      bytes: bytes.length,
                    },
                  },
                  (phase) => {
                    const previous = structuredClone(measurement);
                    try {
                      measurement.phase = phase;
                      (measurement.events ??= []).push({
                        phase,
                        at: Date.now(),
                      });
                      if (phase === 'dispatching')
                        measurement.dispatchStartedAt = Date.now();
                      else {
                        measurement.responseRecordedAt = Date.now();
                        measurement.responseStatus =
                          recorder!.record.response!.upstreamStatus;
                        measurement.upstreamOutcome = 'response_received';
                      }
                      persist();
                    } catch (error) {
                      for (const key of Object.keys(measurement))
                        delete (
                          measurement as unknown as Record<string, unknown>
                        )[key];
                      Object.assign(measurement, previous);
                      throw error;
                    }
                  },
                );
                return recorder;
              },
            },
          ),
          requestSignal,
        );
        measurement.status = result.observations.length
          ? 'candidates_returned'
          : 'empty_output';
        measurement.upstreamOutcome = 'response_received';
        measurement.observations = result.observations;
        measurement.native = result.native;
      } catch (error) {
        measurement.errorCode =
          error instanceof AppError ? error.code : 'EXPERIMENT_FAILED';
        const response = recorder?.record.response;
        const uncertain =
          [
            'PROVIDER_TIMEOUT',
            'META_API_TIMEOUT',
            'PROVIDER_CONNECTION_ERROR',
            'REQUEST_CANCELLED',
            'ANALYSIS_TIMEOUT',
            'EXPERIMENT_TIMEOUT',
          ].includes(measurement.errorCode) ||
          requestSignal.aborted ||
          response?.upstreamStatus === 504;
        measurement.upstreamOutcome =
          recorder?.record.dispatchStartedAt && uncertain
            ? 'unknown'
            : response
              ? 'response_received'
              : recorder?.record.dispatchStartedAt
                ? 'unknown'
                : 'not_sent';
        measurement.status =
          measurement.upstreamOutcome === 'unknown' ? 'interrupted' : 'failed';
        measurement.phase =
          measurement.upstreamOutcome === 'unknown'
            ? 'outcome_unknown'
            : response
              ? 'response_recorded'
              : 'not_sent';
        (measurement.events ??= []).push({
          phase: measurement.phase,
          at: Date.now(),
        });
        measurement.finishedAt = Date.now();
        measurement.diagnostics = trace.snapshot();
        report.errorCode = measurement.errorCode;
        return finalize(
          measurement.upstreamOutcome === 'unknown' || requestSignal.aborted
            ? 'interrupted'
            : 'failed',
        );
      } finally {
        clearTimeout(timeout);
      }
      measurement.finishedAt = Date.now();
      measurement.diagnostics = trace.snapshot();
      persist();
    }
    return finalize('completed');
  } catch (error) {
    if (!finalized) {
      report.errorCode =
        error instanceof AppError ? error.code : 'EXPERIMENT_FAILED';
      finalize(
        signal.aborted ||
          report.measurements.some((m) => m.upstreamOutcome === 'unknown')
          ? 'interrupted'
          : 'failed',
      );
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
