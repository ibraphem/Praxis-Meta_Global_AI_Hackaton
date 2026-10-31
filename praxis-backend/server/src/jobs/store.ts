import { retryCropWork } from '../services/crop-retry.js';
import { RUNTIME } from '../lib/runtime.js';
import { checkpointScene, getSceneSnapshot } from './scene-snapshots.js';
import type {
  SceneGraph,
  SceneSnapshotRef,
  SceneWork,
  TerminalWork,
} from '../schemas/scene.js';
import {
  normalizeCropAttempts,
  finishRunningCrops,
} from '../services/crop-attempts.js';
import {
  type RecoveryReport,
  type WireIdentity,
  wireIdentitySchema,
  effectiveIdentityReviews,
  type CropAttempt,
  recoveryTargetSchema,
  cropRetryRequestSchema,
  type CropRetry,
  extensionVerificationSchema,
  type ExtensionVerification,
} from '../schemas/wire-recovery.js';
import type { RecoveryBudget } from '../services/wire-recovery.js';
import { ExperimentRegistry } from './experiments.js';
import {
  snapshotHash,
  SNAPSHOT_PROCESSING_VERSION,
  type SnapshotRef,
  type SnapshotRecord,
} from './snapshots.js';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';
import type { Diagnostics } from '../lib/diagnostics.js';
import type { Analysis, PreparedImage } from '../schemas/vision.js';
import type { SamSnapshot } from '../services/vision.js';
import {
  reconcileSceneGraph,
  inventoryObjectIds,
} from '../services/scene-reconciliation.js';
import { terminalCrop } from '../services/scene-terminals.js';
import { z } from 'zod';

export type JobStage = 'sam' | 'muse' | 'recovery' | 'scene';
export type AttemptStatus =
  'queued' | 'running' | 'succeeded' | 'timed_out' | 'interrupted' | 'failed';
export interface Attempt {
  attemptId: string;
  status: AttemptStatus;
  upstreamOutcome: 'not_sent' | 'unknown' | 'response_received';
  retryPolicy:
    'dispatch_existing' | 'blocked' | 'manual_only' | 'not_retryable';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  errorCode?: string;
  diagnostics?: Diagnostics;
  samSnapshotId?: string;
  samSnapshotHash?: string;
  snapshotBinding?: 'recorded' | 'legacy_inferred';
  /** Historical prediction, private evidence export only. */
  result?: Analysis;
  recoveryReport?: RecoveryReport;
  outputSnapshotId?: string;
  outputSnapshotHash?: string;
  sceneOperation?: 'inventory' | 'guided' | 'terminals' | 'reconcile';
  terminalObjectIds?: string[];
  sceneSnapshotId?: string;
  sceneSnapshotHash?: string;
}
export interface Job {
  analysisId: string;
  imageHash: string;
  image: { width: number; height: number };
  status:
    | 'queued'
    | 'segmenting'
    | 'interpreting'
    | 'partial'
    | 'completed'
    | 'failed';
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  revision: string;
  /** Published selection, independent of whether Muse has interpreted this checkpoint. */
  candidateResult?: Analysis;
  candidatePublicationError?: 'WIRE_SELECTION_BUDGET';
  settings: {
    maxDimension: number;
    minimalPrompt: boolean;
    mode: Config['VISION_MODE'];
    samModel: string;
    museModel: string;
    dynamicScene?: boolean;
    sceneTimeoutMs?: number;
    sceneMaxRequests?: number;
    sceneMaxPixels?: number;
    sceneMaxCropPixels?: number;
  };
  sam: {
    status: AttemptStatus | 'not_started';
    attempts: Attempt[];
    snapshot?: SamSnapshot;
    snapshotRef?: SnapshotRef;
    result?: Analysis;
  };
  muse: {
    status: AttemptStatus | 'not_started';
    attempts: Attempt[];
    result?: Analysis;
    resultAttemptId?: string;
  };
  recovery: {
    status: AttemptStatus | 'not_started';
    attempts: Attempt[];
    operation:
      | 'audit'
      | 'recover'
      | 'verify'
      | 'recover_short'
      | 'retry_crop'
      | 'verify_extension';
    target?: {
      pitchPx: number;
      gridPoints: [number, number][];
      manualPoint?: [number, number] | undefined;
    };
    candidateId?: string;
    cropRetry?: CropRetry;
    extensionVerification?: ExtensionVerification;
    snapshotRef?: SnapshotRef;
    report?: RecoveryReport;
    budget: RecoveryBudget;
    visited: [number, number, number, number][];
    cropAttempts: CropAttempt[];
  };
  wireIdentities: WireIdentity[];
  scene?: {
    status: AttemptStatus | 'not_started';
    enabledBy?: 'upload' | 'manual';
    settings?: {
      timeoutMs: number;
      maxRequests: number;
      maxPixels: number;
      maxCropPixels: number;
      maxTerminalRequests?: number;
      maxTerminalPixels?: number;
    };
    attempts: Attempt[];
    snapshotRef?: SceneSnapshotRef;
    graph?: SceneGraph;
    budget: {
      requests: number;
      pixels: number;
      terminalRequests?: number;
      terminalPixels?: number;
    };
    work: SceneWork[];
    terminalWork?: TerminalWork[];
  };
  experiment?: {
    experimentId: string;
    analysisId: string;
    status: 'running' | 'interrupted';
    leaseUntil: number;
  };
  owner?: string;
  leaseUntil?: number;
}
export const newAttempt = (): Attempt => ({
  attemptId: randomUUID(),
  status: 'queued',
  upstreamOutcome: 'not_sent',
  retryPolicy: 'dispatch_existing',
  createdAt: Date.now(),
});
export const lastAttempt = (job: Job, stage: JobStage) =>
  job[stage]?.attempts.at(-1);

/** SQLite transactions serialize claims/retries across workers; image and state commit together. */
export class JobStore {
  readonly db: DatabaseSync;
  readonly experiments: ExperimentRegistry;
  constructor(
    readonly config: Config,
    directory = config.ANALYSIS_JOB_DIR,
  ) {
    if (directory !== ':memory:')
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(
      directory === ':memory:' ? directory : join(directory, 'analyses.sqlite'),
    );
    if (directory !== ':memory:')
      chmodSync(join(directory, 'analyses.sqlite'), 0o600);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL, image BLOB NOT NULL)',
    );
    // Indexed scheduler metadata avoids reparsing every persisted photograph on each tick.
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(jobs)').all();
      if (!columns.some((c) => c.name === 'owner')) {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN owner TEXT;
        ALTER TABLE jobs ADD COLUMN lease_until INTEGER;
        ALTER TABLE jobs ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE jobs ADD COLUMN queued_stage TEXT;
        UPDATE jobs SET owner=json_extract(data,'$.owner'), lease_until=json_extract(data,'$.leaseUntil'), expires_at=json_extract(data,'$.expiresAt'),
          queued_stage=CASE WHEN json_extract(data,'$.sam.status')='queued' THEN 'sam' WHEN json_extract(data,'$.muse.status')='queued' THEN 'muse' ELSE NULL END;`);
      }
    });
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(owner,queued_stage); CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(owner,expires_at); CREATE INDEX IF NOT EXISTS jobs_lease ON jobs(owner,lease_until)',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS sam_snapshots (id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, hash TEXT NOT NULL, metadata TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS snapshots_analysis ON sam_snapshots(analysis_id)',
    );
    this.db.exec(
      "CREATE TRIGGER IF NOT EXISTS immutable_sam_snapshots BEFORE UPDATE ON sam_snapshots BEGIN SELECT RAISE(ABORT,'SAM checkpoints are immutable'); END",
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS model_requests (id TEXT PRIMARY KEY, lease_until INTEGER NOT NULL)',
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS scene_snapshots (id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, metadata TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS scene_snapshots_analysis ON scene_snapshots(analysis_id); CREATE TRIGGER IF NOT EXISTS immutable_scene_snapshots BEFORE UPDATE ON scene_snapshots BEGIN SELECT RAISE(ABORT,'Scene snapshots are immutable'); END",
    );
    this.experiments = new ExperimentRegistry(this);
    this.transaction(() => {
      for (const row of this.db
        .prepare(
          "SELECT id FROM jobs WHERE json_extract(data,'$.sam.status')='succeeded' AND json_type(data,'$.sam.snapshotRef') IS NULL",
        )
        .all())
        this.save(this.get(row.id as string), true);
    });
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  get(id: string): Job {
    const row = this.db
      .prepare('SELECT data,owner,lease_until FROM jobs WHERE id=?')
      .get(id);
    if (!row)
      throw new AppError(
        404,
        'ANALYSIS_NOT_FOUND',
        'The saved analysis was not found or has expired.',
      );
    const job = JSON.parse(row.data as string) as Job;
    job.recovery ??= emptyRecovery();
    job.recovery.cropAttempts = normalizeCropAttempts(
      job.recovery.visited,
      job.recovery.cropAttempts,
    );
    job.wireIdentities ??= [];
    if (row.owner) {
      job.owner = row.owner as string;
      job.leaseUntil = row.lease_until as number;
    } else {
      delete job.owner;
      delete job.leaseUntil;
    }
    if (job.sam.snapshotRef)
      job.sam.snapshot = this.getSnapshot(
        job.sam.snapshotRef.samSnapshotId,
      ).snapshot;
    if (job.scene?.snapshotRef)
      job.scene.graph = getSceneSnapshot(
        this,
        job.scene.snapshotRef.snapshotId,
      ).graph;
    const reservation = this.experiments.active();
    if (reservation)
      job.experiment = {
        experimentId: reservation.experimentId,
        analysisId: reservation.analysisId,
        status: reservation.status as 'running' | 'interrupted',
        leaseUntil: reservation.leaseUntil,
      };
    else delete job.experiment;
    return job;
  }
  getSnapshot(id: string): SnapshotRecord {
    const row = this.db
      .prepare('SELECT metadata,data FROM sam_snapshots WHERE id=?')
      .get(id);
    if (!row)
      throw new AppError(
        409,
        'SNAPSHOT_NOT_FOUND',
        'The referenced SAM checkpoint was not found.',
      );
    const record = {
      ref: JSON.parse(row.metadata as string) as SnapshotRef,
      snapshot: JSON.parse(row.data as string) as SamSnapshot,
    };
    if (
      snapshotHash(record.snapshot, record.ref) !== record.ref.samSnapshotHash
    )
      throw new AppError(
        409,
        'SNAPSHOT_HASH_MISMATCH',
        'The SAM checkpoint failed its integrity check.',
      );
    return record;
  }
  snapshots(id: string): SnapshotRecord[] {
    return this.db
      .prepare(
        'SELECT id FROM sam_snapshots WHERE analysis_id=? ORDER BY rowid',
      )
      .all(id)
      .map((row) => this.getSnapshot(row.id as string));
  }
  checkpointSnapshot(
    job: Job,
    snapshot: SamSnapshot,
    sourceAttemptId: string,
    origin: SnapshotRef['origin'] = 'recorded',
    derived?: SnapshotRef,
  ) {
    const context = {
      imageHash: job.imageHash,
      model: job.settings.samModel,
      processingVersion: derived
        ? 'wire-recovery-v1'
        : SNAPSHOT_PROCESSING_VERSION,
    };
    const ref: SnapshotRef = {
      ...context,
      samSnapshotId: randomUUID(),
      samSnapshotHash: snapshotHash(snapshot, context),
      sourceAttemptId,
      createdAt: Date.now(),
      origin,
      ...(derived ? { parentSnapshotId: derived.samSnapshotId } : {}),
    };
    this.db
      .prepare('INSERT INTO sam_snapshots VALUES (?,?,?,?,?)')
      .run(
        ref.samSnapshotId,
        job.analysisId,
        ref.samSnapshotHash,
        JSON.stringify(ref),
        JSON.stringify(snapshot),
      );
    if (derived) return ref;
    job.sam.snapshot = snapshot;
    job.sam.snapshotRef = ref;
    const attempt = job.sam.attempts.find(
      (a) => a.attemptId === sourceAttemptId,
    );
    if (attempt) {
      attempt.samSnapshotId = ref.samSnapshotId;
      attempt.samSnapshotHash = ref.samSnapshotHash;
      attempt.snapshotBinding =
        origin === 'recorded' ? 'recorded' : 'legacy_inferred';
    }
    return ref;
  }
  save(job: Job, preserveTimestamp = false) {
    if (
      job.sam.status === 'succeeded' &&
      job.sam.snapshot &&
      !job.sam.snapshotRef
    )
      this.checkpointSnapshot(
        job,
        job.sam.snapshot,
        lastAttempt(job, 'sam')!.attemptId,
        'legacy_import',
      );
    const ref = job.sam.snapshotRef;
    if (ref) {
      const stored = this.getSnapshot(ref.samSnapshotId);
      if (
        stored.ref.samSnapshotHash !== ref.samSnapshotHash ||
        (job.sam.snapshot &&
          snapshotHash(job.sam.snapshot, ref) !== ref.samSnapshotHash)
      )
        throw new AppError(
          409,
          'IMMUTABLE_SNAPSHOT',
          'An existing SAM checkpoint cannot be overwritten.',
        );
      for (const attempt of job.muse.attempts)
        if (!attempt.samSnapshotId) {
          attempt.samSnapshotId = ref.samSnapshotId;
          attempt.samSnapshotHash = ref.samSnapshotHash;
          attempt.snapshotBinding =
            attempt.status === 'queued' ? 'recorded' : 'legacy_inferred';
        }
      if (job.muse.result && !job.muse.resultAttemptId) {
        const source =
          job.muse.attempts.find((a) => a.attemptId === job.revision) ??
          job.muse.attempts.findLast((a) => a.status === 'succeeded');
        if (source) {
          source.result = job.muse.result;
          job.muse.resultAttemptId = source.attemptId;
        }
      }
    }
    if (!preserveTimestamp) job.updatedAt = Date.now();
    const { experiment: _reservation, ...durable } = job;
    if (durable.scene) {
      const { graph: _graph, ...scene } = durable.scene;
      void _graph;
      durable.scene = scene;
    }
    void _reservation;
    this.db
      .prepare(
        'UPDATE jobs SET data=?,owner=?,lease_until=?,expires_at=?,queued_stage=? WHERE id=?',
      )
      .run(
        JSON.stringify(
          ref
            ? { ...durable, sam: { ...durable.sam, snapshot: undefined } }
            : durable,
        ),
        job.owner ?? null,
        job.leaseUntil ?? null,
        job.expiresAt,
        job.sam.status === 'queued'
          ? 'sam'
          : job.recovery?.status === 'queued'
            ? 'recovery'
            : job.muse.status === 'queued'
              ? 'muse'
              : job.scene?.status === 'queued'
                ? 'scene'
                : null,
        job.analysisId,
      );
  }
  image(id: string): Buffer {
    const row = this.db.prepare('SELECT image FROM jobs WHERE id=?').get(id);
    if (!row)
      throw new AppError(
        404,
        'ANALYSIS_NOT_FOUND',
        'The saved analysis was not found or has expired.',
      );
    return Buffer.from(row.image as Uint8Array);
  }
  cleanup(now = Date.now()) {
    this.db
      .prepare(
        "DELETE FROM jobs WHERE owner IS NULL AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM experiments WHERE analysis_id=jobs.id AND status IN ('running','interrupted'))",
      )
      .run(now);
    this.db.exec(
      'DELETE FROM sam_snapshots WHERE analysis_id NOT IN(SELECT id FROM jobs); DELETE FROM scene_snapshots WHERE analysis_id NOT IN(SELECT id FROM jobs); DELETE FROM experiments WHERE analysis_id NOT IN(SELECT id FROM jobs)',
    );
  }
  create(bytes: Buffer, image: PreparedImage): Job {
    return this.transaction(() => {
      this.cleanup();
      if (
        Number(
          this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()!.count,
        ) >= this.config.MAX_STORED_JOBS
      )
        throw new AppError(
          503,
          'JOB_STORE_FULL',
          'Saved analysis capacity is full. Delete an older analysis and try again.',
        );
      const now = Date.now();
      const job: Job = {
        analysisId: randomUUID(),
        imageHash: createHash('sha256').update(bytes).digest('hex'),
        image: { width: image.width, height: image.height },
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + this.config.JOB_RETENTION_HOURS * 3600_000,
        revision: 'sam',
        settings: {
          maxDimension: this.config.MUSE_MAX_DIMENSION,
          minimalPrompt: this.config.MUSE_MINIMAL_PROMPT,
          mode: this.config.VISION_MODE,
          samModel: this.config.META_SAM_MODEL,
          museModel: this.config.META_REASONING_MODEL,
          dynamicScene: this.config.DYNAMIC_SCENE_ENABLED,
          sceneTimeoutMs: this.config.SCENE_STAGE_TIMEOUT_MS,
          sceneMaxRequests: this.config.SCENE_MAX_GUIDED_REQUESTS,
          sceneMaxPixels: this.config.SCENE_MAX_GUIDED_PIXELS,
          sceneMaxCropPixels: this.config.SCENE_MAX_CROP_PIXELS,
        },
        sam: {
          status: 'queued',
          attempts: [newAttempt()],
          snapshot: { image, candidates: [] },
        },
        muse: { status: 'not_started', attempts: [] },
        recovery: emptyRecovery(),
        wireIdentities: [],
        ...(this.config.DYNAMIC_SCENE_ENABLED
          ? {
              scene: {
                status: 'queued' as const,
                enabledBy: 'upload' as const,
                attempts: [
                  { ...newAttempt(), sceneOperation: 'inventory' as const },
                ],
                budget: { requests: 0, pixels: 0 },
                work: [],
              },
            }
          : {}),
      };
      this.db
        .prepare(
          'INSERT INTO jobs (id,data,image,expires_at,queued_stage) VALUES (?,?,?,?,?)',
        )
        .run(job.analysisId, JSON.stringify(job), bytes, job.expiresAt, 'sam');
      return job;
    });
  }
  /** Explicit opt-in for a saved photograph. Never reruns or replaces baseline predictions. */
  requestScene(id: string): Job {
    return this.transaction(() => {
      const job = this.get(id);
      if (
        this.experiments.active() ||
        job.owner ||
        [
          job.sam.status,
          job.muse.status,
          job.recovery.status,
          job.scene?.status,
        ].some((s) => s === 'queued' || s === 'running')
      )
        throw new AppError(
          409,
          'ATTEMPT_ACTIVE',
          'Wait for active model work or reservations to finish.',
        );
      if (job.scene)
        throw new AppError(
          409,
          'SCENE_ALREADY_STARTED',
          'Scene discovery already has saved evidence. Use an eligible inventory retry instead.',
        );
      const ref = job.recovery.snapshotRef ?? job.sam.snapshotRef;
      if (job.sam.status !== 'succeeded' || !ref)
        throw new AppError(
          409,
          'SAM_REQUIRED',
          'Complete segmentation before starting discovery on this saved photograph.',
        );
      job.scene = {
        status: 'queued',
        enabledBy: 'manual',
        settings: {
          timeoutMs:
            job.settings.sceneTimeoutMs ?? this.config.SCENE_STAGE_TIMEOUT_MS,
          // Explicit saved-photo discovery isolates Muse inventory from new SAM work.
          maxRequests: 0,
          maxPixels:
            job.settings.sceneMaxPixels ?? this.config.SCENE_MAX_GUIDED_PIXELS,
          maxCropPixels:
            job.settings.sceneMaxCropPixels ??
            this.config.SCENE_MAX_CROP_PIXELS,
        },
        attempts: [
          {
            ...newAttempt(),
            sceneOperation: 'inventory',
            samSnapshotId: ref.samSnapshotId,
            samSnapshotHash: ref.samSnapshotHash,
            snapshotBinding: 'recorded',
          },
        ],
        budget: { requests: 0, pixels: 0 },
        work: [],
      };
      this.save(job);
      return job;
    });
  }
  requestSceneUnderstanding(
    id: string,
    operation: 'reconcile' | 'terminals',
    body: unknown,
  ): Job {
    return this.transaction(() => {
      const job = this.get(id);
      const parsed = z
        .object({
          snapshotId: z.uuid(),
          snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
          objectIds: z.array(z.uuid()).min(1).max(2).optional(),
        })
        .strict()
        .safeParse(body);
      if (
        !parsed.success ||
        !job.scene?.snapshotRef ||
        !job.scene.graph ||
        parsed.data.snapshotId !== job.scene.snapshotRef.snapshotId ||
        parsed.data.snapshotHash !== job.scene.snapshotRef.snapshotHash
      )
        throw new AppError(
          409,
          'STALE_SCENE',
          'Reload the current scene inventory before proposing relationships or terminals.',
        );
      if (
        this.experiments.active() ||
        job.owner ||
        [
          job.sam.status,
          job.muse.status,
          job.recovery.status,
          job.scene.status,
        ].some((s) => s === 'queued' || s === 'running')
      )
        throw new AppError(
          409,
          'ATTEMPT_ACTIVE',
          'Wait for active model work or reservations to finish.',
        );
      if (job.scene.attempts.length >= 20)
        throw new AppError(
          409,
          'ATTEMPT_LIMIT',
          'The scene attempt limit was reached.',
        );
      const attempt = {
        ...newAttempt(),
        sceneOperation: operation,
        sceneSnapshotId: job.scene.snapshotRef.snapshotId,
        sceneSnapshotHash: job.scene.snapshotRef.snapshotHash,
      };
      const source = lastAttempt(job, 'scene');
      if (source?.samSnapshotId)
        Object.assign(attempt, {
          samSnapshotId: source.samSnapshotId,
          samSnapshotHash: source.samSnapshotHash,
          snapshotBinding: 'recorded',
        });
      if (operation === 'reconcile') {
        const graph = reconcileSceneGraph(job.scene.graph);
        if (JSON.stringify(graph) === JSON.stringify(job.scene.graph))
          return job;
        const evidence = getSceneSnapshot(
          this,
          job.scene.snapshotRef.snapshotId,
        );
        const ref = checkpointScene(
          this,
          job,
          graph,
          evidence.native,
          attempt.attemptId,
        );
        Object.assign(attempt, {
          status: 'succeeded',
          upstreamOutcome: 'not_sent',
          retryPolicy: 'not_retryable',
          startedAt: Date.now(),
          finishedAt: Date.now(),
          outputSnapshotId: ref.snapshotId,
          outputSnapshotHash: ref.snapshotHash,
        });
        job.scene.attempts.push(attempt);
        job.scene.graph = graph;
        job.scene.status = 'succeeded';
      } else {
        const objectIds = parsed.data.objectIds;
        const inventory = inventoryObjectIds(job.scene.graph);
        if (
          !objectIds ||
          new Set(objectIds).size !== objectIds.length ||
          objectIds.some((id) => !inventory.has(id))
        )
          throw new AppError(
            400,
            'INVALID_TERMINAL_TARGETS',
            'Choose up to two inventory objects for terminal discovery.',
          );
        const capacity = reconcileSceneGraph(job.scene.graph),
          count = objectIds.length;
        if (
          capacity.observations.length + count * 8 > 450 ||
          capacity.associations.length + count * 8 > 800 ||
          (capacity.terminals?.length ?? 0) + count * 8 > 64 ||
          (capacity.attachments?.length ?? 0) + count * 16 > 128 ||
          (capacity.relations?.length ?? 0) + count * 8 > 400
        )
          throw new AppError(
            409,
            'SCENE_EVIDENCE_BUDGET',
            'The scene has no capacity for a complete bounded terminal response.',
          );
        const settings = job.scene.settings ?? {
          timeoutMs:
            job.settings.sceneTimeoutMs ?? this.config.SCENE_STAGE_TIMEOUT_MS,
          maxRequests: 0,
          maxPixels: this.config.SCENE_MAX_GUIDED_PIXELS,
          maxCropPixels: this.config.SCENE_MAX_CROP_PIXELS,
        };
        settings.maxTerminalRequests ??=
          this.config.SCENE_MAX_TERMINAL_REQUESTS;
        settings.maxTerminalPixels ??= this.config.SCENE_MAX_TERMINAL_PIXELS;
        const used = job.scene.budget.terminalRequests ?? 0;
        const pixels = objectIds.reduce((n, id) => {
          const crop = terminalCrop(job.scene!.graph!, id);
          if (crop[2] * crop[3] > settings.maxCropPixels)
            throw new AppError(
              409,
              'TERMINAL_CROP_BUDGET',
              'The selected object crop exceeds the terminal input budget.',
            );
          return n + crop[2] * crop[3];
        }, 0);
        if (
          used + objectIds.length > settings.maxTerminalRequests ||
          (job.scene.budget.terminalPixels ?? 0) + pixels >
            settings.maxTerminalPixels
        )
          throw new AppError(
            409,
            'TERMINAL_BUDGET',
            'The cumulative terminal discovery budget is exhausted.',
          );
        if (
          objectIds.some(
            (id) =>
              job.scene!.terminalWork?.some((w) => w.objectId === id) ||
              job.scene!.graph!.terminals?.some((t) => t.objectId === id),
          )
        )
          throw new AppError(
            409,
            'TERMINAL_ALREADY_ATTEMPTED',
            'Terminal evidence for this object already has an attempt; it is not automatically repeated.',
          );
        job.scene.settings = settings;
        job.scene.terminalWork ??= [];
        job.scene.budget.terminalRequests ??= 0;
        job.scene.budget.terminalPixels ??= 0;
        Object.assign(attempt, { terminalObjectIds: objectIds });
        job.scene.attempts.push(attempt);
        job.scene.status = 'queued';
      }
      this.save(job);
      return job;
    });
  }
  retry(id: string, stage: 'sam' | 'muse' | 'scene'): Job {
    return this.transaction(() => {
      const job = this.get(id);
      if (this.experiments.active())
        throw new AppError(
          409,
          'EXPERIMENT_RESERVED',
          'A controlled experiment has reserved model admission.',
        );
      if (
        job.owner ||
        ['queued', 'running'].includes(job.sam.status) ||
        ['queued', 'running'].includes(job.muse.status) ||
        ['queued', 'running'].includes(job.recovery.status) ||
        ['queued', 'running'].includes(job.scene?.status ?? '')
      )
        throw new AppError(
          409,
          'ATTEMPT_ACTIVE',
          'This analysis already has a queued or running attempt.',
        );
      if (stage === 'muse' && job.sam.status !== 'succeeded')
        throw new AppError(
          409,
          'SAM_REQUIRED',
          'Complete segmentation before retrying interpretation.',
        );
      const previous = lastAttempt(job, stage);
      if (!previous || previous.retryPolicy !== 'manual_only')
        throw new AppError(
          409,
          'RETRY_NOT_ALLOWED',
          'This stage is not eligible for retry.',
        );
      if (
        job[stage]!.attempts.length >= 20 ||
        (stage === 'sam' &&
          (job.muse.attempts.length >= 20 ||
            (job.settings.mode === 'combined' &&
              job.recovery.attempts.length >= 20)))
      )
        throw new AppError(
          409,
          'ATTEMPT_LIMIT',
          'This analysis has reached its manual attempt limit.',
        );
      const retry = newAttempt();
      if (stage === 'scene') {
        retry.sceneOperation = previous.sceneOperation ?? 'inventory';
        if (retry.sceneOperation !== 'inventory')
          throw new AppError(
            409,
            'SCENE_RETRY_BLOCKED',
            'Guided requests are not automatically repeated. Their evidence and charged budget remain saved.',
          );
      }
      if (
        stage === 'muse' &&
        previous.samSnapshotId &&
        this.getSnapshot(previous.samSnapshotId).ref.processingVersion ===
          'wire-recovery-v1'
      )
        Object.assign(retry, {
          samSnapshotId: previous.samSnapshotId,
          samSnapshotHash: previous.samSnapshotHash,
          snapshotBinding: 'recorded',
        });
      job[stage]!.attempts.push(retry);
      job[stage]!.status = 'queued';
      job.status = stage === 'muse' ? 'partial' : 'queued';
      this.save(job);
      return job;
    });
  }
  requestRecovery(
    id: string,
    operation:
      | 'audit'
      | 'recover'
      | 'verify'
      | 'recover_short'
      | 'retry_crop'
      | 'verify_extension',
    candidateId?: string,
    target?: unknown,
  ): Job {
    return this.transaction(() => {
      const job = this.get(id);
      if (
        this.experiments.active() ||
        job.owner ||
        [
          job.sam.status,
          job.muse.status,
          job.recovery.status,
          job.scene?.status,
        ].some((s) => s === 'queued' || s === 'running')
      )
        throw new AppError(
          409,
          'ATTEMPT_ACTIVE',
          'Wait for active model work or reservations to finish.',
        );
      if (job.sam.status !== 'succeeded' || !job.sam.snapshotRef)
        throw new AppError(
          409,
          'SAM_REQUIRED',
          'Complete segmentation before coverage analysis.',
        );
      if (job.recovery.attempts.length >= 20)
        throw new AppError(
          409,
          'ATTEMPT_LIMIT',
          'The recovery attempt limit was reached.',
        );
      if (
        operation === 'verify' &&
        !job.recovery.report?.candidates.some(
          (c) => c.id === candidateId && c.mask,
        )
      )
        throw new AppError(
          400,
          'SEGMENTATION_REQUIRED',
          'Select a candidate with an observed mask.',
        );
      if (
        (operation === 'verify' || operation === 'verify_extension') &&
        job.recovery.budget.verificationRequests >=
          this.config.WIRE_VERIFY_MAX_REQUESTS
      )
        throw new AppError(
          409,
          'VERIFICATION_BUDGET',
          'The cumulative Muse verification budget is exhausted.',
        );
      if (
        (operation === 'recover' ||
          operation === 'recover_short' ||
          operation === 'retry_crop') &&
        (job.recovery.budget.requests >=
          this.config.WIRE_RECOVERY_MAX_REQUESTS ||
          job.recovery.budget.rounds >= this.config.WIRE_RECOVERY_MAX_ROUNDS)
      )
        throw new AppError(
          409,
          'RECOVERY_BUDGET',
          'The cumulative recovery budget is exhausted.',
        );
      let cropRetry: CropRetry | undefined;
      if (operation === 'retry_crop') {
        const parsed = cropRetryRequestSchema.safeParse(target);
        if (!parsed.success)
          throw new AppError(
            400,
            'INVALID_CROP_RETRY',
            'Choose the original attempt, authorization and a retry reason.',
          );
        cropRetry = { ...parsed.data, authorizedAt: Date.now() };
        const work = retryCropWork(job.recovery.cropAttempts, cropRetry);
        if (
          job.recovery.budget.pixels + work.crop[2] * work.crop[3] >
            this.config.WIRE_RECOVERY_MAX_PIXELS ||
          work.crop[2] * work.crop[3] >
            this.config.WIRE_RECOVERY_MAX_CROP_PIXELS
        )
          throw new AppError(
            409,
            'RECOVERY_BUDGET',
            'The retry would exceed the crop pixel budget.',
          );
        const original = job.recovery.cropAttempts.find(
          (a) => a.attemptId === cropRetry!.attemptId,
        )!;
        if (
          original.sourceSnapshotId &&
          this.getSnapshot(original.sourceSnapshotId).ref.imageHash !==
            job.imageHash
        )
          throw new AppError(
            409,
            'STALE_CROP_RETRY',
            'The crop belongs to a different source photograph.',
          );
      }
      let extensionVerification: ExtensionVerification | undefined;
      if (operation === 'verify_extension') {
        const parsed = extensionVerificationSchema.safeParse(target);
        const report = job.recovery.report;
        if (
          !parsed.success ||
          parsed.data.reportId !== report?.reportId ||
          !report.hypotheses.some(
            (h) =>
              h.kind === 'mask_extension_proposal' &&
              h.candidateIds[0] === parsed.data.sourceCandidateId &&
              h.candidateIds[1] === parsed.data.candidateId,
          )
        )
          throw new AppError(
            409,
            'STALE_EXTENSION',
            'Choose an extension proposal from the current report.',
          );
        extensionVerification = parsed.data;
        if (
          report.candidates.find((c) => c.id === parsed.data.candidateId)
            ?.touchesCropBoundary
        )
          throw new AppError(
            409,
            'CROP_FRAGMENT',
            'Recover the remainder before full-wire identity verification.',
          );
      }
      const ref = job.recovery.snapshotRef ?? job.sam.snapshotRef,
        attempt = newAttempt();
      attempt.samSnapshotId = ref.samSnapshotId;
      attempt.samSnapshotHash = ref.samSnapshotHash;
      attempt.snapshotBinding = 'recorded';
      job.recovery.status = 'queued';
      job.recovery.operation = operation;
      delete job.recovery.target;
      delete job.recovery.cropRetry;
      delete job.recovery.extensionVerification;
      if (cropRetry) job.recovery.cropRetry = cropRetry;
      if (extensionVerification)
        job.recovery.extensionVerification = extensionVerification;
      if (operation === 'recover_short') {
        const parsed = recoveryTargetSchema.safeParse({
          pitchPx: Math.max(
            2,
            Math.min(job.image.width, job.image.height) / 80,
          ),
          gridPoints: [],
          ...((target as object) ?? {}),
        });
        if (
          !parsed.success ||
          [
            ...parsed.data.gridPoints,
            ...(parsed.data.manualPoint ? [parsed.data.manualPoint] : []),
          ].some(([x, y]) => x >= job.image.width || y >= job.image.height)
        )
          throw new AppError(
            400,
            'INVALID_RECOVERY_TARGET',
            'Use points inside the original photograph and a valid hole spacing.',
          );
        job.recovery.target = parsed.data;
      }
      if (candidateId) job.recovery.candidateId = candidateId;
      else delete job.recovery.candidateId;
      job.recovery.attempts.push(attempt);
      this.save(job);
      return job;
    });
  }
  interpretRecovery(id: string): Job {
    return this.transaction(() => {
      const job = this.get(id),
        ref = job.recovery.snapshotRef;
      if (
        this.experiments.active() ||
        job.owner ||
        [
          job.sam.status,
          job.muse.status,
          job.recovery.status,
          job.scene?.status,
        ].some((s) => s === 'queued' || s === 'running')
      )
        throw new AppError(
          409,
          'ATTEMPT_ACTIVE',
          'Wait for active work to finish.',
        );
      if (!ref || job.recovery.report?.sourceSnapshotId !== ref.samSnapshotId)
        throw new AppError(
          409,
          'RECOVERY_REQUIRED',
          'Audit the recovered checkpoint before interpreting it.',
        );
      if (job.muse.attempts.length >= 20)
        throw new AppError(
          409,
          'ATTEMPT_LIMIT',
          'The interpretation attempt limit was reached.',
        );
      const attempt = newAttempt();
      Object.assign(attempt, {
        samSnapshotId: ref.samSnapshotId,
        samSnapshotHash: ref.samSnapshotHash,
        snapshotBinding: 'recorded',
      });
      job.muse.attempts.push(attempt);
      job.muse.status = 'queued';
      this.save(job);
      return job;
    });
  }
  reviewWireIdentity(id: string, review: unknown): Job {
    return this.transaction(() => {
      const job = this.get(id),
        parsed = wireIdentitySchema
          .omit({
            reviewId: true,
            reviewSource: true,
            reviewedAt: true,
            electricalConnectionStatus: true,
          })
          .safeParse(review);
      if (!parsed.success)
        throw new AppError(
          400,
          'INVALID_WIRE_REVIEW',
          'Choose candidates and a review decision.',
        );
      const input = parsed.data,
        report = job.recovery.report;
      if (
        job.owner ||
        job.recovery.status === 'queued' ||
        !report ||
        report.reportId !== input.reportId
      )
        throw new AppError(
          409,
          'STALE_WIRE_REVIEW',
          'The candidate evidence changed; review the current report.',
        );
      if (
        new Set(input.candidateIds).size !== input.candidateIds.length ||
        input.candidateIds.some(
          (id) => !report.candidates.some((c) => c.id === id),
        )
      )
        throw new AppError(
          400,
          'INVALID_CANDIDATES',
          'Select candidates from the current report.',
        );
      if (job.wireIdentities.length >= 100)
        throw new AppError(
          409,
          'REVIEW_LIMIT',
          'The identity review limit was reached.',
        );
      const current = effectiveIdentityReviews(job.wireIdentities, report);
      if (
        input.state === 'verified' &&
        current.some(
          (r) =>
            r.state === 'verified' &&
            r.candidateIds.some((id) => input.candidateIds.includes(id)) &&
            (r.candidateIds.length !== input.candidateIds.length ||
              r.candidateIds.some((id) => !input.candidateIds.includes(id))),
        )
      )
        throw new AppError(
          409,
          'IDENTITY_CONFLICT',
          'A candidate already belongs to another verified wire. Mark that group uncertain first.',
        );
      job.wireIdentities.push({
        ...input,
        reviewId: randomUUID(),
        reviewSource: 'human',
        reviewedAt: Date.now(),
        electricalConnectionStatus: 'unestablished',
      });
      this.save(job);
      return job;
    });
  }
  recover(now = Date.now()) {
    this.transaction(() => this.recoverWithinTransaction(now));
  }
  private recoverWithinTransaction(now = Date.now()) {
    this.experiments.recover(now);
    for (const row of this.db
      .prepare('SELECT id FROM jobs WHERE owner IS NOT NULL AND lease_until<=?')
      .all(now)) {
      const job = this.get(row.id as string);
      for (const stage of ['sam', 'muse', 'recovery', 'scene'] as const) {
        const a = lastAttempt(job, stage);
        if (a?.status === 'running') {
          a.status = 'interrupted';
          a.upstreamOutcome = 'unknown';
          a.retryPolicy = 'manual_only';
          a.errorCode = 'WORKER_INTERRUPTED';
          a.finishedAt = now;
          job[stage]!.status = 'interrupted';
          if (stage === 'scene')
            for (const work of job.scene!.terminalWork ?? [])
              if (work.status === 'running') {
                work.status = 'interrupted';
                work.upstreamOutcome = 'unknown';
                work.errorCode = 'WORKER_INTERRUPTED';
                work.finishedAt = now;
              }
          if (stage === 'scene')
            for (const work of job.scene!.work)
              if (work.status === 'running') {
                work.status = 'interrupted';
                work.upstreamOutcome = 'unknown';
                work.errorCode = 'WORKER_INTERRUPTED';
                work.finishedAt = now;
                const evidence =
                  job.scene!.snapshotRef &&
                  getSceneSnapshot(this, job.scene!.snapshotRef.snapshotId);
                if (evidence) {
                  const object = evidence.graph.objects.find(
                    (o) => o.id === work.objectId,
                  );
                  if (object) object.segmentationStatus = 'unresolved';
                  checkpointScene(
                    this,
                    job,
                    evidence.graph,
                    evidence.native,
                    a.attemptId,
                  );
                }
              }
          if (stage === 'scene' && a.sceneOperation !== 'inventory')
            a.retryPolicy = 'not_retryable';
          if (stage === 'recovery')
            finishRunningCrops(
              job.recovery.cropAttempts,
              'interrupted',
              'WORKER_INTERRUPTED',
              now,
            );
        }
      }
      delete job.owner;
      delete job.leaseUntil;
      job.status = job.muse.result
        ? 'completed'
        : job.sam.result
          ? 'partial'
          : 'failed';
      this.save(job);
    }
  }
  claim(
    owner: string,
  ): { job: Job; stage: JobStage; attemptId: string } | undefined {
    return this.transaction(() => {
      this.recoverWithinTransaction();
      this.cleanup();
      if (this.experiments.active()) return;
      if (
        Number(
          this.db
            .prepare(
              'SELECT COUNT(*) AS count FROM jobs WHERE owner IS NOT NULL',
            )
            .get()!.count,
        ) >= this.config.JOB_WORKER_CONCURRENCY
      )
        return;
      const row = this.db
        .prepare(
          'SELECT id,queued_stage FROM jobs WHERE owner IS NULL AND queued_stage IS NOT NULL ORDER BY rowid LIMIT 1',
        )
        .get();
      if (row) {
        const job = this.get(row.id as string);
        const stage = row.queued_stage as JobStage;
        const a = lastAttempt(job, stage)!;
        if (a.status !== 'queued') return;
        a.status = 'running';
        a.startedAt = Date.now();
        a.upstreamOutcome = 'unknown';
        a.retryPolicy = 'blocked';
        job[stage]!.status = 'running';
        if (stage === 'scene' && !a.samSnapshotId && job.sam.snapshotRef) {
          a.samSnapshotId = job.sam.snapshotRef.samSnapshotId;
          a.samSnapshotHash = job.sam.snapshotRef.samSnapshotHash;
          a.snapshotBinding = 'recorded';
        }
        job.status =
          stage === 'sam'
            ? 'segmenting'
            : stage === 'muse'
              ? 'interpreting'
              : job.muse.result
                ? 'completed'
                : 'partial';
        job.owner = owner;
        job.leaseUntil = Date.now() + 15_000;
        this.save(job);
        return { job, stage, attemptId: a.attemptId };
      }
    });
  }
  renewLease(
    id: string,
    owner: string,
    stage: JobStage,
    attemptId: string,
  ): boolean {
    const now = Date.now();
    return (
      this.db
        .prepare(
          `UPDATE jobs SET lease_until=? WHERE id=? AND owner=? AND lease_until>? AND json_extract(data,'$.${stage}.attempts[#-1].attemptId')=?`,
        )
        .run(now + 15_000, id, owner, now, attemptId).changes === 1
    );
  }
  /** Fence late/stale completions by owner AND attempt identity. */
  owned(
    id: string,
    owner: string,
    stage: JobStage,
    attemptId: string,
    work: (job: Job, attempt: Attempt) => void,
  ): boolean {
    return this.transaction(() => {
      const job = this.get(id),
        a = lastAttempt(job, stage);
      if (
        job.owner !== owner ||
        !a ||
        a.attemptId !== attemptId ||
        a.status !== 'running' ||
        (job.leaseUntil ?? 0) <= Date.now()
      )
        return false;
      work(job, a);
      this.save(job);
      return true;
    });
  }
  remove(id: string) {
    this.transaction(() => {
      if (this.get(id).owner || this.experiments.active()?.analysisId === id)
        throw new AppError(
          409,
          'ATTEMPT_ACTIVE',
          'Wait for the active attempt to finish before deleting this analysis.',
        );
      this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
      this.db.prepare('DELETE FROM sam_snapshots WHERE analysis_id=?').run(id);
      this.db
        .prepare('DELETE FROM scene_snapshots WHERE analysis_id=?')
        .run(id);
      this.db.prepare('DELETE FROM experiments WHERE analysis_id=?').run(id);
    });
  }
  close() {
    this.db.close();
  }
}
export function publicJob(job: Job) {
  return {
    runtime: RUNTIME,
    analysisId: job.analysisId,
    imageHash: job.imageHash,
    image: job.image,
    status: job.status,
    revision: job.revision,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    settings: job.settings,
    ...(job.scene
      ? {
          scene: {
            ...job.scene,
            attempts: job.scene.attempts.map(publicAttempt),
          },
        }
      : {}),
    sam: {
      status: job.sam.status,
      attempts: job.sam.attempts.map(publicAttempt),
      ...(job.sam.snapshotRef ? { snapshotRef: job.sam.snapshotRef } : {}),
    },
    muse: {
      status: job.muse.status,
      attempts: job.muse.attempts.map(publicAttempt),
      ...(job.muse.resultAttemptId
        ? { resultAttemptId: job.muse.resultAttemptId }
        : {}),
    },
    recovery: {
      ...job.recovery,
      attempts: job.recovery.attempts.map(publicAttempt),
    },
    wireIdentities: job.wireIdentities,
    ...(job.experiment ? { experiment: job.experiment } : {}),
    ...(job.candidatePublicationError
      ? { candidatePublicationError: job.candidatePublicationError }
      : {}),
    ...(job.candidateResult
      ? { result: job.candidateResult }
      : job.muse.result
        ? { result: job.muse.result }
        : job.sam.result
          ? { result: job.sam.result }
          : {}),
  };
}

function publicAttempt(attempt: Attempt) {
  const {
    result: _prediction,
    recoveryReport: _report,
    ...publicFields
  } = attempt;
  void _report;
  void _prediction;
  return publicFields;
}

export function emptyRecovery(): Job['recovery'] {
  return {
    status: 'not_started',
    attempts: [],
    operation: 'audit',
    budget: { requests: 0, pixels: 0, verificationRequests: 0, rounds: 0 },
    visited: [],
    cropAttempts: [],
  };
}
