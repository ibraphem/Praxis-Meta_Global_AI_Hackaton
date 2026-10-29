import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createMetaClient, type MetaClient } from '../lib/meta-client.js';
import { AppError } from '../lib/errors.js';
import type { JobStore } from './store.js';
/** Shared local Muse admission, including endpoint, interpretation and candidate verification calls. */
export function admittedClient(
  store: JobStore,
  permit?: { experimentId: string; owner: string },
  base: MetaClient = createMetaClient(store.config),
): MetaClient {
  return {
    async post(path, body, signal, operation) {
      if (!operation?.stage.startsWith('muse.'))
        return base.post(path, body, signal, operation);
      const finish = operation.trace?.begin('muse.admission'),
        started = Date.now(),
        id = randomUUID(),
        lost = new AbortController();
      let acquired = false;
      try {
        while (!acquired) {
          signal.throwIfAborted();
          acquired = store.transaction(() => {
            const now = Date.now(),
              reservation = store.experiments.active();
            if (
              reservation &&
              (!permit ||
                reservation.experimentId !== permit.experimentId ||
                reservation.owner !== permit.owner ||
                reservation.status !== 'running')
            )
              throw new AppError(
                409,
                'EXPERIMENT_RESERVED',
                'Model admission is reserved.',
              );
            store.db
              .prepare('DELETE FROM model_requests WHERE lease_until<=?')
              .run(now);
            if (
              Number(
                store.db
                  .prepare('SELECT COUNT(*) AS n FROM model_requests')
                  .get()!.n,
              ) >= store.config.MUSE_CONCURRENCY
            )
              return false;
            store.db
              .prepare('INSERT INTO model_requests VALUES (?,?)')
              .run(id, now + 15000);
            return true;
          });
          if (!acquired) {
            if (Date.now() - started >= store.config.PROVIDER_TIMEOUT_MS)
              throw new AppError(
                503,
                'MODEL_ADMISSION_TIMEOUT',
                'The local Muse request queue reached its deadline.',
              );
            await delay(25, undefined, { signal });
          }
        }
        finish?.('completed');
      } catch (error) {
        finish?.(signal.aborted ? 'cancelled' : 'failed');
        throw error;
      }
      const timer = setInterval(() => {
        try {
          if (
            store.db
              .prepare(
                'UPDATE model_requests SET lease_until=? WHERE id=? AND lease_until>?',
              )
              .run(Date.now() + 15000, id, Date.now()).changes !== 1
          )
            lost.abort(
              new AppError(
                503,
                'WORKER_INTERRUPTED',
                'Model request admission ownership was lost.',
              ),
            );
        } catch {
          lost.abort(
            new AppError(
              503,
              'WORKER_INTERRUPTED',
              'Model request admission could not be renewed.',
            ),
          );
        }
      }, 3000);
      try {
        const joined = AbortSignal.any([signal, lost.signal]),
          result = await base.post(path, body, joined, operation);
        joined.throwIfAborted();
        if (
          !store.db
            .prepare(
              'SELECT id FROM model_requests WHERE id=? AND lease_until>?',
            )
            .get(id, Date.now())
        )
          throw new AppError(
            503,
            'WORKER_INTERRUPTED',
            'Model request admission ownership was lost.',
          );
        return result;
      } finally {
        clearInterval(timer);
        store.db.prepare('DELETE FROM model_requests WHERE id=?').run(id);
      }
    },
  };
}
