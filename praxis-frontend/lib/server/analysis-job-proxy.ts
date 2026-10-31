import { randomUUID } from "node:crypto";
import { analysisJobSchema } from "../analysis-jobs";
import { IMAGE_TYPES, MAX_FILE_BYTES } from "../vision";
import { readBounded, BoundedReadError } from "./bounded-body";

type Action =
  | "create"
  | "get"
  | "image"
  | "retry-sam"
  | "retry-muse"
  | "retry-scene"
  | "start-scene"
  | "reconcile-scene"
  | "discover-terminals"
  | "delete"
  | "audit-wires"
  | "recover-wires"
  | "recover-short-wires"
  | "verify-wire"
  | "retry-wire-crop"
  | "verify-wire-extension"
  | "wire-identities"
  | "interpret-recovery";
/** Only fixed job operations and validated IDs cross this private backend boundary. */
export function createAnalysisJobProxy(
  options: {
    fetcher?: typeof fetch;
    environment?: { PRAXIS_BACKEND_URL?: string; PRAXIS_API_TOKEN?: string };
    logger?: (event: Record<string, unknown>) => void;
  } = {},
) {
  const fetcher = options.fetcher ?? fetch;
  const logger =
    options.logger ??
    ((event: Record<string, unknown>) => {
      if (process.env.NODE_ENV !== "test") console.error(JSON.stringify(event));
    });
  let active = 0;
  return async (
    request: Request,
    action: Action,
    id?: string,
  ): Promise<Response> => {
    const requestId = randomUUID(),
      headers = { "Cache-Control": "no-store", "X-Request-Id": requestId };
    const fail = (status: number, code: string, message: string) =>
      Response.json(
        { error: { code, message, requestId } },
        { status, headers },
      );
    if (active >= 8)
      return fail(
        503,
        "SERVER_BUSY",
        "The analysis connection is busy. Try again shortly.",
      );
    if (
      action !== "create" &&
      (!id ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          id,
        ))
    )
      return fail(
        404,
        "ANALYSIS_NOT_FOUND",
        "The saved analysis was not found.",
      );
    const url = new URL(request.url),
      origin = request.headers.get("origin"),
      host = request.headers.get("host") ?? url.host;
    if (origin && origin !== `${url.protocol}//${host}`)
      return fail(
        403,
        "ORIGIN_DENIED",
        "Use the Praxis app to access this analysis.",
      );
    active++;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 30_000);
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    let phase:
      "configuration" | "upload" | "backend.connect" | "backend.response" =
      "configuration";
    const started = performance.now();
    try {
      const env = options.environment ?? process.env;
      const endpoint = new URL(
        env.PRAXIS_BACKEND_URL || "http://127.0.0.1:3000",
      );
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        (endpoint.protocol === "http:" &&
          !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
      )
        return fail(
          503,
          "INVALID_PROXY_CONFIG",
          "Check the private backend connection settings.",
        );
      endpoint.pathname = `/api/analyses${id ? `/${id}` : ""}${!["create", "get", "delete"].includes(action) ? `/${action}` : ""}`;
      const upstreamHeaders: Record<string, string> = {
        "X-Request-Id": requestId,
      };
      if (env.PRAXIS_API_TOKEN)
        upstreamHeaders.Authorization = `Bearer ${env.PRAXIS_API_TOKEN}`;
      let body: Uint8Array<ArrayBuffer> | undefined;
      if (action === "create") {
        phase = "upload";
        const contentType = request.headers.get("content-type") ?? "";
        if (
          !/^multipart\/form-data\s*;/i.test(contentType) ||
          !/boundary=/i.test(contentType)
        )
          return fail(
            415,
            "EXPECTED_MULTIPART",
            "Choose a photograph to analyze.",
          );
        const length = request.headers.get("content-length");
        if (
          length &&
          (!/^\d+$/.test(length) || Number(length) > MAX_FILE_BYTES + 64 * 1024)
        )
          return fail(
            413,
            "UPLOAD_TOO_LARGE",
            "Choose a photograph under 8 MB.",
          );
        body = await readBounded(
          request.body,
          MAX_FILE_BYTES + 64 * 1024,
          signal,
        );
        upstreamHeaders["Content-Type"] = contentType;
      }
      phase = "backend.connect";
      if (
        action === "verify-wire" ||
        action === "reconcile-scene" ||
        action === "discover-terminals" ||
        action === "retry-wire-crop" ||
        action === "verify-wire-extension" ||
        action === "wire-identities" ||
        action === "recover-short-wires"
      ) {
        phase = "upload";
        body = await readBounded(
          request.body,
          action === "recover-short-wires" ? 65536 : 8192,
          signal,
        );
        upstreamHeaders["Content-Type"] = "application/json";
        phase = "backend.connect";
      }
      const upstream = await fetcher(endpoint, {
        method: !["get", "image", "delete"].includes(action)
          ? "POST"
          : action === "delete"
            ? "DELETE"
            : "GET",
        headers: upstreamHeaders,
        ...(body ? { body } : {}),
        signal,
        redirect: "error",
        cache: "no-store",
      });
      phase = "backend.response";
      if (!upstream.ok) {
        await upstream.body?.cancel();
        const errors: Record<number, [string, string]> = {
          400: ["INVALID_UPLOAD", "Send one photograph in the image field."],
          404: [
            "ANALYSIS_NOT_FOUND",
            "The saved analysis was not found or has expired.",
          ],
          409: [
            "RETRY_CONFLICT",
            "An attempt or controlled experiment is active, this stage cannot be retried, or the attempt limit was reached. Refresh the saved status.",
          ],
          413: [
            "UPLOAD_TOO_LARGE",
            "Use a photograph under 8 MB and 16 megapixels.",
          ],
          415: ["INVALID_IMAGE", "Choose a JPEG, PNG, or WebP photograph."],
          422: ["INVALID_IMAGE", "The photograph could not be decoded."],
          429: [
            "RATE_LIMITED",
            "Too many requests. Wait a minute and try again.",
          ],
          503: [
            "BACKEND_UNAVAILABLE",
            "The backend is busy or saved analysis capacity is full. Try again shortly.",
          ],
        };
        if (action === "retry-wire-crop") {
          errors[400] = [
            "INVALID_CROP_RETRY",
            "Choose the original crop attempt, a retry reason and the required authorization.",
          ];
          errors[409] = [
            "CROP_RETRY_CONFLICT",
            "Crop retry is blocked by active work, an unknown upstream outcome, an earlier retry, or the remaining budget. Refresh the saved status.",
          ];
        }
        if (action === "reconcile-scene" || action === "discover-terminals") {
          errors[400] = [
            "INVALID_SCENE_TARGETS",
            "Choose current inventory objects and their scene checkpoint before requesting terminal evidence.",
          ];
          errors[409] = [
            "SCENE_CONFLICT",
            "Scene evidence changed, work is active, a selected object was already attempted, or the terminal budget is exhausted. Refresh the inventory.",
          ];
        }
        if (action === "verify-wire-extension") {
          errors[400] = [
            "INVALID_EXTENSION",
            "Select an extension proposal from the current recovery report.",
          ];
          errors[409] = [
            "EXTENSION_CONFLICT",
            "The extension evidence changed, remains truncated, another attempt is active, or the verification budget is exhausted. Refresh the saved status.",
          ];
        }
        const [code, message] = errors[upstream.status] ?? [
          "ANALYSIS_UNAVAILABLE",
          "The saved analysis is unavailable. Check the backend connection.",
        ];
        return fail(
          [400, 404, 409, 413, 415, 422, 429, 503].includes(upstream.status)
            ? upstream.status
            : 502,
          code!,
          message!,
        );
      }
      if (action === "delete") {
        await upstream.body?.cancel();
        return new Response(null, { status: 204, headers });
      }
      if (action === "image") {
        const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
        if (!IMAGE_TYPES.includes(type)) {
          await upstream.body?.cancel();
          return fail(
            502,
            "INVALID_BACKEND_RESPONSE",
            "The saved photograph could not be read.",
          );
        }
        const bytes = await readBounded(upstream.body, MAX_FILE_BYTES, signal);
        return new Response(bytes, {
          headers: {
            ...headers,
            "Content-Type": type,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      const bytes = await readBounded(upstream.body, 2 * 1024 * 1024, signal);
      const parsed = analysisJobSchema.safeParse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      if (!parsed.success) {
        logger({
          event: "analysis.proxy_invalid_response",
          requestId,
          action,
          upstreamStatus: upstream.status,
          issues: parsed.error.issues.slice(0, 20).map((issue) => ({
            code: issue.code,
            path: issue.path.filter(
              (part) =>
                typeof part === "number" ||
                (typeof part === "string" &&
                  /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(part)),
            ),
          })),
        });
        return fail(
          502,
          "INVALID_BACKEND_RESPONSE",
          "The saved analysis returned an unexpected result.",
        );
      }
      return Response.json(parsed.data, {
        status: ![
          "get",
          "image",
          "wire-identities",
          "reconcile-scene",
        ].includes(action)
          ? 202
          : 200,
        headers,
      });
    } catch (e) {
      const codes: string[] = [];
      const inspect = (value: unknown, depth = 0) => {
        if (!value || typeof value !== "object" || depth > 4) return;
        const error = value as {
          code?: unknown;
          cause?: unknown;
          errors?: unknown[];
        };
        if (
          typeof error.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        )
          codes.push(error.code);
        inspect(error.cause, depth + 1);
        if (Array.isArray(error.errors))
          error.errors
            .slice(0, 4)
            .forEach((cause) => inspect(cause, depth + 1));
      };
      inspect(e);
      logger({
        event: "analysis.proxy_failed",
        requestId,
        action,
        phase,
        errorType:
          e instanceof TypeError
            ? "TypeError"
            : e instanceof SyntaxError
              ? "SyntaxError"
              : "Error",
        transportCodes: [...new Set(codes)].slice(0, 8),
        elapsedMs: Math.round(performance.now() - started),
      });
      if (signal.aborted)
        return fail(
          deadline.signal.aborted && signal.reason === deadline.signal.reason
            ? 504
            : 499,
          deadline.signal.aborted && signal.reason === deadline.signal.reason
            ? "JOB_REQUEST_TIMEOUT"
            : "REQUEST_CANCELLED",
          deadline.signal.aborted && signal.reason === deadline.signal.reason
            ? "The saved-analysis request exceeded its deadline. Reconnect to check the job's status."
            : "The browser stopped this request. Any saved server job continues independently.",
        );
      if (phase === "configuration")
        return fail(
          503,
          "INVALID_PROXY_CONFIG",
          "Check the private backend connection settings.",
        );
      if (phase === "upload")
        return e instanceof BoundedReadError
          ? fail(413, "UPLOAD_TOO_LARGE", "Use a photograph under 8 MB.")
          : fail(
              500,
              "UPLOAD_READ_FAILED",
              "Praxis could not read the photograph upload. Reload the page and try again.",
            );
      if (phase === "backend.response")
        return fail(
          502,
          "INVALID_BACKEND_RESPONSE",
          "The backend replied, but its saved-analysis response could not be read. Reconnect to check the job's status.",
        );
      return fail(
        502,
        "BACKEND_UNREACHABLE",
        "The connection to the Praxis backend failed. Check that the backend is running and reconnect to any saved analysis.",
      );
    } finally {
      clearTimeout(timer);
      active--;
    }
  };
}
