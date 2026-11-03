import { readBounded } from "./bounded-body";
import { parseCircuitSession } from "../circuit-session";
const actions = new Set([
  "get",
  "create",
  "profile",
  "prepare-capture",
  "seed-capture",
  "review-capture",
  "plan-repair",
  "verify-repair",
  "prepare-endpoints",
  "run-endpoints",
  "evidence",
]);
export function createCircuitSessionProxy(
  options: {
    fetcher?: typeof fetch;
    environment?: { PRAXIS_BACKEND_URL?: string; PRAXIS_API_TOKEN?: string };
  } = {},
) {
  let active = 0;
  return async (request: Request, action: string, id?: string) => {
    const headers = { "Cache-Control": "no-store" },
      fail = (status: number, message: string) =>
        Response.json({ error: { message } }, { status, headers });
    if (
      !actions.has(action) ||
      (action !== "create" &&
        (!id ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            id,
          )))
    )
      return fail(404, "Session operation unavailable.");
    const url = new URL(request.url),
      origin = request.headers.get("origin");
    if (
      origin &&
      origin !== `${url.protocol}//${request.headers.get("host") ?? url.host}`
    )
      return fail(403, "Use the Praxis app for this session.");
    if (active >= 4) return fail(503, "Session connection busy.");
    active++;
    const timer = new AbortController(),
      timeout = setTimeout(() => timer.abort(), 30000),
      signal = AbortSignal.any([request.signal, timer.signal]);
    try {
      const env = options.environment ?? process.env,
        endpoint = new URL(env.PRAXIS_BACKEND_URL || "http://127.0.0.1:3000");
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        (endpoint.protocol === "http:" &&
          !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
      )
        return fail(503, "Check private backend settings.");
      endpoint.pathname = `/api/circuit-sessions${id ? `/${id}` : ""}${!["get", "create"].includes(action) ? `/${action}` : ""}`;
      const body = ["get", "evidence", "create"].includes(action)
          ? undefined
          : await readBounded(request.body, 2 * 1024 * 1024, signal),
        upstream = await (options.fetcher ?? fetch)(endpoint, {
          method: ["get", "evidence"].includes(action) ? "GET" : "POST",
          headers: {
            ...(env.PRAXIS_API_TOKEN
              ? { Authorization: `Bearer ${env.PRAXIS_API_TOKEN}` }
              : {}),
            "Content-Type": "application/json",
          },
          body,
          signal,
          redirect: "error",
          cache: "no-store",
        });
      const bytes = await readBounded(
          upstream.body,
          action === "evidence" ? 96 * 1024 * 1024 : 12 * 1024 * 1024,
          signal,
        ),
        data = JSON.parse(new TextDecoder().decode(bytes));
      if (!upstream.ok) {
        const message =
          typeof data?.error?.message === "string"
            ? data.error.message.slice(0, 300)
            : "Session action failed.";
        return fail(
          upstream.status >= 400 && upstream.status < 500
            ? upstream.status
            : 502,
          message,
        );
      }
      if (action === "evidence") {
        parseCircuitSession(
          Object.fromEntries(
            Object.entries(data).filter(
              ([key]) =>
                ![
                  "exportedAt",
                  "captureReviews",
                  "analyses",
                  "profileHistory",
                ].includes(key),
            ),
          ),
          id,
        );
        return Response.json(data, {
          headers: {
            ...headers,
            "Content-Disposition":
              'attachment; filename="praxis-circuit-session-evidence.json"',
          },
        });
      }
      return Response.json(parseCircuitSession(data, id), {
        status: upstream.status,
        headers,
      });
    } catch {
      return fail(
        502,
        "Circuit session could not be loaded. Refresh the saved session; no model request is automatically retried.",
      );
    } finally {
      clearTimeout(timeout);
      active--;
    }
  };
}
