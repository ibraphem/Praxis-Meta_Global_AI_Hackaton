import type { JobStore } from './store.js';
import { canonicalHash } from '../lib/canonical-json.js';
import { AppError } from '../lib/errors.js';
import type { JunctionRecord } from '../schemas/connector-junctions.js';
import type {
  JunctionMask,
  JunctionConductor,
} from '../services/connector-junctions.js';
export interface JunctionPrivateRecord extends Omit<
  JunctionRecord,
  | 'reviews'
  | 'references'
  | 'evaluations'
  | 'effectiveOutcomes'
  | 'accounting'
  | 'evidenceUrl'
> {
  dispatchedAt: number | null;
  responseAt: number | null;
  evidence: {
    body: JunctionMask;
    conductors: JunctionConductor[];
    acceptanceEvidence: unknown;
    boundaryPixelCount: number;
    boundarySampleStride: number;
    images: Array<{
      kind: string;
      mimeType: string;
      base64: string;
      sha256: string;
    }>;
    requestBody: Record<string, unknown>;
    providerOutput?: unknown;
    decodedAt?: number;
  };
}
export function ensureJunctionTables(store: JobStore) {
  store.db.exec(`
  CREATE TABLE IF NOT EXISTS connector_junctions (id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS junctions_analysis ON connector_junctions(analysis_id);
  CREATE TABLE IF NOT EXISTS connector_junction_reviews (id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,plan_id TEXT NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS connector_junction_references (id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,plan_id TEXT NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS connector_junction_evaluations (id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,plan_id TEXT NOT NULL,data TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS immutable_junction_reviews BEFORE UPDATE ON connector_junction_reviews BEGIN SELECT RAISE(ABORT,'Junction reviews are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_junction_references BEFORE UPDATE ON connector_junction_references BEGIN SELECT RAISE(ABORT,'Junction references are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_junction_evaluations BEFORE UPDATE ON connector_junction_evaluations BEGIN SELECT RAISE(ABORT,'Junction evaluations are immutable'); END;
`);
}
export const junctionTables = [
  'connector_junctions',
  'connector_junction_reviews',
  'connector_junction_references',
  'connector_junction_evaluations',
] as const;
export function getJunction(
  store: JobStore,
  planId: string,
  analysisId?: string,
): JunctionPrivateRecord {
  const row = store.db
    .prepare('SELECT data FROM connector_junctions WHERE id=?')
    .get(planId);
  if (!row)
    throw new AppError(
      404,
      'JUNCTION_NOT_FOUND',
      'Prepared connector junction attempt not found.',
    );
  const r = JSON.parse(row.data as string) as JunctionPrivateRecord,
    { planId: hash, ...body } = r.plan;
  if (
    hash !== canonicalHash(body) ||
    (analysisId && r.plan.analysisId !== analysisId)
  )
    throw new AppError(
      409,
      'JUNCTION_BINDING_MISMATCH',
      'Junction plan integrity or analysis binding failed.',
    );
  return r;
}
export function changeJunction(
  store: JobStore,
  id: string,
  fn: (r: JunctionPrivateRecord) => void,
) {
  const work = () => {
    const r = getJunction(store, id),
      revision = r.revision;
    fn(r);
    r.revision++;
    if (
      store.db
        .prepare(
          "UPDATE connector_junctions SET data=? WHERE id=? AND json_extract(data,'$.revision')=?",
        )
        .run(JSON.stringify(r), id, revision).changes !== 1
    )
      throw new AppError(
        409,
        'JUNCTION_CHANGED',
        'Reload the current junction evidence.',
      );
    return r;
  };
  return store.inTransaction ? work() : store.transaction(work);
}
/** Called in the existing job recovery transaction; never reschedules provider work. */
export function recoverJunctions(store: JobStore, now: number) {
  for (const row of store.db
    .prepare(
      "SELECT id,data FROM connector_junctions WHERE json_extract(data,'$.phase') IN ('queued','admitted','dispatching','response_recorded')",
    )
    .all()) {
    const r = JSON.parse(row.data as string) as JunctionPrivateRecord,
      job = store.get(r.plan.analysisId),
      attempt = job.scene?.attempts.find((a) => a.attemptId === r.attemptId);
    if (
      attempt &&
      (attempt.status === 'queued' || attempt.status === 'running')
    )
      continue;
    changeJunction(store, row.id as string, (next) => {
      next.phase = 'interrupted';
      next.finishedAt = now;
      next.errorCode = 'WORKER_INTERRUPTED';
      next.outcomes = next.outcomes.map((o) => ({
        ...o,
        reason: next.responseAt
          ? 'Provider response retained; interpretation interrupted.'
          : 'Worker interrupted; junction remains unresolved. No provider replay is permitted.',
      }));
    });
  }
}
