import { createHash } from 'node:crypto';
/** Stable JSON for persisted contracts; key order is never part of inference identity. */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, normalize(v)]),
      );
    throw new Error('Non-JSON value in frozen contract.');
  };
  return JSON.stringify(normalize(value));
}
export const canonicalHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
