import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { JobStore, publicJob } from '../jobs/store.js';
import { z } from 'zod';
import { prepareImage } from '../services/image.js';

const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function registerAnalysisRoutes(
  app: FastifyInstance,
  config: Config,
  store: JobStore,
  kick: () => void,
) {
  let uploads = 0;
  app.post('/api/analyses', async (request, reply) => {
    if (!request.isMultipart())
      throw new AppError(
        415,
        'EXPECTED_MULTIPART',
        'Send one photograph in the image field.',
      );
    if (uploads >= config.MAX_CONCURRENT_ANALYSES)
      throw new AppError(
        503,
        'SERVER_BUSY',
        'Upload capacity is busy. Try again shortly.',
      );
    uploads++;
    try {
      let bytes: Buffer | undefined;
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'image' || bytes)
          throw new AppError(
            400,
            'INVALID_UPLOAD',
            'Send exactly one photograph in the image field.',
          );
        bytes = await part.toBuffer();
        if (part.file.truncated)
          throw new AppError(
            413,
            'UPLOAD_TOO_LARGE',
            'The image exceeds the upload limit.',
          );
      }
      if (!bytes)
        throw new AppError(
          400,
          'MISSING_IMAGE',
          'The image field is required.',
        );
      const image = await prepareImage(bytes, config);
      const job = store.create(bytes, image);
      // The durable commit precedes 202. Polling is not required for execution.
      setImmediate(kick);
      return reply.code(202).send(publicJob(job));
    } finally {
      uploads--;
    }
  });
  const id = (params: unknown) => {
    const value = (params as { id: string }).id;
    if (!idPattern.test(value))
      throw new AppError(
        404,
        'ANALYSIS_NOT_FOUND',
        'The saved analysis was not found.',
      );
    return value;
  };
  // Polling is cheap and must not exhaust the provider submission rate limit.
  app.get(
    '/api/analyses/:id',
    { config: { rateLimit: { max: 240, timeWindow: 60_000 } } },
    async (request) => publicJob(store.get(id(request.params))),
  );
  app.get('/api/analyses/:id/image', async (request, reply) => {
    const bytes = store.image(id(request.params));
    const type =
      bytes[0] === 0xff
        ? 'image/jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF'
          ? 'image/webp'
          : 'image/png';
    return reply.type(type).send(bytes);
  });
  for (const stage of ['sam', 'muse'] as const)
    app.post(`/api/analyses/:id/retry-${stage}`, async (request, reply) => {
      const job = store.retry(id(request.params), stage);
      setImmediate(kick);
      return reply.code(202).send(publicJob(job));
    });
  for (const [path, operation] of [
    ['audit-wires', 'audit'],
    ['recover-wires', 'recover'],
    ['recover-short-wires', 'recover_short'],
    ['verify-wire', 'verify'],
    ['retry-wire-crop', 'retry_crop'],
    ['verify-wire-extension', 'verify_extension'],
  ] as const)
    app.post(`/api/analyses/:id/${path}`, async (request, reply) => {
      const body =
        operation === 'verify'
          ? z
              .object({
                candidateId: z
                  .string()
                  .regex(/^(jumper_wire|cv_trace)_[1-9]\d*$/),
              })
              .strict()
              .safeParse(request.body)
          : undefined;
      if (body && !body.success)
        throw new AppError(
          400,
          'INVALID_CANDIDATES',
          'Choose one current recovery candidate.',
        );
      const job = store.requestRecovery(
        id(request.params),
        operation,
        body?.success ? body.data.candidateId : undefined,
        ['recover_short', 'retry_crop', 'verify_extension'].includes(operation)
          ? request.body
          : undefined,
      );
      setImmediate(kick);
      return reply.code(202).send(publicJob(job));
    });
  app.post('/api/analyses/:id/interpret-recovery', async (request, reply) => {
    const job = store.interpretRecovery(id(request.params));
    setImmediate(kick);
    return reply.code(202).send(publicJob(job));
  });
  app.post('/api/analyses/:id/wire-identities', async (request, reply) =>
    reply.send(
      publicJob(store.reviewWireIdentity(id(request.params), request.body)),
    ),
  );
  app.delete('/api/analyses/:id', async (request, reply) => {
    store.remove(id(request.params));
    return reply.code(204).send();
  });
}
