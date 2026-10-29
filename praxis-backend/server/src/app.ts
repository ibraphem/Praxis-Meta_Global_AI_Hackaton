import { JobStore } from './jobs/store.js';
import { AnalysisWorker, type VisionStages } from './jobs/worker.js';
import { registerAnalysisRoutes } from './routes/analyses.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config.js';
import { AppError } from './lib/errors.js';
import { registerVisionRoute, type AnalyzeImage } from './routes/vision.js';
import { createVisionService } from './services/vision.js';
import { createEndpointProposalService } from './services/endpoint-proposals.js';
import { logTrace, type TraceLogger } from './lib/diagnostics.js';

/** Build separately from listen(), so HTTP behavior can be tested without ports. */
export async function buildApp(
  config: Config,
  analyze: AnalyzeImage = createVisionService(config),
  traceLogger: TraceLogger = config.NODE_ENV === 'test'
    ? () => undefined
    : logTrace,
  proposeEndpoints = createEndpointProposalService(config),
  jobOptions?: { store: JobStore; stages?: VisionStages },
) {
  const app = Fastify({
    logger: false,
    bodyLimit: config.MAX_UPLOAD_BYTES,
    requestTimeout: 15_000,
    // Do not let the idle socket timer cut off a valid, longer model analysis.
    connectionTimeout: config.ANALYSIS_TIMEOUT_MS + 15_000,
    trustProxy: false,
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          supplied,
        )
        ? supplied
        : randomUUID();
    },
  });
  const expectedHash = config.PRAXIS_API_TOKEN
    ? createHash('sha256').update(config.PRAXIS_API_TOKEN).digest()
    : undefined;
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Request-Id', request.id);
    if (request.url.split('?')[0] === '/health') return;
    if (expectedHash) {
      const header = request.headers.authorization ?? '';
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
      const suppliedHash = createHash('sha256').update(supplied).digest();
      if (!timingSafeEqual(expectedHash, suppliedHash)) {
        reply.header('WWW-Authenticate', 'Bearer');
        throw new AppError(
          401,
          'UNAUTHORIZED',
          'A valid Praxis bearer token is required.',
        );
      }
    }
    // CORS is intentionally disabled. Reject browser cross-origin submissions,
    // including multipart "simple requests" that do not require a preflight.
    if (request.headers.origin)
      throw new AppError(
        403,
        'BROWSER_ORIGIN_DENIED',
        'Browser-origin requests are not enabled for this backend.',
      );
  });
  await app.register(helmet);
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: () =>
      new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.'),
  });
  await app.register(multipart, {
    limits: {
      fileSize: config.MAX_UPLOAD_BYTES,
      files: 1,
      fields: 0,
      parts: 1,
      fieldNameSize: 100,
      headerPairs: 50,
    },
    throwFileSizeLimit: true,
  });

  app.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
  }));
  const capacity = { active: 0 };
  const jobStore =
    jobOptions?.store ??
    new JobStore(
      config,
      config.NODE_ENV === 'test' ? ':memory:' : config.ANALYSIS_JOB_DIR,
    );
  const worker = new AnalysisWorker(
    jobStore,
    config,
    traceLogger,
    jobOptions?.stages,
    capacity,
  );
  registerAnalysisRoutes(app, config, jobStore, () => worker.tick());
  app.addHook('onReady', async () => {
    worker.start();
  });
  app.addHook('onClose', async () => {
    await worker.close();
    if (!jobOptions?.store) jobStore.close();
  });
  registerVisionRoute(app, config, analyze, traceLogger, { capacity });
  registerVisionRoute(app, config, proposeEndpoints, traceLogger, {
    path: '/api/vision/endpoints',
    allowContext: true,
    capacity,
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.',
        requestId: request.id,
      },
    }),
  );
  app.setErrorHandler(
    (error: Error & { code?: string; statusCode?: number }, request, reply) => {
      let safe: AppError;
      if (error instanceof AppError) safe = error;
      else if (
        error.code === 'FST_REQ_FILE_TOO_LARGE' ||
        error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
      )
        safe = new AppError(
          413,
          'UPLOAD_TOO_LARGE',
          'The image exceeds the upload limit.',
        );
      else if (
        error.code?.startsWith('FST_') &&
        error.statusCode &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        safe = new AppError(
          error.statusCode,
          'INVALID_REQUEST',
          'The upload or request is invalid.',
        );
      else if (error.statusCode === 429)
        safe = new AppError(
          429,
          'RATE_LIMITED',
          'Too many requests. Try again later.',
        );
      else if (
        error.statusCode &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        safe = new AppError(
          error.statusCode,
          'INVALID_REQUEST',
          'The request is invalid.',
        );
      else
        safe = new AppError(
          500,
          'INTERNAL_ERROR',
          'An unexpected server error occurred.',
        );
      // Deliberately exclude messages/stacks: decoder and provider errors can contain user data.
      if (safe.statusCode >= 500 && config.NODE_ENV !== 'test')
        console.error(
          JSON.stringify({
            requestId: request.id,
            code: safe.code,
            statusCode: safe.statusCode,
            ...(safe.details ? { details: safe.details } : {}),
          }),
        );
      return reply.code(safe.statusCode).send({
        error: {
          code: safe.code,
          message: safe.message,
          requestId: request.id,
          ...(safe.details ? { details: safe.details } : {}),
        },
      });
    },
  );
  return app;
}
