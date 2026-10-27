import { randomUUID } from "node:crypto";
import { analysisSchema, MAX_FILE_BYTES } from "../vision";
import { upstreamTimeoutSchema, type ErrorDetails } from "../diagnostics";

const MAX_BODY_BYTES = MAX_FILE_BYTES + 64 * 1024;
const TIMEOUT_MS = 190_000;
const RESPONSE_BYTES = 256 * 1024;

class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
  }
}

/** Bound chunked uploads too; Content-Length alone cannot enforce a limit. */
async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ProxyError(
          413,
          "BODY_TOO_LARGE",
          "The photograph is too large. Use a file under 8 MB.",
        );
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function backendError(status: number): ProxyError {
  switch (status) {
    case 400:
      return new ProxyError(
        400,
        "INVALID_UPLOAD",
        "Choose one photograph and try again.",
      );
    case 413:
      return new ProxyError(
        413,
        "IMAGE_TOO_LARGE",
        "Use a photograph under 8 MB and 16 megapixels.",
      );
    case 415:
    case 422:
      return new ProxyError(
        status,
        "INVALID_IMAGE",
        "This photograph could not be read. Try a JPEG, PNG, or WebP image.",
      );
    case 401:
    case 403:
      return new ProxyError(
        502,
        "BACKEND_AUTH",
        "Praxis could not authorize this analysis. Check the server connection settings.",
      );
    case 429:
      return new ProxyError(
        429,
        "RATE_LIMITED",
        "Too many analyses. Wait a minute and try again.",
      );
    case 503:
      return new ProxyError(
        503,
        "BACKEND_UNAVAILABLE",
        "Analysis is unavailable. The backend may be busy or need model access. Try again shortly.",
      );
    case 504:
      return new ProxyError(
        504,
        "BACKEND_TIMEOUT",
        "The backend returned a timeout without diagnostic details. Check its logs using the request ID.",
      );
    default:
      return new ProxyError(
        502,
        "ANALYSIS_FAILED",
        "Praxis could not complete the analysis. Check the backend and try again.",
      );
  }
}

/**
 * Browser -> same-origin Next route -> private Praxis backend.
 * Construct a handler for isolation in tests. Never forward cookies, Origin,
 * client authorization, arbitrary URLs, or raw upstream error bodies.
 */
export function createVisionProxy(
  options: {
    fetcher?: typeof fetch;
    environment?: {
      PRAXIS_BACKEND_URL?: string;
      PRAXIS_API_TOKEN?: string;
      PRAXIS_PROXY_TIMEOUT_MS?: string;
    };
    logger?: (event: Record<string, unknown>) => void;
  } = {},
) {
  const fetcher = options.fetcher ?? fetch;
  const logger =
    options.logger ??
    ((event: Record<string, unknown>) => {
      if (process.env.NODE_ENV !== "test") console.info(JSON.stringify(event));
    });
  let active = 0;
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    let stage: "proxy.upload" | "backend.wait" | "proxy.response" =
      "proxy.upload";
    const headers = { "Cache-Control": "no-store", "X-Request-Id": requestId };
    const errorResponse = (error: ProxyError) => {
      const details = error.details ?? {
        source: "frontend_proxy" as const,
        stage,
        elapsedMs: elapsed(),
      };
      logger({
        event: "vision.proxy_failed",
        requestId,
        code: error.code,
        status: error.status,
        elapsedMs: elapsed(),
        details,
      });
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
            requestId,
            details,
          },
        },
        { status: error.status, headers },
      );
    };
    if (active >= 2)
      return errorResponse(
        new ProxyError(
          503,
          "SERVER_BUSY",
          "Two photographs are already being analyzed. Try again shortly.",
        ),
      );
    active++;
    const controller = new AbortController();
    const timeoutReason = new Error("Frontend proxy deadline");
    const environment = options.environment ?? process.env;
    const timeoutMs =
      environment.PRAXIS_PROXY_TIMEOUT_MS === undefined
        ? TIMEOUT_MS
        : Number(environment.PRAXIS_PROXY_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 330_000) {
      active--;
      return errorResponse(
        new ProxyError(
          503,
          "INVALID_PROXY_CONFIG",
          "The frontend proxy timeout must be between 1 and 330000 milliseconds.",
        ),
      );
    }
    const timer = setTimeout(() => controller.abort(timeoutReason), timeoutMs);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    try {
      const origin = request.headers.get("origin");
      // Next may reconstruct a localhost URL even when opened at 127.0.0.1.
      // Browsers set Host themselves; compare against the actual request host.
      const requestUrl = new URL(request.url);
      const host = request.headers.get("host") ?? requestUrl.host;
      if (origin && origin !== `${requestUrl.protocol}//${host}`)
        throw new ProxyError(
          403,
          "ORIGIN_DENIED",
          "Submit photographs from the Praxis app.",
        );
      const contentType = request.headers.get("content-type") ?? "";
      if (
        !/^multipart\/form-data\s*;/i.test(contentType) ||
        !/boundary=/i.test(contentType)
      )
        throw new ProxyError(
          415,
          "EXPECTED_MULTIPART",
          "Choose a photograph to analyze.",
        );
      const length = request.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))
        throw new ProxyError(
          413,
          "BODY_TOO_LARGE",
          "The photograph is too large. Use a file under 8 MB.",
        );

      const endpoint = new URL(
        environment.PRAXIS_BACKEND_URL || "http://127.0.0.1:3000",
      );
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        (endpoint.protocol === "http:" &&
          !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
      ) {
        throw new ProxyError(
          503,
          "INVALID_BACKEND_CONFIG",
          "Praxis needs a valid backend connection before analysis.",
        );
      }
      // This URL is fixed by trusted server configuration, never by the request.
      const url = `${endpoint.href.replace(/\/$/, "")}/api/vision/analyze`;
      const upstreamHeaders = new Headers({
        "Content-Type": contentType,
        Accept: "application/json",
        "X-Request-Id": requestId,
      });
      if (environment.PRAXIS_API_TOKEN)
        upstreamHeaders.set(
          "Authorization",
          `Bearer ${environment.PRAXIS_API_TOKEN}`,
        );
      const body = await readBounded(request.body, MAX_BODY_BYTES, signal);
      stage = "backend.wait";
      logger({
        event: "vision.proxy_backend_started",
        requestId,
        elapsedMs: elapsed(),
        timeoutMs,
      });
      const upstream = await fetcher(url, {
        method: "POST",
        headers: upstreamHeaders,
        body,
        signal,
        redirect: "error",
        cache: "no-store",
      });
      if (!upstream.ok) {
        stage = "proxy.response";
        if (upstream.status === 504 || upstream.status === 499) {
          let decoded: unknown;
          try {
            decoded = JSON.parse(
              new TextDecoder().decode(
                await readBounded(upstream.body, RESPONSE_BYTES, signal),
              ),
            );
          } catch {
            if (signal.aborted) throw signal.reason;
          }
          const parsed = upstreamTimeoutSchema.safeParse(decoded);
          if (parsed.success) {
            const messages = {
              PROVIDER_TIMEOUT:
                "The backend reached its deadline waiting for a Meta model response.",
              META_API_TIMEOUT: "Meta returned HTTP 504 for a model request.",
              ANALYSIS_TIMEOUT:
                "The backend reached its overall analysis deadline.",
              REQUEST_CANCELLED: "The request to the backend was cancelled.",
            };
            throw new ProxyError(
              upstream.status,
              parsed.data.error.code,
              messages[parsed.data.error.code],
              parsed.data.error.details,
            );
          }
        } else await upstream.body?.cancel();
        const error = backendError(upstream.status);
        throw new ProxyError(error.status, error.code, error.message, {
          source: "backend",
          stage: "backend.wait",
          elapsedMs: elapsed(),
          upstreamStatus: upstream.status,
        });
      }
      stage = "proxy.response";
      let raw: unknown;
      try {
        const responseBytes = await readBounded(
          upstream.body,
          RESPONSE_BYTES,
          signal,
        );
        raw = JSON.parse(new TextDecoder().decode(responseBytes));
      } catch {
        signal.throwIfAborted();
        throw new ProxyError(
          502,
          "INVALID_BACKEND_RESPONSE",
          "The backend returned an unreadable result. Try the analysis again.",
        );
      }
      const parsed = analysisSchema.safeParse(raw);
      if (!parsed.success)
        throw new ProxyError(
          502,
          "INVALID_BACKEND_RESPONSE",
          "The backend returned an unexpected result. Try the analysis again.",
        );
      logger({
        event: "vision.proxy_completed",
        requestId,
        elapsedMs: elapsed(),
      });
      return Response.json(parsed.data, { headers });
    } catch (error) {
      if (signal.aborted)
        return errorResponse(
          new ProxyError(
            signal.reason === timeoutReason ? 504 : 499,
            signal.reason === timeoutReason
              ? "PROXY_TIMEOUT"
              : "REQUEST_CANCELLED",
            signal.reason === timeoutReason
              ? "The frontend server reached its deadline waiting for analysis."
              : "The client cancelled the request.",
            {
              source:
                signal.reason === timeoutReason ? "frontend_proxy" : "client",
              stage,
              elapsedMs: elapsed(),
              ...(signal.reason === timeoutReason ? { timeoutMs } : {}),
            },
          ),
        );
      if (error instanceof ProxyError) return errorResponse(error);
      return errorResponse(
        new ProxyError(
          502,
          "BACKEND_UNREACHABLE",
          "Could not reach Praxis. Make sure the backend is running and try again.",
        ),
      );
    } finally {
      clearTimeout(timer);
      active--;
    }
  };
}
