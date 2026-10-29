import { createAnalysisJobProxy } from "@/lib/server/analysis-job-proxy";
const proxy = createAnalysisJobProxy();
export async function GET(
  request: Request,
  context: RouteContext<"/api/analyses/[id]">,
) {
  return proxy(request, "get", (await context.params).id);
}
export async function DELETE(
  request: Request,
  context: RouteContext<"/api/analyses/[id]">,
) {
  return proxy(request, "delete", (await context.params).id);
}
