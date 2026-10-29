import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';
import type { Diagnostics } from '../lib/diagnostics.js';
import type { Analysis, PreparedImage } from '../schemas/vision.js';
import type { SamSnapshot } from '../services/vision.js';

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
  settings: {
    maxDimension: number;
    minimalPrompt: boolean;
    mode: Config['VISION_MODE'];
    samModel: string;
    museModel: string;
  };
  sam: {
    status: AttemptStatus | 'not_started';
    attempts: Attempt[];
    snapshot?: SamSnapshot;
    result?: Analysis;
  };
  muse: {
    status: AttemptStatus | 'not_started';
    attempts: Attempt[];
    result?: Analysis;
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
export const lastAttempt = (job: Job, stage: 'sam' | 'muse') =>
  job[stage].attempts.at(-1);

/** SQLite transactions serialize claims/retries across workers; image and state commit together. */
export class JobStore {
  readonly db: DatabaseSync;
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
    if (row.owner) {
      job.owner = row.owner as string;
      job.leaseUntil = row.lease_until as number;
    } else {
      delete job.owner;
      delete job.leaseUntil;
    }
    return job;
  }
  save(job: Job) {
    job.updatedAt = Date.now();
    this.db
      .prepare(
        'UPDATE jobs SET data=?,owner=?,lease_until=?,expires_at=?,queued_stage=? WHERE id=?',
      )
      .run(
        JSON.stringify(job),
        job.owner ?? null,
        job.leaseUntil ?? null,
        job.expiresAt,
        job.sam.status === 'queued'
          ? 'sam'
          : job.muse.status === 'queued'
            ? 'muse'
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
      .prepare('DELETE FROM jobs WHERE owner IS NULL AND expires_at<=?')
      .run(now);
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
        },
        sam: {
          status: 'queued',
          attempts: [newAttempt()],
          snapshot: { image, candidates: [] },
        },
        muse: { status: 'not_started', attempts: [] },
      };
      this.db
        .prepare(
          'INSERT INTO jobs (id,data,image,expires_at,queued_stage) VALUES (?,?,?,?,?)',
        )
        .run(job.analysisId, JSON.stringify(job), bytes, job.expiresAt, 'sam');
      return job;
    });
  }
  retry(id: string, stage: 'sam' | 'muse'): Job {
    return this.transaction(() => {
      const job = this.get(id);
      if (
        job.owner ||
        ['queued', 'running'].includes(job.sam.status) ||
        ['queued', 'running'].includes(job.muse.status)
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
      if (job[stage].attempts.length >= 20)
        throw new AppError(
          409,
          'ATTEMPT_LIMIT',
          'This analysis has reached its manual attempt limit.',
        );
      job[stage].attempts.push(newAttempt());
      job[stage].status = 'queued';
      job.status = stage === 'muse' ? 'partial' : 'queued';
      this.save(job);
      return job;
    });
  }
  recover(now = Date.now()) {
    for (const row of this.db
      .prepare('SELECT id FROM jobs WHERE owner IS NOT NULL AND lease_until<=?')
      .all(now)) {
      const job = this.get(row.id as string);
      for (const stage of ['sam', 'muse'] as const) {
        const a = lastAttempt(job, stage);
        if (a?.status === 'running') {
          a.status = 'interrupted';
          a.upstreamOutcome = 'unknown';
          a.retryPolicy = 'manual_only';
          a.errorCode = 'WORKER_INTERRUPTED';
          a.finishedAt = now;
          job[stage].status = 'interrupted';
        }
      }
      delete job.owner;
      delete job.leaseUntil;
      job.status = job.sam.result ? 'partial' : 'failed';
      this.save(job);
    }
  }
  claim(
    owner: string,
  ): { job: Job; stage: 'sam' | 'muse'; attemptId: string } | undefined {
    return this.transaction(() => {
      this.recover();
      this.cleanup();
      if (
        Number(
          this.db
            .prepare(
              'SELECT COUNT(*) AS count FROM jobs WHERE owner IS NOT NULL',
            )
            .get()!.count,
        ) >= this.config.MAX_CONCURRENT_ANALYSES
      )
        return;
      const row = this.db
        .prepare(
          'SELECT id,queued_stage FROM jobs WHERE owner IS NULL AND queued_stage IS NOT NULL ORDER BY rowid LIMIT 1',
        )
        .get();
      if (row) {
        const job = this.get(row.id as string);
        const stage = row.queued_stage as 'sam' | 'muse';
        const a = lastAttempt(job, stage)!;
        if (a.status !== 'queued') return;
        a.status = 'running';
        a.startedAt = Date.now();
        a.upstreamOutcome = 'unknown';
        a.retryPolicy = 'blocked';
        job[stage].status = 'running';
        job.status = stage === 'sam' ? 'segmenting' : 'interpreting';
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
    stage: 'sam' | 'muse',
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
    stage: 'sam' | 'muse',
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
      if (this.get(id).owner)
        throw new AppError(
          409,
          'ATTEMPT_ACTIVE',
          'Wait for the active attempt to finish before deleting this analysis.',
        );
      this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
    });
  }
  close() {
    this.db.close();
  }
}
export function publicJob(job: Job) {
  return {
    analysisId: job.analysisId,
    imageHash: job.imageHash,
    image: job.image,
    status: job.status,
    revision: job.revision,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    settings: job.settings,
    sam: { status: job.sam.status, attempts: job.sam.attempts },
    muse: { status: job.muse.status, attempts: job.muse.attempts },
    ...(job.muse.result
      ? { result: job.muse.result }
      : job.sam.result
        ? { result: job.sam.result }
        : {}),
  };
}
