import type { FastifyInstance } from 'fastify';
import type { AutomaticCircuitService } from '../jobs/automatic-circuits.js';
import { AppError } from '../lib/errors.js';
import { z } from 'zod';

export function registerAutomaticCircuitRoutes(
  app: FastifyInstance,
  service: AutomaticCircuitService,
) {
  const id = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  app.post('/api/circuit-inspections', async (request, reply) => {
    if (!request.isMultipart())
      throw new AppError(
        415,
        'EXPECTED_MULTIPART',
        'Upload one circuit photograph.',
      );
    let bytes: Buffer | undefined;
    let geometry: unknown;
    for await (const part of request.parts({
      limits: { fields: 1, parts: 2, fieldSize: 512 * 1024 },
    })) {
      if (
        part.type === 'field' &&
        part.fieldname === 'geometry' &&
        geometry === undefined &&
        !part.valueTruncated &&
        typeof part.value === 'string'
      ) {
        try {
          geometry = JSON.parse(part.value);
        } catch {
          throw new AppError(
            400,
            'INVALID_GEOMETRY',
            'Local grid measurements are invalid.',
          );
        }
        continue;
      }
      if (part.type !== 'file' || part.fieldname !== 'image' || bytes)
        throw new AppError(400, 'INVALID_UPLOAD', 'Upload one image field.');
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
        'A circuit photograph is required.',
      );
    return reply.code(202).send(await service.create(bytes, geometry));
  });
  app.get(
    '/api/circuit-inspections/:id',
    { config: { rateLimit: { max: 240, timeWindow: 60000 } } },
    async (request) => service.get(id(request.params)),
  );
  app.get('/api/circuit-inspections/:id/image', async (request, reply) =>
    reply
      .type('image/jpeg')
      .send(Buffer.from(service.image(id(request.params)))),
  );
  app.get('/api/circuit-inspections/:id/evidence', async (request, reply) =>
    reply
      .header(
        'Content-Disposition',
        'attachment; filename="praxis-circuit-inspection.json"',
      )
      .send(service.evidence(id(request.params))),
  );
  app.delete('/api/circuit-inspections/:id', async (request, reply) => {
    service.remove(id(request.params));
    return reply.code(204).send();
  });
  for (const action of ['review', 'calibrate', 'localize', 'diagnose'] as const)
    app.post(
      `/api/circuit-inspections/:id/${action}`,
      { bodyLimit: 2 * 1024 * 1024 },
      async (request) => {
        try {
          return action === 'localize'
            ? service.localize(id(request.params), request.body)
            : action === 'review'
              ? service.review(id(request.params), request.body)
              : action === 'diagnose'
                ? await service.diagnose(id(request.params), request.body)
                : service.recalibrate(id(request.params), request.body);
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(
            400,
            'INVALID_REVIEW',
            error instanceof Error
              ? error.message.slice(0, 400)
              : 'Invalid circuit review.',
          );
        }
      },
    );
}
