import type { ErrorDetails } from './diagnostics.js';

/** Safe public errors. Never attach provider response bodies or uploaded data. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Preserve the FIRST abort reason: a deadline is distinct from a disconnected client. */
export function abortError(signal: AbortSignal): AppError {
  if (signal.reason instanceof AppError) return signal.reason;
  return new AppError(
    499,
    'REQUEST_CANCELLED',
    'The client cancelled the analysis.',
    { source: 'client', elapsedMs: 0 },
  );
}

export function invalidProviderOutput(): AppError {
  return new AppError(
    502,
    'INVALID_PROVIDER_OUTPUT',
    'The vision provider returned an invalid result.',
  );
}
