import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/errors.js';
import type { JobStore } from './store.js';
import type { SnapshotRef } from './snapshots.js';

export interface ExperimentRecord {
  experimentId: string;
  analysisId: string;
  snapshotRef: SnapshotRef;
  createdAt: number;
  finishedAt?: number;
  status: 'running' | 'completed' | 'interrupted' | 'released';
  owner?: string;
  leaseUntil: number;
  report?: unknown;
}
/** One reservation across this local database, including legacy request admission. */
export class ExperimentRegistry {
  constructor(private readonly store: JobStore) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, status TEXT NOT NULL, owner TEXT, lease_until INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS experiments_reserved ON experiments((1)) WHERE status IN ('running','interrupted');
      CREATE TABLE IF NOT EXISTS legacy_requests (id TEXT PRIMARY KEY, lease_until INTEGER NOT NULL);`);
  }
  get(id: string): ExperimentRecord {
    const row = this.store.db
      .prepare('SELECT * FROM experiments WHERE id=?')
      .get(id);
    if (!row)
      throw new AppError(
        404,
        'EXPERIMENT_NOT_FOUND',
        'The saved experiment was not found.',
      );
    const record = JSON.parse(row.data as string) as ExperimentRecord;
    record.status = row.status as ExperimentRecord['status'];
    record.leaseUntil = row.lease_until as number;
    if (row.owner) record.owner = row.owner as string;
    else delete record.owner;
    if (record.status === 'running' && record.leaseUntil <= Date.now()) {
      record.status = 'interrupted';
      delete record.owner;
    }
    return record;
  }
  active(): ExperimentRecord | undefined {
    const row = this.store.db
      .prepare(
        "SELECT id FROM experiments WHERE status IN ('running','interrupted') LIMIT 1",
      )
      .get();
    return row ? this.get(row.id as string) : undefined;
  }
  /** Called inside the caller's transaction; interrupted upstream work is never assumed stopped. */
  recover(now = Date.now()) {
    this.store.db
      .prepare(
        "UPDATE experiments SET status='interrupted',owner=NULL WHERE status='running' AND lease_until<=?",
      )
      .run(now);
    this.store.db
      .prepare('DELETE FROM legacy_requests WHERE lease_until<=?')
      .run(now);
  }
  reserve(analysisId: string): ExperimentRecord {
    this.store.recover();
    return this.store.transaction(() => {
      this.recover();
      if (this.active())
        throw new AppError(
          409,
          'EXPERIMENT_RESERVED',
          'Another experiment owns the reservation. Interrupted reservations require explicit release.',
        );
      const job = this.store.get(analysisId);
      if (
        job.sam.status !== 'succeeded' ||
        !job.sam.snapshotRef ||
        job.settings.mode !== 'combined' ||
        job.owner ||
        ['queued', 'running'].includes(job.muse.status)
      )
        throw new AppError(
          409,
          'EXPERIMENT_SOURCE_ACTIVE',
          'Use an inactive combined analysis with completed SAM results.',
        );
      const busy =
        Number(
          this.store.db
            .prepare('SELECT COUNT(*) AS n FROM jobs WHERE owner IS NOT NULL')
            .get()!.n,
        ) +
        Number(
          this.store.db
            .prepare('SELECT COUNT(*) AS n FROM legacy_requests')
            .get()!.n,
        );
      if (busy)
        throw new AppError(
          409,
          'EXPERIMENT_WORKLOAD_ACTIVE',
          'Wait for active job and legacy model requests to finish before starting a controlled experiment.',
        );
      if (
        Number(
          this.store.db
            .prepare(
              'SELECT COUNT(*) AS n FROM experiments WHERE analysis_id=?',
            )
            .get(analysisId)!.n,
        ) >= 20
      )
        throw new AppError(
          409,
          'EXPERIMENT_LIMIT',
          'This analysis has reached its experiment limit.',
        );
      const record: ExperimentRecord = {
        experimentId: randomUUID(),
        analysisId,
        snapshotRef: job.sam.snapshotRef,
        createdAt: Date.now(),
        status: 'running',
        owner: randomUUID(),
        leaseUntil: Date.now() + 15000,
      };
      this.store.db
        .prepare('INSERT INTO experiments VALUES (?,?,?,?,?,?)')
        .run(
          record.experimentId,
          analysisId,
          record.status,
          record.owner!,
          record.leaseUntil,
          JSON.stringify(record),
        );
      return record;
    });
  }
  renew(id: string, owner: string): boolean {
    const now = Date.now();
    return (
      this.store.db
        .prepare(
          "UPDATE experiments SET lease_until=? WHERE id=? AND owner=? AND status='running' AND lease_until>?",
        )
        .run(now + 15000, id, owner, now).changes === 1
    );
  }
  record(
    id: string,
    owner: string,
    report: unknown,
    status: 'running' | 'completed' | 'interrupted' = 'running',
  ): boolean {
    return this.store.transaction(() => {
      const current = this.get(id);
      if (
        current.owner !== owner ||
        current.status !== 'running' ||
        current.leaseUntil <= Date.now()
      )
        return false;
      current.report = report;
      current.status = status;
      if (status !== 'running') {
        current.finishedAt = Date.now();
        delete current.owner;
      }
      return (
        this.store.db
          .prepare(
            "UPDATE experiments SET data=?,status=?,owner=? WHERE id=? AND owner=? AND status='running' AND lease_until>?",
          )
          .run(
            JSON.stringify(current),
            status,
            current.owner ?? null,
            id,
            owner,
            Date.now(),
          ).changes === 1
      );
    });
  }
  releaseInterrupted(id: string) {
    return this.store.transaction(() => {
      this.recover();
      const record = this.get(id);
      if (record.status !== 'interrupted')
        throw new AppError(
          409,
          'EXPERIMENT_NOT_INTERRUPTED',
          'Only an interrupted experiment may be manually released.',
        );
      record.status = 'released';
      record.finishedAt = Date.now();
      delete record.owner;
      this.store.db
        .prepare(
          "UPDATE experiments SET data=?,status='released',owner=NULL WHERE id=? AND status='interrupted'",
        )
        .run(JSON.stringify(record), id);
    });
  }
  enterLegacyRequest(): () => void {
    const id = randomUUID();
    this.store.transaction(() => {
      this.recover();
      if (this.active())
        throw new AppError(
          503,
          'EXPERIMENT_RESERVED',
          'Controlled Muse evaluation has reserved model admission. Retry after it finishes or its interrupted reservation is released.',
        );
      this.store.db
        .prepare('INSERT INTO legacy_requests VALUES (?,?)')
        .run(id, Date.now() + this.store.config.ANALYSIS_TIMEOUT_MS + 15000);
    });
    return () => {
      this.store.db.prepare('DELETE FROM legacy_requests WHERE id=?').run(id);
    };
  }
  forAnalysis(id: string): ExperimentRecord[] {
    return this.store.db
      .prepare('SELECT id FROM experiments WHERE analysis_id=? ORDER BY rowid')
      .all(id)
      .map((row) => this.get(row.id as string));
  }
}
