import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { AppError, abortError } from '../lib/errors.js';
import { AnalysisTrace, type TraceLogger } from '../lib/diagnostics.js';
import type { Analysis } from '../schemas/vision.js';

export type AnalyzeImage = (
  bytes: Buffer,
  signal: AbortSignal,
  trace?: AnalysisTrace,
) => Promise<Analysis>;

/** Admit requests before buffering, with no unbounded queue of photographs. */
export function registerVisionRoute<T extends object = Analysis>(
  app: FastifyInstance,
  config: Config,
  analyze: (
    bytes: Buffer,
    signal: AbortSignal,
    trace?: AnalysisTrace,
    context?: unknown,
  ) => Promise<T>,
  logger: TraceLogger = () => undefined,
  options: {
    path?: string;
    allowContext?: boolean;
    capacity?: { active: number };
  } = {},
) {
  const capacity = options.capacity ?? { active: 0 };
  app.post(options.path ?? '/api/vision/analyze', async (request, reply) => {
    if (!request.isMultipart())
      throw new AppError(
        415,
        'EXPECTED_MULTIPART',
        'Send multipart/form-data with one image field.',
      );
    if (capacity.active >= config.MAX_CONCURRENT_ANALYSES) {
      reply.header('Retry-After', '2');
      throw new AppError(
        503,
        'SERVER_BUSY',
        'All analysis slots are busy. Try again shortly.',
      );
    }
    capacity.active++;
    const trace = new AnalysisTrace(request.id, logger);
    trace.emit('vision.analysis_started', {
      timeoutMs: config.ANALYSIS_TIMEOUT_MS,
      providerTimeoutMs: config.PROVIDER_TIMEOUT_MS,
      samConcurrency: config.SAM_CONCURRENCY,
    });
    const controller = new AbortController();
    const deadline = setTimeout(
      () =>
        controller.abort(
          new AppError(
            504,
            'ANALYSIS_TIMEOUT',
            'The backend analysis deadline was exceeded.',
            {
              source: 'backend_analysis',
              timeoutMs: config.ANALYSIS_TIMEOUT_MS,
              elapsedMs: trace.elapsedMs,
              activeStages: trace.activeStages(),
            },
          ),
        ),
      config.ANALYSIS_TIMEOUT_MS,
    );
    deadline.unref();
    const disconnect = () => {
      if (!reply.raw.writableEnded)
        controller.abort(
          new AppError(
            499,
            'REQUEST_CANCELLED',
            'The client disconnected from the backend.',
            {
              source: 'client',
              elapsedMs: trace.elapsedMs,
              activeStages: trace.activeStages(),
            },
          ),
        );
    };
    request.raw.once('aborted', disconnect);
    reply.raw.once('close', disconnect);
    let bytes: Buffer | undefined;
    let context: unknown;
    const finishUpload = trace.begin('upload');
    try {
      try {
        for await (const part of request.parts(
          options.allowContext
            ? { limits: { fields: 1, parts: 2, fieldSize: 192 * 1024 } }
            : undefined,
        )) {
          if (
            options.allowContext &&
            part.type === 'field' &&
            part.fieldname === 'context' &&
            context === undefined &&
            !part.valueTruncated &&
            typeof part.value === 'string'
          ) {
            try {
              context = JSON.parse(part.value);
            } catch {
              throw new AppError(
                400,
                'INVALID_CONTEXT',
                'Endpoint context must be valid JSON.',
              );
            }
            continue;
          }
          if (part.type !== 'file' || part.fieldname !== 'image' || bytes) {
            throw new AppError(
              400,
              'INVALID_UPLOAD',
              'Send exactly one file in the image field and no other fields.',
            );
          }
          bytes = await part.toBuffer();
          if (part.file.truncated)
            throw new AppError(
              413,
              'UPLOAD_TOO_LARGE',
              'The image exceeds the upload limit.',
            );
        }
      } catch (error) {
        if (
          error instanceof AppError ||
          (error instanceof Error && 'statusCode' in error)
        )
          throw error;
        throw new AppError(
          400,
          'INVALID_UPLOAD',
          'The multipart upload could not be read.',
        );
      }
      if (!bytes)
        throw new AppError(
          400,
          'MISSING_IMAGE',
          'The image field is required.',
        );
      controller.signal.throwIfAborted();
      finishUpload('completed');
      const result = await analyze(bytes, controller.signal, trace, context);
      controller.signal.throwIfAborted();
      const diagnostics = trace.snapshot();
      trace.emit('vision.analysis_completed', {
        elapsedMs: diagnostics.elapsedMs,
      });
      return reply.send({ ...result, diagnostics });
    } catch (error) {
      const cause =
        error instanceof AppError
          ? error
          : controller.signal.aborted
            ? abortError(controller.signal)
            : error;
      finishUpload(
        cause instanceof AppError && cause.code === 'ANALYSIS_TIMEOUT'
          ? 'timed_out'
          : controller.signal.aborted
            ? 'cancelled'
            : 'failed',
      );
      const diagnostics = trace.snapshot();
      trace.emit('vision.analysis_failed', {
        elapsedMs: diagnostics.elapsedMs,
        code: cause instanceof AppError ? cause.code : 'INTERNAL_ERROR',
      });
      if (cause instanceof AppError)
        throw new AppError(cause.statusCode, cause.code, cause.message, {
          ...(cause.details ?? {
            source: 'backend',
            elapsedMs: diagnostics.elapsedMs,
          }),
          totalElapsedMs: diagnostics.elapsedMs,
          timings: diagnostics.timings,
        });
      throw error;
    } finally {
      clearTimeout(deadline);
      request.raw.removeListener('aborted', disconnect);
      reply.raw.removeListener('close', disconnect);
      bytes = undefined;
      capacity.active--;
    }
  });
}
