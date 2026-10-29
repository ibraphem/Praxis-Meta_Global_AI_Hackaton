import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { analysisSchema } from '../schemas/vision.js';
import { AnalysisTrace } from '../lib/diagnostics.js';
import { AppError } from '../lib/errors.js';
import { createEndpointProposalService } from '../services/endpoint-proposals.js';
import { admittedClient } from './model-admission.js';
import type { MetaClient } from '../lib/meta-client.js';
import type { JobStore } from './store.js';
import type { EndpointResult } from '../services/endpoint-localization.js';
export type GroundingVariant = 'full' | 'candidate_crop' | 'endpoint_crops';
export async function boundedMap<T, R>(
  items: T[],
  concurrency: 1 | 2,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  const output: R[] = [];
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        output[i] = await work(items[i]!);
      }
    }),
  );
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return output;
}
export async function runEndpointExperiment(
  store: JobStore,
  analysisId: string,
  bundleBytes: Buffer,
  options: {
    variants: GroundingVariant[];
    concurrency: 1 | 2;
    runs: number;
    coordinateSpace: 'pixels' | 'normalized_1000';
    signal: AbortSignal;
    onProgress?: (report: unknown) => void;
  },
  base?: MetaClient,
) {
  const bundle = z
    .object({
      schemaVersion: z.literal('praxis-evaluation-v1'),
      image: z.object({ id: z.string(), sha256: z.string().length(64) }),
      analysisRunId: z.string(),
      analysis: analysisSchema,
      boards: z
        .array(
          z
            .object({
              revision: z.number(),
              calibration: z.object({
                rows: z.union([z.literal(30), z.literal(63)]),
                forward: z.array(z.number().finite()).length(9),
              }),
            })
            .passthrough(),
        )
        .min(1),
      reviews: z.array(
        z.object({
          proposal: z
            .object({
              analysisId: z.string(),
              imageId: z.string(),
              wireCandidateId: z.string(),
              calibrationRevisions: z.record(z.string(), z.number()),
              endpoints: z.tuple([
                z.object({
                  proposedImagePosition: z
                    .tuple([z.number().finite(), z.number().finite()])
                    .nullable(),
                  evidence: z.string(),
                }),
                z.object({
                  proposedImagePosition: z
                    .tuple([z.number().finite(), z.number().finite()])
                    .nullable(),
                  evidence: z.string(),
                }),
              ]),
            })
            .passthrough(),
        }),
      ),
    })
    .passthrough()
    .parse(JSON.parse(bundleBytes.toString('utf8')));
  if (
    options.variants.some(
      (v) => !['full', 'candidate_crop', 'endpoint_crops'].includes(v),
    ) ||
    options.runs < 1 ||
    options.runs > 3 ||
    !Number.isInteger(options.runs) ||
    !options.variants.length ||
    new Set(options.variants).size !== options.variants.length
  )
    throw new Error('Choose 1–3 runs and distinct variants.');
  const ids = [
      ...new Set(bundle.reviews.map((r) => r.proposal.wireCandidateId)),
    ],
    wires = ids.map((id) =>
      bundle.analysis.objects.find(
        (c) => c.id === id && c.type === 'jumper_wire' && c.mask,
      ),
    );
  if (
    !ids.length ||
    wires.some((w) => !w) ||
    ids.length *
      options.runs *
      options.variants.reduce(
        (n, v) => n + (v === 'endpoint_crops' ? 2 : 1),
        0,
      ) >
      30
  )
    throw new Error(
      'Select existing masked wires and at most 30 planned provider requests per experiment.',
    );
  if (
    ids.length !== bundle.reviews.length ||
    bundle.reviews.some(
      (r) =>
        r.proposal.analysisId !== bundle.analysisRunId ||
        r.proposal.imageId !== bundle.image.id,
    )
  )
    throw new Error('Freeze one current original proposal per wire.');
  const job = store.get(analysisId),
    snapshotId = bundle.analysis.provenance.samSnapshotId;
  if (
    bundle.image.sha256 !== job.imageHash ||
    !snapshotId ||
    bundle.analysis.provenance.samSnapshotHash !==
      store.getSnapshot(snapshotId).ref.samSnapshotHash
  )
    throw new Error(
      'Bundle photograph and immutable checkpoint must match the saved analysis.',
    );
  const reservation = store.experiments.reserve(analysisId, snapshotId),
    controller = new AbortController(),
    signal = AbortSignal.any([options.signal, controller.signal]);
  const client = admittedClient(
      store,
      { experimentId: reservation.experimentId, owner: reservation.owner! },
      base,
    ),
    service = createEndpointProposalService(
      { ...store.config, META_REASONING_MODEL: job.settings.museModel },
      client,
    );
  const digest = (b: Buffer | string) =>
    createHash('sha256').update(b).digest('hex');
  const report = {
    version: 'endpoint-grounding-experiment-v1',
    experimentId: reservation.experimentId,
    analysisId,
    imageHash: job.imageHash,
    bundleHash: digest(bundleBytes),
    calibrationHash: digest(
      JSON.stringify(JSON.parse(bundleBytes.toString('utf8')).boards),
    ),
    snapshotRef: reservation.snapshotRef,
    settings: {
      variants: options.variants,
      concurrency: options.concurrency,
      runs: options.runs,
      coordinateSpace: options.coordinateSpace,
      model: job.settings.museModel,
      museConcurrency: store.config.MUSE_CONCURRENCY,
      providerTimeoutMs: store.config.PROVIDER_TIMEOUT_MS,
      rolePolicy: 'frozen_original_proposal_anchors',
    },
    originalProposals: bundle.reviews.map((r) => r.proposal),
    status: 'running',
    measurements: [] as {
      variant: GroundingVariant;
      run: number;
      wireCandidateId: string;
      status: string;
      elapsedMs: number;
      response: EndpointResult | null;
      errorCode?: string;
      diagnostics: ReturnType<AnalysisTrace['snapshot']>;
    }[],
    batches: [] as {
      variant: GroundingVariant;
      run: number;
      wallMs: number;
      providerRequests: number;
    }[],
  };
  const save = () => {
    if (
      !store.experiments.record(
        reservation.experimentId,
        reservation.owner!,
        report,
      )
    )
      throw new AppError(
        503,
        'EXPERIMENT_INTERRUPTED',
        'Experiment ownership was lost.',
      );
    options.onProgress?.(report);
  };
  const heartbeat = setInterval(() => {
    try {
      if (
        !store.experiments.renew(reservation.experimentId, reservation.owner!)
      )
        controller.abort(
          new AppError(
            503,
            'EXPERIMENT_INTERRUPTED',
            'Experiment ownership was lost.',
          ),
        );
    } catch {
      controller.abort(
        new AppError(
          503,
          'EXPERIMENT_INTERRUPTED',
          'Experiment heartbeat failed.',
        ),
      );
    }
  }, 3000);
  const grid: [number, number][] = [];
  for (const board of bundle.boards) {
    const h = board.calibration.forward;
    for (let y = 0; y < board.calibration.rows; y++)
      for (const x of [0, 1, 2, 3, 4, 7, 8, 9, 10, 11]) {
        const d = h[6]! * x + h[7]! * y + h[8]!;
        const px = (h[0]! * x + h[1]! * y + h[2]!) / d,
          py = (h[3]! * x + h[4]! * y + h[5]!) / d;
        if (
          px >= 0 &&
          py >= 0 &&
          px < job.image.width &&
          py < job.image.height &&
          grid.length < 1000
        )
          grid.push([px, py]);
      }
  }
  try {
    save();
    for (let run = 0; run < options.runs; run++)
      for (const variant of options.variants) {
        signal.throwIfAborted();
        const start = performance.now(),
          offset = report.measurements.length;
        await boundedMap(wires, options.concurrency, async (wire) => {
          signal.throwIfAborted();
          const started = performance.now(),
            trace = new AnalysisTrace(crypto.randomUUID(), () => undefined);
          let response: EndpointResult | null = null,
            status = 'failed',
            errorCode: string | undefined;
          try {
            response = await service(store.image(analysisId), signal, trace, {
              analysisId: bundle.analysisRunId,
              imageId: bundle.image.id,
              image: job.image,
              wire: {
                id: wire!.id,
                bbox: wire!.bbox,
                mask: wire!.mask,
                ...(wire!.cropOrigin
                  ? {
                      cropOrigin: wire!.cropOrigin,
                      touchesCropBoundary: wire!.touchesCropBoundary,
                    }
                  : {}),
              },
              roleAnchors: bundle.reviews
                .find((r) => r.proposal.wireCandidateId === wire!.id)!
                .proposal.endpoints.map((e) =>
                  e.evidence === 'visible_insertion'
                    ? e.proposedImagePosition
                    : null,
                ),
              otherWires: bundle.analysis.objects
                .filter(
                  (c) =>
                    c.type === 'jumper_wire' && c.mask && c.id !== wire!.id,
                )
                .map((c) => ({ id: c.id, bbox: c.bbox, mask: c.mask })),
              view: variant,
              coordinateSpace: options.coordinateSpace,
              gridPoints: grid,
            });
            status =
              response.localization?.status === 'failed'
                ? 'failed'
                : 'succeeded';
            if (response.localization?.status === 'timed_out') {
              status = 'timed_out';
              controller.abort(
                new AppError(
                  503,
                  'EXPERIMENT_INTERRUPTED',
                  'An upstream outcome is unknown.',
                ),
              );
            }
          } catch (error) {
            errorCode =
              error instanceof AppError ? error.code : 'ENDPOINT_FAILED';
            status = [
              'PROVIDER_TIMEOUT',
              'META_API_TIMEOUT',
              'ANALYSIS_TIMEOUT',
            ].includes(errorCode)
              ? 'timed_out'
              : signal.aborted
                ? 'interrupted'
                : 'failed';
            if (status === 'timed_out')
              controller.abort(
                new AppError(
                  503,
                  'EXPERIMENT_INTERRUPTED',
                  'An upstream outcome is unknown.',
                ),
              );
          }
          report.measurements.push({
            variant,
            run,
            wireCandidateId: wire!.id,
            status,
            elapsedMs: performance.now() - started,
            response,
            ...(errorCode ? { errorCode } : {}),
            diagnostics: trace.snapshot(),
          });
          save();
        });
        report.batches.push({
          variant,
          run,
          wallMs: performance.now() - start,
          providerRequests: report.measurements
            .slice(offset)
            .reduce(
              (n, m) =>
                n +
                m.diagnostics.timings.filter((t) => t.kind === 'request')
                  .length,
              0,
            ),
        });
        save();
      }
    signal.throwIfAborted();
    report.status = 'completed';
    store.experiments.record(
      reservation.experimentId,
      reservation.owner!,
      report,
      'completed',
    );
    options.onProgress?.(report);
    return report;
  } catch (error) {
    report.status = 'interrupted';
    store.experiments.record(
      reservation.experimentId,
      reservation.owner!,
      report,
      'interrupted',
    );
    options.onProgress?.(report);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
