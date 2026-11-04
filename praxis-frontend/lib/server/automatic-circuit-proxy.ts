import { readBounded, BoundedReadError } from "./bounded-body";
import { parseInspection } from "../automatic-circuit";
type Action =
  "create" | "get" | "image" | "review" | "calibrate" | "evidence" | "delete";
export function createAutomaticCircuitProxy(
  options: {
    fetcher?: typeof fetch;
    environment?: { PRAXIS_BACKEND_URL?: string; PRAXIS_API_TOKEN?: string };
  } = {},
) {
  let active = 0;
  return async (request: Request, action: Action, id?: string) => {
    const headers = { "Cache-Control": "no-store" };
    const fail = (status: number, message: string) =>
      Response.json({ error: { message } }, { status, headers });
    if (
      action !== "create" &&
      (!id ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          id,
        ))
    )
      return fail(404, "Inspection not found.");
    const url = new URL(request.url),
      origin = request.headers.get("origin");
    if (
      origin &&
      origin !== `${url.protocol}//${request.headers.get("host") ?? url.host}`
    )
      return fail(403, "Use the Praxis app for circuit inspection.");
    if (active >= 4) return fail(503, "Inspection connection is busy.");
    active++;
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 30000),
      signal = AbortSignal.any([request.signal, controller.signal]);
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
        return fail(503, "Check the private backend connection settings.");
      endpoint.pathname = `/api/circuit-inspections${id ? `/${id}` : ""}${["get", "create", "delete"].includes(action) ? "" : `/${action}`}`;
      const contentType = request.headers.get("content-type") ?? "";
      if (
        action === "create" &&
        (!/^multipart\/form-data\s*;/i.test(contentType) ||
          !contentType.includes("boundary="))
      )
        return fail(415, "Choose a circuit photograph.");
      const body = ["create", "review", "calibrate"].includes(action)
        ? await readBounded(
            request.body,
            action === "create" ? 8 * 1024 * 1024 + 65536 : 2 * 1024 * 1024,
            signal,
          )
        : undefined;
      const upstream = await (options.fetcher ?? fetch)(endpoint, {
        method: action === "delete" ? "DELETE" : body ? "POST" : "GET",
        headers: {
          ...(env.PRAXIS_API_TOKEN
            ? { Authorization: `Bearer ${env.PRAXIS_API_TOKEN}` }
            : {}),
          ...(body
            ? {
                "Content-Type":
                  action === "create" ? contentType : "application/json",
              }
            : {}),
        },
        body,
        signal,
        redirect: "error",
        cache: "no-store",
      });
      if (upstream.status === 204)
        return new Response(null, { status: 204, headers });
      const bytes = await readBounded(
        upstream.body,
        action === "image" ? 20 * 1024 * 1024 : 12 * 1024 * 1024,
        signal,
      );
      if (action === "image" && upstream.ok)
        return new Response(bytes, {
          headers: { ...headers, "Content-Type": "image/jpeg" },
        });
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (!upstream.ok)
        return fail(
          upstream.status,
          typeof data?.error?.message === "string"
            ? data.error.message.slice(0, 500)
            : "Circuit inspection failed.",
        );
      if (action === "evidence")
        return Response.json(data, {
          headers: {
            ...headers,
            "Content-Disposition":
              'attachment; filename="praxis-circuit-inspection.json"',
          },
        });
      return Response.json(parseInspection(data, id), {
        status: upstream.status,
        headers,
      });
    } catch (error) {
      return fail(
        error instanceof BoundedReadError ? 413 : 502,
        "Circuit inspection could not be loaded. Reload the saved inspection; no AI request is automatically repeated.",
      );
    } finally {
      clearTimeout(timer);
      active--;
    }
  };
}
