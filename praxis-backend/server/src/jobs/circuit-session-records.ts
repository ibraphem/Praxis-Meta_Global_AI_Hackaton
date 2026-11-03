import type { JobStore } from './store.js';
export const circuitSessionTables = [
  'circuit_profiles',
  'circuit_sessions',
  'circuit_captures',
  'circuit_repairs',
  'circuit_verifications',
  'circuit_capture_reviews',
] as const;
export function ensureCircuitSessionTables(store: JobStore) {
  for (const name of circuitSessionTables)
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY,analysis_id TEXT,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${name}_analysis ON ${name}(analysis_id);`,
    );
  for (const name of [
    'circuit_profiles',
    'circuit_repairs',
    'circuit_verifications',
    'circuit_capture_reviews',
  ])
    store.db.exec(
      `CREATE TRIGGER IF NOT EXISTS immutable_${name} BEFORE UPDATE ON ${name} BEGIN SELECT RAISE(ABORT,'Circuit evidence is immutable'); END;`,
    );
}
