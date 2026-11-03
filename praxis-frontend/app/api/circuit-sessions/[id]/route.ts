import { createCircuitSessionProxy } from "@/lib/server/circuit-session-proxy";
const proxy = createCircuitSessionProxy();
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/circuit-sessions/[id]">,
) {
  return proxy(request, "get", (await params).id);
}
