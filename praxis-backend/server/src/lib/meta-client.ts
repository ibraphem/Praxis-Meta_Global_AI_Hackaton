import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { Config } from '../config.js';
import { AppError, abortError, invalidProviderOutput } from './errors.js';
import type {
  AnalysisTrace,
  Stage,
  ErrorDetails,
  TimingStatus,
} from './diagnostics.js';

export interface ProviderOperation {
  stage: Stage;
  trace?: AnalysisTrace;
  /** Optional refinement uses one bounded attempt and does not consume primary retries. */
  timeoutMs?: number;
  maxRetries?: number;
}

export interface MetaClient {
  post(
    path: 'responses' | 'chat/completions',
    body: Record<string, unknown>,
    signal: AbortSignal,
    operation?: ProviderOperation,
  ): Promise<unknown>;
}

/** Shared HTTP policy: no redirects, bounded bodies/time, transient-only retries. */
export function createMetaClient(
  config: Config,
  fetcher: typeof fetch = fetch,
): MetaClient {
  return {
    async post(path, body, signal, operation) {
      const payload = JSON.stringify(body);
      const maxRetries = operation?.maxRetries ?? config.PROVIDER_MAX_RETRIES;
      const timeoutMs = Math.min(
        operation?.timeoutMs ?? config.PROVIDER_TIMEOUT_MS,
        config.PROVIDER_TIMEOUT_MS,
      );
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal.aborted) throw abortError(signal);
        const started = performance.now();
        const timeoutReason = new Error('Provider attempt deadline');
        const timeoutController = new AbortController();
        const timer = setTimeout(
          () => timeoutController.abort(timeoutReason),
          timeoutMs,
        );
        timer.unref();
        const attemptSignal = AbortSignal.any([
          signal,
          timeoutController.signal,
        ]);
        const model = typeof body.model === 'string' ? body.model : undefined;
        let phase: 'awaiting_response' | 'reading_response' =
          'awaiting_response';
        const details = (source: ErrorDetails['source']): ErrorDetails => ({
          source,
          phase,
          elapsedMs: Math.round(performance.now() - started),
          ...(source === 'backend_provider' ? { timeoutMs } : {}),
          attempt: attempt + 1,
          ...(model === undefined ? {} : { model }),
          ...(operation ? { stage: operation.stage } : {}),
        });
        const finish = operation?.trace?.begin(operation.stage, {
          kind: 'request',
          attempt: attempt + 1,
          timeoutMs,
          ...(model === undefined ? {} : { model }),
        });
        let upstreamStatus: number | undefined;
        let failure: AppError | undefined;
        try {
          const response = await fetcher(
            `${config.META_BASE_URL.replace(/\/$/, '')}/${path}`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${config.META_API_KEY}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: payload,
              signal: attemptSignal,
              redirect: 'error',
            },
          );
          if (attemptSignal.aborted) throw attemptSignal.reason;
          upstreamStatus = response.status;
          if (!response.ok) {
            // The HTTP failure is already known. Cleanup must not obscure it
            // with a later deadline or a broken error-response body.
            void response.body?.cancel().catch(() => undefined);
            const upstreamDetails = {
              ...details('meta_api'),
              upstreamStatus: response.status,
            };
            if (response.status === 504)
              throw new AppError(
                504,
                'META_API_TIMEOUT',
                'Meta returned HTTP 504 for this model request.',
                upstreamDetails,
              );
            if ([401, 403, 404].includes(response.status)) {
              throw new AppError(
                503,
                'PROVIDER_UNAVAILABLE',
                'Check the server API credentials, model IDs, and account access.',
                upstreamDetails,
              );
            }
            if (response.status === 429)
              throw new AppError(
                503,
                'PROVIDER_RATE_LIMITED',
                'The vision provider is busy. Try again later.',
                upstreamDetails,
              );
            throw new AppError(
              502,
              'PROVIDER_ERROR',
              'The vision provider could not complete the request.',
              upstreamDetails,
            );
          }
          if (
            !response.headers
              .get('content-type')
              ?.includes('application/json') ||
            !response.body
          )
            throw invalidProviderOutput();
          const reader = response.body.getReader();
          phase = 'reading_response';
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 16 * 1024 * 1024) {
                await reader.cancel();
                throw invalidProviderOutput();
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          try {
            const result: unknown = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            );
            if (attemptSignal.aborted) throw attemptSignal.reason;
            finish?.('completed', { upstreamStatus: response.status });
            return result;
          } catch {
            if (attemptSignal.aborted) throw attemptSignal.reason;
            throw invalidProviderOutput();
          }
        } catch (error) {
          // AbortSignal.any retains the first reason even if another timer fires later.
          if (attemptSignal.aborted && attemptSignal.reason === timeoutReason)
            failure = new AppError(
              504,
              'PROVIDER_TIMEOUT',
              'The backend timed out waiting for a Meta model response.',
              details('backend_provider'),
            );
          else if (attemptSignal.aborted) failure = abortError(attemptSignal);
          else if (error instanceof AppError)
            failure = error.details
              ? error
              : new AppError(
                  error.statusCode,
                  error.code,
                  error.message,
                  details('backend_provider'),
                );
          else
            failure = new AppError(
              502,
              'PROVIDER_CONNECTION_ERROR',
              'The vision provider could not be reached.',
              details('backend_provider'),
            );
          const status: Exclude<TimingStatus, 'running'> = [
            'PROVIDER_TIMEOUT',
            'META_API_TIMEOUT',
            'ANALYSIS_TIMEOUT',
          ].includes(failure.code)
            ? 'timed_out'
            : failure.statusCode === 499
              ? 'cancelled'
              : 'failed';
          finish?.(status, {
            code: failure.code,
            ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
          });
        } finally {
          clearTimeout(timer);
        }
        const retryable =
          failure.code === 'PROVIDER_TIMEOUT' ||
          failure.code === 'PROVIDER_CONNECTION_ERROR' ||
          failure.code === 'META_API_TIMEOUT' ||
          upstreamStatus === 429 ||
          (failure.code === 'PROVIDER_ERROR' && (upstreamStatus ?? 0) >= 500);
        if (!retryable || signal.aborted || attempt === maxRetries)
          throw failure;
        operation?.trace?.emit('vision.provider_retry', {
          stage: operation.stage,
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          code: failure.code,
        });
        const finishDelay = operation?.trace?.begin(operation.stage, {
          kind: 'retry_delay',
          attempt: attempt + 2,
        });
        try {
          await delay(250 * 2 ** attempt, undefined, { signal });
          finishDelay?.('completed');
        } catch {
          finishDelay?.('cancelled');
          throw abortError(signal);
        }
      }
      throw new AppError(502, 'PROVIDER_ERROR', 'The vision request failed.');
    },
  };
}
