import type { Config } from '../config.js';
import type { AnalysisTrace } from '../lib/diagnostics.js';
import { abortError, invalidProviderOutput } from '../lib/errors.js';
import { createMetaClient, type MetaClient } from '../lib/meta-client.js';
import {
  analysisSchema,
  type Analysis,
  type Component,
  type Detection,
  type BoundingBox,
  type PreparedImage,
  type ComponentType,
  type Candidate,
} from '../schemas/vision.js';
import { prepareImage } from './image.js';
import { createReasoningService } from './reasoning.js';
import { createSamService } from './sam.js';
import { consolidateBreadboards } from './breadboards.js';
import {
  createWireResolution,
  normalizedBoxToPixels,
  type ReviewedWire,
} from './wire-refinement.js';
import type { WireRegion } from '../schemas/geometry.js';
export { normalizedBoxToPixels } from './wire-refinement.js';

function intersectionOverUnion(a: BoundingBox, b: BoundingBox): number {
  const intersection =
    Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return intersection / (a[2] * a[3] + b[2] * b[3] - intersection);
}

function isDuplicate(a: Detection, b: Detection): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'jumper_wire' || a.type === 'breadboard') return false;
  return intersectionOverUnion(a.bbox, b.bbox) > 0.9;
}

/**
 * Preserve separate SAM wire instances even when their rectangular boxes overlap.
 * Curved/crossing wires can share a box without sharing a segmentation mask.
 * Wire deduplication happens later against the decoded masks.
 * Preserve breadboard regions too: Muse reviews their part/whole relationships
 * before board consolidation. Overlap alone cannot establish board identity.
 */
export function deduplicate<T extends Detection>(objects: T[]): T[] {
  const kept: T[] = [];
  for (const object of [...objects].sort(
    (a, b) =>
      Number(b.localizationSource === 'sam') -
        Number(a.localizationSource === 'sam') ||
      (b.confidence ?? 0) - (a.confidence ?? 0),
  )) {
    if (!kept.some((other) => isDuplicate(object, other))) kept.push(object);
  }
  return kept.sort(
    (a, b) =>
      a.type.localeCompare(b.type) ||
      a.bbox[1] - b.bbox[1] ||
      a.bbox[0] - b.bbox[0],
  );
}

export function withIds<T extends { type: ComponentType; bbox: BoundingBox }>(
  objects: T[],
) {
  const counters = new Map<string, number>();
  return objects.map((object) => {
    const count = (counters.get(object.type) ?? 0) + 1;
    counters.set(object.type, count);
    return { ...object, id: `${object.type}_${count}` };
  });
}

/** Primary perception failures propagate; optional wire refinement retains explicit unresolved regions. */
export function createVisionService(
  config: Config,
  client: MetaClient = createMetaClient(config),
) {
  const segment = createSamService(config, client);
  const reasoning = createReasoningService(config, client);
  const resolveWires = createWireResolution(config, client);
  return async (
    bytes: Buffer,
    signal: AbortSignal,
    trace?: AnalysisTrace,
    snapshot?: SamSnapshot,
  ): Promise<Analysis> => {
    const finishPrepare = trace?.begin('image.prepare');
    let image: PreparedImage;
    try {
      image = snapshot?.image ?? (await prepareImage(bytes, config));
      if (signal.aborted) throw abortError(signal);
      finishPrepare?.('completed');
    } catch (error) {
      finishPrepare?.(signal.aborted ? 'cancelled' : 'failed');
      throw error;
    }
    signal.throwIfAborted();
    let objects: Component[];
    let proposals: WireRegion[] = [];
    let wireAudit: Analysis['provenance']['wireAudit'];
    let breadboardAudit: Analysis['breadboardAudit'];
    if (config.VISION_MODE === 'combined') {
      const candidates =
        snapshot?.candidates ??
        withIds(
          deduplicate(
            (await segment(image, signal, trace)).map((detection) => ({
              ...detection,
              localizationSource: 'sam' as const,
            })),
          ),
        );
      // Review the whole image even when SAM found no candidates. Missing wires
      // must not be hidden by the same detection bottleneck being audited.
      const review = await reasoning.interpret(
        image,
        candidates,
        signal,
        trace,
      );
      const consolidated = consolidateBreadboards(
        candidates,
        review.objects,
        review,
      );
      breadboardAudit = consolidated.audit;
      const interpretations = new Map(
        review.objects.map((entry) => [entry.id, entry]),
      );
      const accepted: ReviewedWire[] = candidates.flatMap((candidate) => {
        const interpretation = interpretations.get(candidate.id)!;
        if (interpretation.decision === 'rejected') return [];
        return [
          {
            ...candidate,
            interpretation: interpretation.decision,
            ...(interpretation.color === null
              ? {}
              : { color: interpretation.color }),
          },
        ];
      });
      const resolved = await resolveWires(
        image,
        accepted.filter((candidate) => candidate.type === 'jumper_wire'),
        review.missingWires,
        signal,
        trace,
      );
      proposals = resolved.proposals;
      const nonWires = accepted
        .filter(
          (candidate) =>
            candidate.type !== 'jumper_wire' && candidate.type !== 'breadboard',
        )
        .map((candidate) => ({
          type: candidate.type,
          bbox: candidate.bbox,
          interpretation: candidate.interpretation,
          localizationSource: 'sam' as const,
          geometryStatus: 'box_only' as const,
          guidanceEligible: false as const,
          ...(candidate.confidence === undefined
            ? {}
            : { confidence: candidate.confidence }),
          ...(candidate.color ? { color: candidate.color } : {}),
        }));
      objects = withIds(
        [...consolidated.boards, ...nonWires, ...resolved.wires].sort(
          (a, b) =>
            a.type.localeCompare(b.type) ||
            a.bbox[1] - b.bbox[1] ||
            a.bbox[0] - b.bbox[0],
        ),
      );
      wireAudit = {
        samCandidates: candidates.filter(
          (object) => object.type === 'jumper_wire',
        ).length,
        acceptedSam: resolved.acceptedSam,
        recoveredByMuse: resolved.recoveredByMuse,
        regionsProposedByMuse: review.missingWires.length,
        refinementAttempts: resolved.refinementAttempts,
        unresolvedRegions: proposals.length,
      };
      trace?.emit('vision.wire_audit', wireAudit);
    } else {
      const observations = await reasoning.detect(image, signal, trace);
      proposals = observations
        .filter((observation) => observation.type === 'jumper_wire')
        .map((observation, index) => ({
          id: `wire_region_${index + 1}`,
          type: 'jumper_wire',
          bbox: normalizedBoxToPixels(observation.box, image),
          refinementStatus: 'not_attempted',
          reason: 'sam_unavailable',
          guidanceEligible: false,
          ...(observation.color ? { color: observation.color } : {}),
        }));
      const detections = observations
        .filter((observation) => observation.type !== 'jumper_wire')
        .map((observation) => {
          const bbox = normalizedBoxToPixels(observation.box, image);
          return {
            type: observation.type,
            bbox,
            interpretation: observation.interpretation,
            localizationSource: 'muse' as const,
            geometryStatus: 'box_only' as const,
            guidanceEligible: false as const,
            ...(observation.color === null ? {} : { color: observation.color }),
          };
        });
      objects = withIds(deduplicate(detections));
    }
    signal.throwIfAborted();
    const finishValidation = trace?.begin('response.validate');
    const result = analysisSchema.safeParse({
      image: { width: image.width, height: image.height },
      objects,
      proposals,
      ...(breadboardAudit ? { breadboardAudit } : {}),
      provenance: {
        mode: config.VISION_MODE,
        reasoningModel: config.META_REASONING_MODEL,
        ...(wireAudit ? { wireAudit } : {}),
        ...(config.VISION_MODE === 'combined'
          ? { segmentationModel: config.META_SAM_MODEL }
          : {}),
      },
    });
    if (!result.success) {
      finishValidation?.('failed');
      throw invalidProviderOutput();
    }
    finishValidation?.('completed');
    return result.data;
  };
}

/** Durable checkpoint in the original, orientation-corrected image frame. */
export interface SamSnapshot {
  image: PreparedImage;
  candidates: Candidate[];
}
export function createVisionStages(
  config: Config,
  client = createMetaClient(config),
) {
  const sam = createSamService(config, client);
  // Missing-wire proposals stay unresolved; interpretation retries must never invoke SAM.
  const analyze = createVisionService(
    { ...config, MAX_WIRE_REFINEMENTS: 0 },
    client,
  );
  return {
    async segment(
      image: PreparedImage,
      signal: AbortSignal,
      trace?: AnalysisTrace,
    ): Promise<SamSnapshot> {
      const candidates = withIds(
        deduplicate(
          (await sam(image, signal, trace)).map((d) => ({
            ...d,
            localizationSource: 'sam' as const,
          })),
        ),
      );
      if (candidates.length > 100) throw invalidProviderOutput();
      return { image, candidates };
    },
    interpret(
      snapshot: SamSnapshot,
      signal: AbortSignal,
      trace?: AnalysisTrace,
    ) {
      return analyze(Buffer.alloc(0), signal, trace, snapshot);
    },
  };
}
