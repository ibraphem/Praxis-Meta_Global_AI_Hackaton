import { cropFragment } from './wire-fragments.js';
import type { Config } from '../config.js';
import { AppError, abortError } from '../lib/errors.js';
import type { AnalysisTrace } from '../lib/diagnostics.js';
import type { MetaClient } from '../lib/meta-client.js';
import type {
  BoundingBox,
  Candidate,
  Component,
  PreparedImage,
} from '../schemas/vision.js';
import type { WirePrompt, WireRegion } from '../schemas/geometry.js';
import { WireGeometry } from './wire-geometry.js';
import { createWireRefiner } from './sam.js';

export interface MissedWire {
  box: [number, number, number, number];
  color: string | null;
  positivePoints: [number, number][];
  negativePoints: [number, number][];
}
export interface ReviewedWire extends Candidate {
  interpretation: 'confirmed' | 'uncertain';
  color?: string;
}

export function normalizedBoxToPixels(
  box: readonly [number, number, number, number],
  image: Pick<PreparedImage, 'width' | 'height'>,
): BoundingBox {
  const [left, top, right, bottom] = box;
  const x = Math.floor((left * image.width) / 1000),
    y = Math.floor((top * image.height) / 1000);
  return [
    x,
    y,
    Math.ceil((right * image.width) / 1000) - x,
    Math.ceil((bottom * image.height) / 1000) - y,
  ];
}
const inside = (point: [number, number], box: BoundingBox) =>
  point[0] >= box[0] &&
  point[1] >= box[1] &&
  point[0] < box[0] + box[2] &&
  point[1] < box[1] + box[3];

/** Optional, one-batch refinement. Failure preserves primary results and unresolved hypotheses. */
export function createWireResolution(config: Config, client: MetaClient) {
  const refine = createWireRefiner(config, client);
  return async (
    image: PreparedImage,
    accepted: ReviewedWire[],
    missing: MissedWire[],
    signal: AbortSignal,
    trace?: AnalysisTrace,
  ) => {
    const geometry = new WireGeometry(image);
    const wires: Omit<Component, 'id'>[] = [];
    const regions: Omit<WireRegion, 'id'>[] = [];
    const finishPrimary = accepted.length
      ? trace?.begin('wire.geometry')
      : undefined;
    for (const wire of accepted) {
      if (signal.aborted) throw abortError(signal);
      const resolved = geometry.resolve(wire);
      if (resolved.ok)
        wires.push({
          type: 'jumper_wire',
          bbox: wire.bbox,
          interpretation: wire.interpretation,
          localizationSource: 'sam',
          detectionSource: 'sam',
          geometryStatus: 'segmented',
          mask: resolved.mask.geometry,
          ...(cropFragment(wire).cropOrigin
            ? {
                cropOrigin: cropFragment(wire).cropOrigin!,
                touchesCropBoundary: cropFragment(wire).touchesCropBoundary,
              }
            : {}),
          guidanceEligible: false,
          identityStatus: 'unverified',
          ...(wire.confidence === undefined
            ? {}
            : { confidence: wire.confidence }),
          ...(wire.color ? { color: wire.color } : {}),
        });
      else
        regions.push({
          type: 'jumper_wire',
          bbox: wire.bbox,
          refinementStatus: 'ambiguous',
          reason: resolved.reason,
          guidanceEligible: false,
          ...(wire.color ? { color: wire.color } : {}),
        });
    }
    finishPrimary?.('completed');
    const acceptedSam = wires.length;
    const prompts: WirePrompt[] = [];
    const proposals = new Map<
      number,
      { wire: MissedWire; bbox: BoundingBox }
    >();
    const toPoint = ([x, y]: [number, number]): [number, number] => [
      Math.min(image.width - 1, Math.floor((x * image.width) / 1000)),
      Math.min(image.height - 1, Math.floor((y * image.height) / 1000)),
    ];
    for (const [id, wire] of missing.entries()) {
      const bbox = normalizedBoxToPixels(wire.box, image);
      const base = {
        type: 'jumper_wire' as const,
        bbox,
        guidanceEligible: false as const,
        ...(wire.color ? { color: wire.color } : {}),
      };
      const positives = wire.positivePoints.map(toPoint);
      const negatives = wire.negativePoints.map(toPoint);
      if (
        !positives.length ||
        !positives.every((point) => inside(point, bbox))
      ) {
        regions.push({
          ...base,
          refinementStatus: 'not_attempted',
          reason: 'missing_anchor',
        });
        continue;
      }
      if (prompts.length >= config.MAX_WIRE_REFINEMENTS) {
        regions.push({
          ...base,
          refinementStatus: 'not_attempted',
          reason: 'budget_exhausted',
        });
        continue;
      }
      prompts.push({
        id,
        bbox,
        positivePoints: positives,
        negativePoints: negatives,
      });
      proposals.set(id, { wire, bbox });
    }
    let attempts = 0;
    const remaining =
      config.ANALYSIS_TIMEOUT_MS - (trace?.elapsedMs ?? 0) - 1000;
    if (prompts.length && remaining > 1000) {
      attempts = prompts.length;
      try {
        const detections = await refine(
          image,
          prompts,
          signal,
          trace,
          Math.min(config.REFINEMENT_TIMEOUT_MS, remaining),
        );
        const finishRefined = trace?.begin('wire.geometry');
        for (const prompt of prompts) {
          const proposal = proposals.get(prompt.id)!;
          const base = {
            type: 'jumper_wire' as const,
            bbox: proposal.bbox,
            guidanceEligible: false as const,
            ...(proposal.wire.color ? { color: proposal.wire.color } : {}),
          };
          const detection = detections.find(
            (item) => item.samObjectId === prompt.id,
          );
          if (!detection) {
            regions.push({
              ...base,
              refinementStatus: 'ambiguous',
              reason: 'no_mask',
            });
            continue;
          }
          const resolved = geometry.resolve(detection, prompt);
          if (!resolved.ok) {
            regions.push({
              ...base,
              refinementStatus: 'ambiguous',
              reason: resolved.reason,
            });
            continue;
          }
          wires.push({
            type: 'jumper_wire',
            bbox: detection.bbox,
            localizationSource: 'sam',
            detectionSource: 'muse',
            geometryStatus: 'segmented',
            mask: resolved.mask.geometry,
            ...(cropFragment(detection).cropOrigin
              ? {
                  cropOrigin: cropFragment(detection).cropOrigin!,
                  touchesCropBoundary:
                    cropFragment(detection).touchesCropBoundary,
                }
              : {}),
            interpretation: 'uncertain',
            guidanceEligible: false,
            identityStatus: 'unverified',
            ...(detection.confidence === undefined
              ? {}
              : { confidence: detection.confidence }),
            ...(proposal.wire.color ? { color: proposal.wire.color } : {}),
          });
        }
        finishRefined?.('completed');
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        const timedOut =
          error instanceof AppError &&
          ['PROVIDER_TIMEOUT', 'META_API_TIMEOUT'].includes(error.code);
        for (const { wire, bbox } of proposals.values())
          regions.push({
            type: 'jumper_wire',
            bbox,
            guidanceEligible: false,
            refinementStatus: timedOut ? 'timed_out' : 'failed',
            reason: timedOut ? 'provider_timeout' : 'provider_error',
            ...(error instanceof AppError
              ? { refinementCode: error.code }
              : {}),
            ...(wire.color ? { color: wire.color } : {}),
          });
        trace?.emit('vision.refinement_failed', {
          code: error instanceof AppError ? error.code : 'REFINEMENT_FAILED',
        });
      }
    } else
      for (const { wire, bbox } of proposals.values())
        regions.push({
          type: 'jumper_wire',
          bbox,
          guidanceEligible: false,
          refinementStatus: 'not_attempted',
          reason: 'budget_exhausted',
          ...(wire.color ? { color: wire.color } : {}),
        });
    return {
      wires,
      proposals: regions.map((region, index) => ({
        ...region,
        id: `wire_region_${index + 1}`,
      })),
      acceptedSam,
      recoveredByMuse: wires.length - acceptedSam,
      refinementAttempts: attempts,
    };
  };
}
