import { createCircuitSessionProxy } from "@/lib/server/circuit-session-proxy";
const proxy = createCircuitSessionProxy();
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/circuit-sessions/[id]/[action]">,
) {
  const { id, action } = await params;
  return action === "evidence"
    ? proxy(request, action, id)
    : new Response(null, { status: 404 });
}
export async function POST(
  request: Request,
  { params }: RouteContext<"/api/circuit-sessions/[id]/[action]">,
) {
  const { id, action } = await params;
  return [
    "profile",
    "prepare-capture",
    "seed-capture",
    "review-capture",
    "plan-repair",
    "verify-repair",
    "prepare-endpoints",
    "run-endpoints",
  ].includes(action)
    ? proxy(request, action, id)
    : new Response(null, { status: 404 });
}
