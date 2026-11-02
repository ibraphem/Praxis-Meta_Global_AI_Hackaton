import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JobStore, Job } from './store.js';
import { newAttempt, lastAttempt } from './store.js';
import type { Config } from '../config.js';
import type { MetaClient } from '../lib/meta-client.js';
import type { AnalysisTrace } from '../lib/diagnostics.js';
import { AppError } from '../lib/errors.js';
import { canonicalHash } from '../lib/canonical-json.js';
import {
  SceneRequestRecorder,
  sceneRequestEvidence,
  sha256,
} from './scene-request-evidence.js';
import { resolveAcceptedConnectorMask } from './accepted-connector-mask.js';
import { getSceneSnapshot } from './scene-snapshots.js';
import {
  ensureJunctionTables,
  getJunction,
  changeJunction,
  type JunctionPrivateRecord,
} from './connector-junction-records.js';
import {
  junctionCrop,
  junctionPolicy,
  generateJunctionCandidates,
  unresolvedJunctions,
  effectiveJunctions,
  evaluateJunctions,
  junctionRaster,
  junctionRasterHash,
  type JunctionConductor,
} from '../services/connector-junctions.js';
import {
  junctionImages,
  junctionMusePayload,
  decodeJunctionResponse,
} from '../services/connector-junction-muse.js';
import {
  junctionPlanSchema,
  junctionRecordSchema,
  junctionReviewSchema,
  junctionReferenceContentSchema,
  type JunctionPlan,
  type JunctionRecord,
  type JunctionReference,
  type JunctionReview,
  type JunctionEvaluation,
} from '../schemas/connector-junctions.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export class ConnectorJunctionService {
  constructor(readonly store: JobStore) {
    ensureJunctionTables(store);
  }
  get(planId: string, analysisId?: string) {
    return getJunction(this.store, planId, analysisId);
  }
  private rows<T>(table: string, planId: string): T[] {
    return this.store.db
      .prepare(`SELECT data FROM ${table} WHERE plan_id=? ORDER BY rowid`)
      .all(planId)
      .map((r) => JSON.parse(r.data as string) as T);
  }
  private validateCurrent(r: JunctionPrivateRecord) {
    const current = resolveAcceptedConnectorMask(
      this.store,
      r.plan.analysisId,
      r.plan.connectorObjectId,
    );
    if (
      current.job.scene?.snapshotRef?.snapshotHash !==
        r.plan.inputSnapshotHash ||
      canonicalHash(current.segmentation) !==
        canonicalHash(r.plan.segmentation) ||
      current.samRef.samSnapshotHash !== r.plan.samSnapshotHash ||
      current.job.imageHash !== r.plan.imageHash
    )
      throw new AppError(
        409,
        'STALE_JUNCTION_PLAN',
        'Source segmentation or scene changed. No junction request can be dispatched.',
      );
    if (
      junctionRasterHash(junctionRaster(r.evidence.body)) !==
        r.plan.segmentation.acceptedRasterHash ||
      canonicalHash(r.evidence.acceptanceEvidence) !==
        r.plan.acceptanceEvidenceHash ||
      sha256(JSON.stringify(r.evidence.requestBody)) !==
        r.plan.requestPayloadHash ||
      canonicalHash(r.evidence.body.encodedMask) !==
        r.plan.segmentation.nativeHash ||
      r.evidence.images.some(
        (v, i) =>
          sha256(Buffer.from(v.base64, 'base64')) !==
          r.plan.inputImages[i]?.sha256,
      )
    )
      throw new AppError(
        409,
        'JUNCTION_EVIDENCE_MISMATCH',
        'Frozen junction input evidence failed its integrity check.',
      );
    return current;
  }
  async prepare(analysisId: string, body: unknown) {
    const parsed = z
      .object({
        connectorObjectId: z.uuid(),
        conductorObjectIds: z.tuple([z.uuid(), z.uuid()]),
        snapshotHash: hash,
        useMuse: z.boolean().default(false),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new AppError(
        400,
        'INVALID_JUNCTION_PLAN',
        'Choose one connector, two distinct conductors and the current scene.',
      );
    const startedAt = Date.now(),
      input = parsed.data,
      accepted = resolveAcceptedConnectorMask(
        this.store,
        analysisId,
        input.connectorObjectId,
      ),
      { job } = accepted;
    if (job.scene?.snapshotRef?.snapshotHash !== input.snapshotHash)
      throw new AppError(
        409,
        'STALE_SCENE',
        'Reload the scene before preparing junction discovery.',
      );
    const graph = accepted.sourceSnapshot.graph;
    if (
      new Set(input.conductorObjectIds).size !== 2 ||
      input.conductorObjectIds.some(
        (id) =>
          !graph.objects.some((o) => o.id === id && o.category === 'conductor'),
      )
    )
      throw new AppError(
        400,
        'INVALID_JUNCTION_CONDUCTORS',
        'Choose two distinct persisted conductor hypotheses.',
      );
    const snapshot = this.store.getSnapshot(accepted.samRef.samSnapshotId),
      crop = junctionCrop(accepted.segmentation.acceptedBounds, job.image);
    if (
      crop[2] * crop[3] >
      Math.min(
        2000000,
        job.scene?.settings?.maxCropPixels ??
          this.store.config.SCENE_MAX_CROP_PIXELS,
      )
    )
      throw new AppError(
        409,
        'JUNCTION_CROP_BUDGET',
        'Connector junction crop exceeds its pixel budget.',
      );
    const conductors: JunctionConductor[] = input.conductorObjectIds.map(
      (id) => {
        const object = graph.objects.find((o) => o.id === id)!;
        const masks = graph.associations
          .filter((a) => a.objectId === id)
          .flatMap((a) => {
            const review = graph.maskIdentityReviews
                ?.filter(
                  (r) =>
                    r.objectId === id && r.observationId === a.observationId,
                )
                .at(-1),
              o = graph.observations.find((o) => o.id === a.observationId)!;
            if (
              review?.source !== 'human_review' ||
              review.decision !== 'accepted' ||
              graph.associations.some(
                (other) =>
                  other.observationId === o.id &&
                  other.objectId !== id &&
                  other.basis !== 'inventory',
              )
            )
              return [];
            const local = accepted.sourceSnapshot.native.find(
              (n) => n.observationId === o.id,
            )?.encodedMask;
            const baseline =
              o.samSnapshotId === accepted.samRef.samSnapshotId &&
              o.samSnapshotHash === accepted.samRef.samSnapshotHash
                ? snapshot.snapshot.candidates.find(
                    (c) => c.id === o.sourceCandidateId,
                  )?.encodedMask
                : undefined;
            const encodedMask = local ?? baseline;
            return encodedMask
              ? [{ observationId: o.id, bbox: o.bbox, encodedMask }]
              : [];
          });
        return {
          objectId: id,
          bbox: object.bbox,
          masks,
          proposedType: object.proposedType,
        };
      },
    );
    const generated = generateJunctionCandidates(
        accepted.body,
        conductors,
        crop,
      ),
      images = await junctionImages(
        snapshot.snapshot.image,
        accepted.body,
        crop,
        generated.candidates,
      );
    const payload = junctionMusePayload(
      job.settings.museModel,
      input.connectorObjectId,
      input.conductorObjectIds,
      crop,
      generated.candidates,
      images,
      conductors,
    );
    const pixels = input.useMuse
      ? images.reduce((n, i) => n + i.width * i.height, 0)
      : 0;
    if (
      pixels >
      (job.scene?.settings?.maxTerminalPixels ??
        this.store.config.SCENE_MAX_TERMINAL_PIXELS)
    )
      throw new AppError(
        409,
        'TERMINAL_BUDGET',
        'Both junction images exceed the effective terminal pixel allowance.',
      );
    const core = {
      version: 'connector-junction-plan-v1' as const,
      analysisId,
      connectorObjectId: input.connectorObjectId,
      conductorObjectIds: input.conductorObjectIds,
      imageHash: job.imageHash,
      image: job.image,
      inputSnapshotId: job.scene!.snapshotRef!.snapshotId,
      inputSnapshotHash: input.snapshotHash,
      samSnapshotId: accepted.samRef.samSnapshotId,
      samSnapshotHash: accepted.samRef.samSnapshotHash,
      segmentation: accepted.segmentation,
      crop,
      candidates: generated.candidates,
      policy: junctionPolicy,
      inputImages: images.map((i) => ({
        kind: i.kind,
        sha256: i.sha256,
        width: i.width,
        height: i.height,
        bytes: i.bytes.length,
        mimeType: i.mimeType,
      })),
      useMuse: input.useMuse,
      providerBaseUrl: this.store.config.META_BASE_URL,
      model: job.settings.museModel,
      requestPayloadHash: sha256(JSON.stringify(payload)),
      acceptanceEvidenceHash: canonicalHash(accepted.acceptanceEvidence),
      budget: {
        samRequests: 0 as const,
        museRequests: input.useMuse ? (1 as const) : (0 as const),
        inputPixels: pixels,
        maxRetries: 0 as const,
        timeoutMs: Math.min(
          this.store.config.SCENE_STAGE_TIMEOUT_MS,
          this.store.config.PROVIDER_TIMEOUT_MS,
        ),
      },
      scopeHash: canonicalHash([
        analysisId,
        job.imageHash,
        input.connectorObjectId,
        accepted.segmentation.acceptedRasterHash,
        [...input.conductorObjectIds].sort(),
      ]),
    };
    const plan = junctionPlanSchema.parse({
      planId: canonicalHash(core),
      ...core,
    });
    return this.store.transaction(() => {
      const existing = this.store.db
        .prepare('SELECT id FROM connector_junctions WHERE id=?')
        .get(plan.planId);
      if (existing) return this.get(plan.planId, analysisId);
      if (
        (this.store.db
          .prepare(
            'SELECT COUNT(*) n FROM connector_junctions WHERE analysis_id=?',
          )
          .get(analysisId)!.n as number) >= 20
      )
        throw new AppError(
          409,
          'JUNCTION_LIMIT',
          'The retained junction-plan limit was reached.',
        );
      const record: JunctionPrivateRecord = {
        plan,
        revision: 0,
        preparedAt: Date.now(),
        phase: 'prepared',
        attemptId: null,
        requestId: null,
        admittedAt: null,
        startedAt: null,
        finishedAt: null,
        dispatchedAt: null,
        responseAt: null,
        errorCode: null,
        outcomes: unresolvedJunctions(
          plan,
          'Geometry supplies proximity/search proposals only; attachment requires visible evidence or human review.',
        ),
        latency: {
          preparationMs: Date.now() - startedAt,
          queueMs: null,
          providerMs: null,
          totalMs: null,
        },
        evidence: {
          body: accepted.body,
          acceptanceEvidence: accepted.acceptanceEvidence,
          conductors,
          boundaryPixelCount: generated.boundaryPixelCount,
          boundarySampleStride: generated.boundarySampleStride,
          images: images.map((i) => ({
            kind: i.kind,
            mimeType: i.mimeType,
            base64: i.bytes.toString('base64'),
            sha256: i.sha256,
          })),
          requestBody: payload,
        },
      };
      this.validateCurrent(record);
      this.store.db
        .prepare('INSERT INTO connector_junctions VALUES (?,?,?)')
        .run(plan.planId, analysisId, JSON.stringify(record));
      return record;
    });
  }
  admit(analysisId: string, body: unknown) {
    const key = z.object({ planId: hash }).passthrough().safeParse(body);
    if (!key.success)
      throw new AppError(
        400,
        'INVALID_JUNCTION_PLAN',
        'Choose a frozen junction plan.',
      );
    return this.store.transaction(() => {
      const r = this.get(key.data.planId, analysisId),
        p = r.plan;
      const approval = z
        .object({
          planId: z.literal(p.planId),
          authorizeInference: z.literal(p.useMuse),
          providerBaseUrl: z.literal(p.providerBaseUrl),
          museRequests: z.literal(p.budget.museRequests),
          pixels: z.literal(p.budget.inputPixels),
        })
        .strict()
        .safeParse(body);
      if (!approval.success)
        throw new AppError(
          400,
          'INVALID_JUNCTION_AUTHORIZATION',
          'Authorize exactly the frozen provider, request count and all input-image pixels.',
        );
      const { job } = this.validateCurrent(r);
      if (
        r.phase !== 'prepared' ||
        r.admittedAt !== null ||
        this.store.db
          .prepare(
            "SELECT id FROM connector_junctions WHERE analysis_id=? AND json_extract(data,'$.plan.scopeHash')=? AND json_type(data,'$.admittedAt')='integer'",
          )
          .get(analysisId, p.scopeHash)
      )
        throw new AppError(
          409,
          'JUNCTION_ALREADY_ATTEMPTED',
          'This connector/mask/conductor scope already has an admitted attempt. No repeated tuning or provider replay is permitted.',
        );
      if (
        this.store.experiments.active() ||
        job.owner ||
        [
          job.sam.status,
          job.muse.status,
          job.recovery.status,
          job.scene!.status,
        ].some((s) => s === 'running' || s === 'queued')
      )
        throw new AppError(
          409,
          'ATTEMPT_ACTIVE',
          'Wait for active model work to finish.',
        );
      if (job.scene!.attempts.length >= 20)
        throw new AppError(
          409,
          'ATTEMPT_LIMIT',
          'The scene attempt limit was reached.',
        );
      if (
        job.scene!.terminalWork?.some(
          (w) => w.objectId === p.connectorObjectId,
        ) ||
        job.scene!.attempts.some(
          (a) =>
            a.sceneOperation === 'terminals' &&
            !a.junctionPlanId &&
            a.terminalObjectIds?.includes(p.connectorObjectId),
        )
      )
        throw new AppError(
          409,
          'JUNCTION_ALREADY_ATTEMPTED',
          'This connector already has a terminal attempt. Phase 4B will not silently repeat it.',
        );
      this.checkBudget(job, p);
      const attempt = {
        ...newAttempt(),
        sceneOperation: 'terminals' as const,
        junctionPlanId: p.planId,
        terminalObjectIds: [p.connectorObjectId],
        sceneSnapshotId: p.inputSnapshotId,
        sceneSnapshotHash: p.inputSnapshotHash,
        samSnapshotId: p.samSnapshotId,
        samSnapshotHash: p.samSnapshotHash,
        snapshotBinding: 'recorded' as const,
      };
      job.scene!.attempts.push(attempt);
      job.scene!.status = 'queued';
      changeJunction(this.store, p.planId, (next) => {
        next.phase = 'queued';
        next.attemptId = attempt.attemptId;
        next.requestId = p.useMuse ? randomUUID() : null;
        next.admittedAt = Date.now();
      });
      this.store.save(job);
      return job;
    });
  }
  private checkBudget(job: Job, p: JunctionPlan) {
    if (!p.useMuse) return;
    if (
      (job.scene!.budget.terminalRequests ?? 0) + p.budget.museRequests >
        (job.scene!.settings?.maxTerminalRequests ??
          this.store.config.SCENE_MAX_TERMINAL_REQUESTS) ||
      (job.scene!.budget.terminalPixels ?? 0) + p.budget.inputPixels >
        (job.scene!.settings?.maxTerminalPixels ??
          this.store.config.SCENE_MAX_TERMINAL_PIXELS)
    )
      throw new AppError(
        409,
        'TERMINAL_BUDGET',
        'The bounded connector-junction request/pixel allowance is exhausted.',
      );
  }
  async runWorker(
    job: Job,
    owner: string,
    attemptId: string,
    config: Config,
    client: MetaClient,
    signal: AbortSignal,
    trace: AnalysisTrace,
  ) {
    const planId = lastAttempt(job, 'scene')!.junctionPlanId!,
      initial = this.get(planId, job.analysisId),
      p = initial.plan;
    const owned = () => {
      const current = this.store.get(job.analysisId),
        a = lastAttempt(current, 'scene');
      if (
        signal.aborted ||
        current.owner !== owner ||
        a?.attemptId !== attemptId ||
        a.status !== 'running' ||
        (current.leaseUntil ?? 0) <= Date.now()
      )
        throw new AppError(
          503,
          'WORKER_INTERRUPTED',
          'Junction worker ownership was lost.',
        );
      return current;
    };
    const commit = (fn: (r: JunctionPrivateRecord, j: Job) => void) => {
      if (
        !this.store.owned(job.analysisId, owner, 'scene', attemptId, (j) => {
          changeJunction(this.store, planId, (r) => fn(r, j));
        })
      )
        throw new AppError(
          503,
          'WORKER_INTERRUPTED',
          'Junction worker ownership was lost.',
        );
    };
    const finish = (
      phase: 'finished' | 'failed' | 'interrupted',
      errorCode: string | null,
    ) =>
      commit((r, j) => {
        r.phase = phase;
        r.errorCode = errorCode;
        r.finishedAt = Date.now();
        r.latency.providerMs =
          r.dispatchedAt && r.responseAt ? r.responseAt - r.dispatchedAt : null;
        r.latency.totalMs = r.admittedAt ? r.finishedAt - r.admittedAt : null;
        const a = lastAttempt(j, 'scene')!;
        a.status =
          phase === 'finished'
            ? 'succeeded'
            : phase === 'interrupted'
              ? 'interrupted'
              : 'failed';
        a.upstreamOutcome = r.responseAt
          ? 'response_received'
          : r.dispatchedAt
            ? 'unknown'
            : 'not_sent';
        a.retryPolicy = 'not_retryable';
        a.finishedAt = r.finishedAt;
        a.diagnostics = trace.snapshot();
        j.scene!.status = phase === 'finished' ? 'succeeded' : 'failed';
        j.status = j.muse.result
          ? 'completed'
          : j.sam.result
            ? 'partial'
            : 'failed';
        delete j.owner;
        delete j.leaseUntil;
      });
    try {
      owned();
      this.validateCurrent(initial);
      if (
        initial.phase !== 'queued' ||
        initial.attemptId !== attemptId ||
        config.META_BASE_URL !== p.providerBaseUrl
      )
        throw new AppError(
          409,
          'STALE_JUNCTION_PLAN',
          'Junction admission or provider configuration changed.',
        );
      commit((r, j) => {
        this.checkBudget(j, p);
        r.phase = 'admitted';
        r.startedAt = Date.now();
        r.latency.queueMs = r.admittedAt ? r.startedAt - r.admittedAt : null;
        if (p.useMuse) {
          j.scene!.budget.terminalRequests =
            (j.scene!.budget.terminalRequests ?? 0) + 1;
          j.scene!.budget.terminalPixels =
            (j.scene!.budget.terminalPixels ?? 0) + p.budget.inputPixels;
        }
      });
      if (!p.useMuse) {
        commit((r) => {
          r.outcomes = unresolvedJunctions(
            p,
            'Offline attempt finished: geometry provides search regions, not visible attachment evidence. No Muse interpretation was requested.',
          );
        });
        finish('finished', null);
        return;
      }
      const recorder = new SceneRequestRecorder(
        this.store,
        {
          requestId: initial.requestId!,
          analysisId: job.analysisId,
          objectId: p.connectorObjectId,
          variant: 'connector-junctions-v1',
          inputSnapshotId: p.inputSnapshotId,
          inputSnapshotHash: p.inputSnapshotHash,
          imageHash: p.imageHash,
          crop: p.crop,
          prompt: 'connector-junctions-v1',
          cropImage: {
            mimeType: 'image/jpeg',
            base64: initial.evidence.images[0]!.base64,
            sha256: p.inputImages[0]!.sha256,
            bytes: p.inputImages[0]!.bytes,
          },
          createdAt: Date.now(),
        },
        (phase) => {
          owned();
          this.validateCurrent(this.get(planId));
          if (
            phase === 'dispatching' &&
            recorder.record.request?.sha256 !== p.requestPayloadHash
          )
            throw new Error(
              'Junction request payload differs from the frozen request.',
            );
          changeJunction(this.store, planId, (r) => {
            if (phase === 'dispatching') {
              if (r.phase !== 'admitted' || r.dispatchedAt)
                throw new AppError(
                  409,
                  'JUNCTION_ALREADY_ATTEMPTED',
                  'No junction request can be dispatched twice.',
                );
              r.dispatchedAt = Date.now();
              r.phase = 'dispatching';
            } else {
              if (!r.dispatchedAt || r.responseAt)
                throw new Error('Invalid junction response transition');
              r.responseAt = Date.now();
              r.phase = 'response_recorded';
            }
          });
        },
        'chat/completions',
      );
      const raw = await client.post(
        'chat/completions',
        initial.evidence.requestBody,
        signal,
        {
          stage: 'muse.terminals',
          maxRetries: 0,
          timeoutMs: p.budget.timeoutMs,
          trace,
          imageDimensions: p.inputImages.map((i) => ({
            width: i.width,
            height: i.height,
          })),
          evidence: recorder.transport,
        },
      );
      owned();
      if (!this.get(planId).responseAt)
        throw new Error('Provider response evidence was not durably captured.');
      if (
        canonicalHash(
          JSON.parse(
            Buffer.from(recorder.record.response!.base64, 'base64').toString(
              'utf8',
            ),
          ),
        ) !== canonicalHash(raw)
      )
        throw new Error(
          'Junction response differs from durable provider evidence.',
        );
      const outcomes = decodeJunctionResponse(raw, p, initial.evidence.body);
      commit((r) => {
        r.outcomes = outcomes;
        r.evidence.providerOutput = raw;
        r.evidence.decodedAt = Date.now();
      });
      finish('finished', null);
    } catch (error) {
      const current = this.get(planId),
        code = error instanceof AppError ? error.code : 'JUNCTION_STAGE_FAILED';
      try {
        commit((r) => {
          r.outcomes = unresolvedJunctions(
            p,
            `Junction attempt stopped (${code}); visible physical attachment remains unresolved. No provider replay is permitted.`,
          );
        });
        finish(
          current.dispatchedAt && !current.responseAt
            ? 'interrupted'
            : 'failed',
          code,
        );
      } catch {
        throw error;
      }
    }
  }
  review(analysisId: string, body: unknown) {
    const parsed = z
      .object({
        planId: hash,
        revision: z.number().int().nonnegative(),
        outcomeId: z.uuid(),
        decision: z.enum(['confirm', 'correct', 'unknown']),
        position: z
          .tuple([
            z.number().int().nonnegative(),
            z.number().int().nonnegative(),
          ])
          .nullable(),
        kind: z.enum(['housing_entry', 'exposed_contact', 'unknown']),
        reason: z.string().trim().min(8).max(800),
        reviewer: z.string().trim().min(1).max(100),
        originalImageOnly: z.literal(true),
        visibleEvidence: z.boolean(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new AppError(
        400,
        'INVALID_JUNCTION_REVIEW',
        'Provide a visible-evidence review or mark this junction unknown.',
      );
    return this.store.transaction(() => {
      const { planId, revision, ...input } = parsed.data,
        r = this.get(planId, analysisId);
      if (
        r.revision !== revision ||
        !['finished', 'failed', 'interrupted'].includes(r.phase)
      )
        throw new AppError(
          409,
          'STALE_JUNCTION_REVIEW',
          'Reload the finished junction attempt before reviewing.',
        );
      this.validateCurrent(r);
      if (
        !r.outcomes.some((o) => o.id === input.outcomeId) ||
        (input.position &&
          (input.position[0] < r.plan.crop[0] ||
            input.position[1] < r.plan.crop[1] ||
            input.position[0] >= r.plan.crop[0] + r.plan.crop[2] ||
            input.position[1] >= r.plan.crop[1] + r.plan.crop[3]))
      )
        throw new AppError(
          400,
          'INVALID_JUNCTION_REVIEW',
          'Review a bound junction within its source crop.',
        );
      const review = junctionReviewSchema.safeParse({
        ...input,
        reviewId: randomUUID(),
        source: 'human_review',
        reviewedAt: Date.now(),
      });
      if (!review.success)
        throw new AppError(
          400,
          'INVALID_JUNCTION_REVIEW',
          'Hidden contacts cannot be confirmed from a housing entry or an unknown position.',
        );
      const original = r.outcomes.find((o) => o.id === input.outcomeId)!;
      if (
        input.decision === 'confirm' &&
        (original.visibility !== 'visible' ||
          input.kind !== original.kind ||
          canonicalHash(input.position) !== canonicalHash(original.position))
      )
        throw new AppError(
          400,
          'INVALID_JUNCTION_REVIEW',
          'Use a visible-evidence correction for a changed or previously unresolved position.',
        );
      if (this.rows('connector_junction_reviews', planId).length >= 100)
        throw new AppError(
          409,
          'REVIEW_LIMIT',
          'The junction review limit was reached.',
        );
      this.store.db
        .prepare('INSERT INTO connector_junction_reviews VALUES (?,?,?,?)')
        .run(
          review.data.reviewId,
          analysisId,
          planId,
          JSON.stringify(review.data),
        );
      changeJunction(this.store, planId, () => {});
      return this.publicRecord(planId, analysisId);
    });
  }
  freezeReference(analysisId: string, body: unknown) {
    const parsed = z
      .object({ planId: hash, content: junctionReferenceContentSchema })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new AppError(
        400,
        'INVALID_JUNCTION_REFERENCE',
        'Provide a complete two-conductor original-image reference with reviewer provenance.',
      );
    return this.store.transaction(() => {
      const { planId, content } = parsed.data,
        r = this.get(planId, analysisId),
        existing = this.rows<JunctionReference>(
          'connector_junction_references',
          planId,
        );
      if (
        content.imageHash !== r.plan.imageHash ||
        content.connectorObjectId !== r.plan.connectorObjectId ||
        content.junctions.some(
          (j) =>
            !r.plan.conductorObjectIds.includes(j.conductorObjectId) ||
            (j.position &&
              (j.position[0] >= r.plan.image.width ||
                j.position[1] >= r.plan.image.height)),
        )
      )
        throw new AppError(
          409,
          'JUNCTION_REFERENCE_MISMATCH',
          'Reference coordinates and identities must match the frozen photograph and conductors.',
        );
      const same = existing.find(
        (v) => canonicalHash(v.content) === canonicalHash(content),
      );
      if (same) return same;
      if (existing.length >= 20)
        throw new AppError(
          409,
          'REFERENCE_LIMIT',
          'The junction reference limit was reached.',
        );
      const exposed =
        this.store.db
          .prepare(
            "SELECT id FROM connector_junction_reviews WHERE analysis_id=? AND json_extract(data,'$.reviewer')=?",
          )
          .get(analysisId, content.reviewer) ||
        this.store.db
          .prepare(
            "SELECT id FROM connector_junction_references WHERE analysis_id=? AND json_extract(data,'$.content.reviewer')=? AND json_extract(data,'$.content.predictionExposure')='seen_before'",
          )
          .get(analysisId, content.reviewer);
      const payload = {
        planId,
        version: existing.length + 1,
        frozenAt: Date.now(),
        independent:
          !exposed &&
          content.reviewer !== 'Unassigned' &&
          content.source === 'human_review' &&
          content.annotationMethod === 'manual_point' &&
          content.predictionExposure === 'never_seen' &&
          content.originalImageOnly &&
          content.independentAttestation,
        content,
      };
      const reference = { referenceHash: canonicalHash(payload), ...payload };
      this.store.db
        .prepare('INSERT INTO connector_junction_references VALUES (?,?,?,?)')
        .run(
          reference.referenceHash,
          analysisId,
          planId,
          JSON.stringify(reference),
        );
      return reference;
    });
  }
  evaluate(analysisId: string, body: unknown) {
    const parsed = z
      .object({
        planId: hash,
        referenceHash: hash,
        layer: z.enum(['original', 'reviewed']).default('original'),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new AppError(
        400,
        'INVALID_JUNCTION_EVALUATION',
        'Choose the frozen junction attempt and independent reference.',
      );
    return this.store.transaction(() => {
      const { planId, referenceHash } = parsed.data,
        r = this.publicRecord(planId, analysisId),
        reference = r.references.find((v) => v.referenceHash === referenceHash);
      if (
        !reference ||
        !['finished', 'failed', 'interrupted'].includes(r.phase)
      )
        throw new AppError(
          409,
          'JUNCTION_NOT_FINISHED',
          'Freeze a reference and finish the attempt before scoring.',
        );
      const { referenceHash: stored, ...payload } = reference;
      if (canonicalHash(payload) !== stored)
        throw new AppError(
          409,
          'JUNCTION_REFERENCE_MISMATCH',
          'Reference hash validation failed.',
        );
      const outcomes =
        parsed.data.layer === 'original' ? r.outcomes : r.effectiveOutcomes;
      const predictionHash = canonicalHash(outcomes),
        same = r.evaluations.find(
          (e) =>
            e.referenceHash === referenceHash &&
            e.predictionHash === predictionHash &&
            e.predictionLayer === parsed.data.layer,
        );
      if (same) return same;
      if (r.evaluations.length >= 100)
        throw new AppError(
          409,
          'EVALUATION_LIMIT',
          'The junction evaluation limit was reached.',
        );
      const result = evaluateJunctions(
        r.plan,
        outcomes,
        reference,
        this.audit(planId, analysisId).valid,
        parsed.data.layer,
      );
      this.store.db
        .prepare('INSERT INTO connector_junction_evaluations VALUES (?,?,?,?)')
        .run(result.evaluationId, analysisId, planId, JSON.stringify(result));
      return result;
    });
  }
  audit(planId: string, analysisId: string) {
    const r = this.get(planId, analysisId),
      failures: string[] = [];
    try {
      this.validateCurrent(r);
    } catch {
      failures.push('source_or_input_binding');
    }
    const request = r.requestId
      ? sceneRequestEvidence(this.store, analysisId).find(
          (v) => v.requestId === r.requestId,
        )
      : undefined;
    if (
      r.dispatchedAt &&
      (!request?.request ||
        request.request.sha256 !== r.plan.requestPayloadHash ||
        sha256(request.request.payload) !== r.plan.requestPayloadHash)
    )
      failures.push('request_provenance_missing');
    if (
      r.responseAt &&
      (!request?.response ||
        request.response.truncated ||
        sha256(Buffer.from(request.response.base64, 'base64')) !==
          request.response.sha256)
    )
      failures.push('response_provenance_missing');
    if (r.evidence.decodedAt) {
      try {
        if (!request?.response) throw Error('Missing response');
        const raw = JSON.parse(
          Buffer.from(request.response.base64, 'base64').toString('utf8'),
        );
        if (
          canonicalHash(
            decodeJunctionResponse(raw, r.plan, r.evidence.body),
          ) !== canonicalHash(r.outcomes) ||
          canonicalHash(raw) !== canonicalHash(r.evidence.providerOutput)
        )
          throw Error('Outcome binding mismatch');
      } catch {
        failures.push('decoded_outcome_binding');
      }
    }
    return {
      valid: !failures.length,
      failures,
      planHash: r.plan.planId,
      nativeHash: r.plan.segmentation.nativeHash,
    };
  }
  publicRecord(planId: string, analysisId?: string): JunctionRecord {
    const r = this.get(planId, analysisId),
      reviews = this.rows<JunctionReview>('connector_junction_reviews', planId),
      references = this.rows<JunctionReference>(
        'connector_junction_references',
        planId,
      ),
      evaluations = this.rows<JunctionEvaluation>(
        'connector_junction_evaluations',
        planId,
      ),
      { evidence: _e, dispatchedAt, responseAt, ...value } = r;
    void _e;
    const reserved = r.startedAt && r.plan.useMuse ? 1 : 0;
    return junctionRecordSchema.parse({
      ...value,
      reviews,
      references,
      evaluations,
      effectiveOutcomes: effectiveJunctions(r.outcomes, reviews),
      accounting: {
        reservedRequests: reserved,
        dispatchAttempts: dispatchedAt ? 1 : 0,
        responsesRecorded: responseAt ? 1 : 0,
        unknownUsageRequests: dispatchedAt && !responseAt ? 1 : 0,
        reservedPixels: reserved ? r.plan.budget.inputPixels : 0,
        dispatchedPixels: dispatchedAt ? r.plan.budget.inputPixels : 0,
        billedCost: null,
      },
      evidenceUrl: `/api/analyses/${r.plan.analysisId}/connector-junction-evidence?planId=${planId}`,
    });
  }
  forAnalysis(analysisId: string) {
    return this.store.db
      .prepare(
        'SELECT id FROM connector_junctions WHERE analysis_id=? ORDER BY rowid',
      )
      .all(analysisId)
      .map((row) => this.publicRecord(row.id as string, analysisId));
  }
  evidence(planId: string, analysisId: string) {
    const r = this.get(planId, analysisId);
    const photograph = this.store.image(analysisId);
    return {
      schemaVersion: 'praxis-connector-junction-evidence-v1',
      analysisId,
      record: this.publicRecord(planId, analysisId),
      privateEvidence: r.evidence,
      sourceSnapshot: getSceneSnapshot(this.store, r.plan.inputSnapshotId),
      imageCheckpoint: this.store.getSnapshot(r.plan.samSnapshotId),
      sourcePhotograph: {
        sha256: sha256(photograph),
        base64: photograph.toString('base64'),
        bytes: photograph.length,
      },
      request: r.requestId
        ? (sceneRequestEvidence(this.store, analysisId).find(
            (v) => v.requestId === r.requestId,
          ) ?? null)
        : null,
      audit: this.audit(planId, analysisId),
      note: 'Physical junction evidence only. Housing entries never locate hidden contacts. Zero SAM, at most one Muse request; no electrical continuity or polarity claims.',
    };
  }
}
