import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { CircuitSessionService } from '../jobs/circuit-sessions.js';
import type { JobStore } from '../jobs/store.js';
export function registerCircuitSessionRoutes(
  app: FastifyInstance,
  store: JobStore,
  kick: () => void,
) {
  const service = new CircuitSessionService(store);
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  app.post('/api/circuit-sessions', async () => service.create());
  app.get('/api/circuit-sessions/:id', async (req) =>
    service.view(id(req.params)),
  );
  app.get('/api/circuit-sessions/:id/evidence', async (req, reply) =>
    reply
      .header(
        'Content-Disposition',
        'attachment; filename="praxis-circuit-session-evidence.json"',
      )
      .send(service.evidence(id(req.params))),
  );
  for (const action of [
    'profile',
    'prepare-capture',
    'seed-capture',
    'review-capture',
    'plan-repair',
    'verify-repair',
    'prepare-endpoints',
    'run-endpoints',
  ] as const)
    app.post(
      `/api/circuit-sessions/:id/${action}`,
      { bodyLimit: 2 * 1024 * 1024 },
      async (req, reply) => {
        try {
          const sid = id(req.params);
          const result =
            action === 'profile'
              ? service.saveProfile(sid, req.body)
              : action === 'prepare-capture'
                ? service.prepare(sid, req.body)
                : action === 'seed-capture'
                  ? await service.seed(sid, req.body)
                  : action === 'review-capture'
                    ? service.review(sid, req.body)
                    : action === 'plan-repair'
                      ? service.repair(sid, req.body)
                      : action === 'verify-repair'
                        ? service.verify(sid, req.body)
                        : action === 'prepare-endpoints'
                          ? await service.prepareEndpoints(sid, req.body)
                          : service.runEndpoints(sid, req.body);
          if (action === 'run-endpoints') setImmediate(kick);
          return reply
            .code(action === 'run-endpoints' ? 202 : 200)
            .send(result);
        } catch (e) {
          if (e instanceof AppError) throw e;
          throw new AppError(
            400,
            'INVALID_CIRCUIT_ACTION',
            e instanceof Error
              ? e.message.slice(0, 300)
              : 'Invalid circuit evidence.',
          );
        }
      },
    );
}
