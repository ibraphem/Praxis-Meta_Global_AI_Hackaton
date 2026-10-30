import { continuationRegions } from './wire-continuation.js';
import { recoveryPlan } from './wire-recovery-plan.js';
import { supportsSpatialPrompt } from './wire-fragments.js';
import { shortWireRegions } from './short-wire-recovery.js';
import { buildWirePrompt } from './sam.js';
import { randomUUID } from 'node:crypto';
import { normalizeCropAttempts } from './crop-attempts.js';
import sharp from 'sharp';
import { decodeMaskToRaster } from '@meta-sam/parser';
import { createMetaClient, type MetaClient } from '../lib/meta-client.js';
import { decodeSamResponse } from './sam.js';
import { auditWireCoverage } from './wire-coverage.js';
import { createWireVerifier } from './wire-verification.js';
import type { Config } from '../config.js';
import type { AnalysisTrace } from '../lib/diagnostics.js';
import { AppError } from '../lib/errors.js';
import type { SamSnapshot } from './vision.js';
import type {
  Candidate,
  BoundingBox,
  PreparedImage,
} from '../schemas/vision.js';
import type { SnapshotRef } from '../jobs/snapshots.js';
import type {
  RecoveryReport,
  WireIdentity,
  CropAttempt,
} from '../schemas/wire-recovery.js';
export interface RecoveryBudget {
  requests: number;
  pixels: number;
  verificationRequests: number;
  rounds: number;
}
export interface RecoveryProgress {
  report: RecoveryReport;
  snapshot: SamSnapshot;
  budget: RecoveryBudget;
  visited: BoundingBox[];
  cropAttempts: CropAttempt[];
  changed: boolean;
}
/** High-resolution crop masks retain native raster resolution; only their origin changes. */
export function reprojectCrop(
  candidates: Candidate[],
  crop: BoundingBox,
  firstId: number,
): Candidate[] {
  return candidates.map((c, i) => ({
    ...c,
    id: `jumper_wire_${firstId + i}`,
    bbox: [c.bbox[0] + crop[0], c.bbox[1] + crop[1], c.bbox[2], c.bbox[3]],
    recoverySource: 'sam_crop',
    cropOrigin: crop,
  }));
}
function pixelsOf(c: Candidate): Set<number> | undefined {
  if (!c.encodedMask || c.encodedMask.width * c.encodedMask.height > 4000000)
    return;
  try {
    const m = c.encodedMask,
      r = decodeMaskToRaster(m),
      set = new Set<number>();
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < m.width; x++)
        if (r[y * m.width + x]) {
          const gx = Math.floor(c.bbox[0] + ((x + 0.5) * c.bbox[2]) / m.width),
            gy = Math.floor(c.bbox[1] + ((y + 0.5) * c.bbox[3]) / m.height);
          set.add(gy * 32768 + gx);
          if (set.size > 100000) return;
        }
    return set;
  } catch {
    return;
  }
}
/** Require bidirectional exact-pixel agreement. Shared boxes, crossings and subsets never suffice. */
export function duplicateWire(
  a: Candidate,
  b: Candidate,
  read: (c: Candidate) => Set<number> | undefined = pixelsOf,
): boolean {
  if (
    a.bbox[0] >= b.bbox[0] + b.bbox[2] ||
    b.bbox[0] >= a.bbox[0] + a.bbox[2] ||
    a.bbox[1] >= b.bbox[1] + b.bbox[3] ||
    b.bbox[1] >= a.bbox[1] + a.bbox[3]
  )
    return false;
  const aa = read(a),
    bb = read(b);
  if (!aa?.size || !bb?.size) return false;
  let overlap = 0;
  for (const p of aa) if (bb.has(p)) overlap++;
  return overlap / aa.size >= 0.9 && overlap / bb.size >= 0.9;
}
export function createWireRecovery(
  config: Config,
  client: MetaClient = createMetaClient(config),
) {
  return async (
    input: {
      snapshot: SamSnapshot;
      ref: SnapshotRef;
      reviews: WireIdentity[];
      budget: RecoveryBudget;
      visited: BoundingBox[];
      cropAttempts?: CropAttempt[];
      operation: 'audit' | 'recover' | 'verify' | 'recover_short';
      target?: {
        pitchPx: number;
        gridPoints: [number, number][];
        manualPoint?: [number, number] | undefined;
      };
      candidateId?: string;
      previous?: RecoveryReport;
    },
    signal: AbortSignal,
    trace?: AnalysisTrace,
    progress?: (value: RecoveryProgress) => SnapshotRef | undefined,
  ): Promise<RecoveryProgress> => {
    let currentRef = input.ref;
    const snapshot = structuredClone(input.snapshot),
      budget = { ...input.budget },
      visited = [...input.visited],
      cropAttempts = normalizeCropAttempts(input.visited, input.cropAttempts);
    let report = await auditWireCoverage(
      snapshot,
      input.ref,
      input.reviews,
      config.WIRE_AUDIT_MAX_DIMENSION,
      input.previous,
    );
    if (input.previous?.reportId === report.reportId)
      report.modelReviews = input.previous.modelReviews;
    const emit = (changed = false) => {
      signal.throwIfAborted();
      const state = {
        report,
        snapshot,
        budget: { ...budget },
        visited: [...visited],
        cropAttempts: structuredClone(cropAttempts),
        changed,
      };
      progress?.(state);
      return state;
    };
    if (input.operation === 'audit') return emit();
    if (input.operation === 'verify') {
      if (budget.verificationRequests >= config.WIRE_VERIFY_MAX_REQUESTS)
        throw new AppError(
          409,
          'VERIFICATION_BUDGET',
          'The per-analysis Muse verification budget is exhausted.',
        );
      const candidate = report.candidates.find(
        (c) => c.id === input.candidateId,
      );
      if (!candidate?.mask)
        throw new AppError(
          400,
          'SEGMENTATION_REQUIRED',
          'Select a candidate with an observed pixel mask.',
        );
      if (candidate.touchesCropBoundary)
        throw new AppError(
          409,
          'CROP_FRAGMENT',
          'Recover the observed crop-edge continuation before insertion verification.',
        );
      budget.verificationRequests++;
      emit();
      const result = await createWireVerifier(config, client)(
        snapshot.image,
        candidate,
        signal,
        trace,
      );
      report.modelReviews = [
        ...report.modelReviews.filter((r) => r.candidateId !== candidate.id),
        result,
      ];
      return emit();
    }
    if (budget.rounds >= config.WIRE_RECOVERY_MAX_ROUNDS) {
      report.stopReason = 'request_budget';
      return emit();
    }
    budget.rounds++;
    emit();
    const pixelsCache = new Map<Candidate, Set<number> | undefined>();
    let decodedPixels = 0;
    const readPixels = (c: Candidate) => {
      if (pixelsCache.has(c)) return pixelsCache.get(c);
      const size = c.encodedMask
        ? c.encodedMask.width * c.encodedMask.height
        : 0;
      if (decodedPixels + size > 12000000) return;
      decodedPixels += size;
      const pixels = pixelsOf(c);
      pixelsCache.set(c, pixels);
      return pixels;
    };
    const deadline = Date.now() + config.WIRE_RECOVERY_TIMEOUT_MS;
    let changed = false,
      requests = 0;
    if (input.operation === 'recover_short' || input.operation === 'recover') {
      report.shortRegions = await shortWireRegions(
        snapshot,
        report,
        input.target,
        input.target?.manualPoint,
        cropAttempts,
      );
      emit();
    }
    const targeted = report.shortRegions ?? [];
    const regions = recoveryPlan(
      input.operation === 'recover'
        ? continuationRegions(
            snapshot,
            report,
            config.WIRE_RECOVERY_MAX_CROP_PIXELS,
          )
        : [],
      targeted.map((t) => ({
        ...t,
        mode: t.source === 'human' ? ('human' as const) : ('short' as const),
      })),
      input.operation === 'recover' ? report.cropRegions : [],
      cropAttempts,
    );
    for (const work of regions) {
      const { crop, targets } = work;
      if (snapshot.candidates.length >= 100) {
        report.stopReason = 'candidate_budget';
        break;
      }
      if (requests >= config.WIRE_RECOVERY_REQUESTS_PER_ROUND) break;
      signal.throwIfAborted();
      const area = crop[2] * crop[3];
      if (budget.requests >= config.WIRE_RECOVERY_MAX_REQUESTS) {
        report.stopReason = 'request_budget';
        break;
      }
      if (
        budget.pixels + area > config.WIRE_RECOVERY_MAX_PIXELS ||
        area > config.WIRE_RECOVERY_MAX_CROP_PIXELS
      ) {
        report.stopReason = 'pixel_budget';
        continue;
      }
      if (Date.now() >= deadline) {
        report.stopReason = 'deadline';
        break;
      }
      budget.requests++;
      budget.pixels += area;
      requests++;
      visited.push(crop);
      const spatialPrompts = targets.map((t) => ({
        bbox: t.bbox,
        positivePoints: t.positivePoints,
        negativePoints: t.negativePoints,
      }));
      const attempt: CropAttempt = {
        attemptId: randomUUID(),
        region: crop,
        workKeys: work.workKeys,
        ...(spatialPrompts.length
          ? { spatialPrompt: spatialPrompts[0]!, spatialPrompts }
          : {}),
        sourceCandidateIds: targets.flatMap((t) =>
          t.candidateId ? [t.candidateId] : [],
        ),
        mode: work.mode,
        status: 'running',
        upstreamOutcome: 'not_sent',
        startedAt: Date.now(),
        sourceSnapshotId: currentRef.samSnapshotId,
        sourceSnapshotHash: currentRef.samSnapshotHash,
      };
      cropAttempts.push(attempt);
      emit();
      try {
        const [left, top, width, height] = crop,
          bytes = await sharp(
            Buffer.from(snapshot.image.dataUrl.split(',')[1]!, 'base64'),
          )
            .extract({ left, top, width, height })
            .jpeg({ quality: 95 })
            .toBuffer();
        const image: PreparedImage = {
          width,
          height,
          dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        };
        signal.throwIfAborted();
        attempt.upstreamOutcome = 'unknown';
        emit();
        const prompt = targets.length
          ? buildWirePrompt(
              targets.map((target, i) => ({
                id: i + 1,
                bbox: [
                  target.bbox[0] - left,
                  target.bbox[1] - top,
                  target.bbox[2],
                  target.bbox[3],
                ],
                positivePoints: target.positivePoints.map(([x, y]) => [
                  x - left,
                  y - top,
                ]),
                negativePoints: target.negativePoints.map(([x, y]) => [
                  x - left,
                  y - top,
                ]),
              })),
              image,
            )
          : 'wire';
        const raw = await client.post(
          'responses',
          {
            model: config.META_SAM_MODEL,
            stream: false,
            input: [
              {
                type: 'message',
                role: 'user',
                content: [
                  { type: 'input_text', text: prompt },
                  { type: 'input_image', image_url: image.dataUrl },
                ],
              },
            ],
            metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
          },
          signal,
          {
            stage: 'sam.wire_crop',
            maxRetries: 0,
            timeoutMs: Math.max(
              1,
              Math.min(config.PROVIDER_TIMEOUT_MS, deadline - Date.now()),
            ),
            imageDimensions: [{ width, height }],
            ...(trace ? { trace } : {}),
          },
        );
        attempt.upstreamOutcome = 'response_received';
        signal.throwIfAborted();
        const native = decodeSamResponse(raw, 'jumper_wire', image, true),
          first =
            1 +
            Math.max(
              0,
              ...snapshot.candidates
                .filter((c) => c.type === 'jumper_wire')
                .map((c) => Number(c.id.split('_').at(-1))),
            );
        const global = reprojectCrop(
          native.map((c, i) => {
            const target = targets[(c.samObjectId ?? 0) - 1];
            return {
              ...c,
              id: `jumper_wire_${i + 1}`,
              ...(targets.length
                ? {
                    recoveryPromptMatched:
                      !!target &&
                      supportsSpatialPrompt(
                        c,
                        target.positivePoints.map(([x, y]) => [
                          x - left,
                          y - top,
                        ]),
                        target.negativePoints.map(([x, y]) => [
                          x - left,
                          y - top,
                        ]),
                      ),
                  }
                : {}),
            };
          }),
          crop,
          first,
        );
        for (const candidate of global) {
          if (snapshot.candidates.length >= 100) break;
          if (
            !snapshot.candidates.some(
              (old) =>
                old.type === 'jumper_wire' &&
                duplicateWire(candidate, old, readPixels),
            )
          ) {
            snapshot.candidates.push(candidate);
            changed = true;
          }
        }
        if (changed) {
          const saved = progress?.({
            report,
            snapshot,
            budget: { ...budget },
            visited: [...visited],
            cropAttempts: structuredClone(cropAttempts),
            changed: true,
          });
          if (!saved)
            throw new AppError(
              500,
              'CHECKPOINT_REQUIRED',
              'Recovery requires a durable checkpoint writer.',
            );
          currentRef = saved;
        }
        attempt.status = 'succeeded';
        attempt.finishedAt = Date.now();
        emit();
        report = await auditWireCoverage(
          snapshot,
          currentRef,
          input.reviews,
          config.WIRE_AUDIT_MAX_DIMENSION,
          report,
        );
        if (targeted.length) report.shortRegions = targeted;
        report.stopReason = 'round_complete';
        changed = false;
        emit();
      } catch (error) {
        if (signal.aborted) throw error;
        if (attempt.status === 'running') {
          attempt.status =
            error instanceof AppError &&
            ['PROVIDER_TIMEOUT', 'META_API_TIMEOUT'].includes(error.code)
              ? 'timed_out'
              : 'failed';
          attempt.finishedAt = Date.now();
          attempt.errorCode =
            error instanceof AppError ? error.code : 'CROP_FAILED';
        }
        report.stopReason =
          error instanceof AppError &&
          ['PROVIDER_TIMEOUT', 'META_API_TIMEOUT'].includes(error.code)
            ? 'provider_timeout'
            : 'provider_error';
        emit();
        throw error;
      }
    }
    if (!regions.length)
      report.stopReason = cropAttempts.some((a) => a.status !== 'succeeded')
        ? 'blocked_regions'
        : 'no_actionable_regions';
    else if (report.stopReason === 'audit_only')
      report.stopReason = 'round_complete';
    return emit(changed);
  };
}
