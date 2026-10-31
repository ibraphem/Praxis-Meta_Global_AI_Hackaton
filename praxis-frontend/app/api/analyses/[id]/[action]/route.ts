import { createAnalysisJobProxy } from "@/lib/server/analysis-job-proxy";
const proxy = createAnalysisJobProxy();
export async function GET(
  request: Request,
  context: RouteContext<"/api/analyses/[id]/[action]">,
) {
  const { id, action } = await context.params;
  if (action !== "image") return new Response(null, { status: 404 });
  return proxy(request, "image", id);
}
export async function POST(
  request: Request,
  context: RouteContext<"/api/analyses/[id]/[action]">,
) {
  const { id, action } = await context.params;
  if (
    ![
      "retry-muse",
      "retry-scene",
      "start-scene",
      "retry-sam",
      "audit-wires",
      "recover-wires",
      "recover-short-wires",
      "verify-wire",
      "retry-wire-crop",
      "verify-wire-extension",
      "wire-identities",
      "interpret-recovery",
    ].includes(action)
  )
    return new Response(null, { status: 404 });
  return proxy(
    request,
    action as
      | "retry-muse"
      | "retry-scene"
      | "start-scene"
      | "retry-sam"
      | "audit-wires"
      | "recover-wires"
      | "recover-short-wires"
      | "verify-wire"
      | "retry-wire-crop"
      | "verify-wire-extension"
      | "wire-identities"
      | "interpret-recovery",
    id,
  );
}
