import { createAutomaticCircuitProxy } from "@/lib/server/automatic-circuit-proxy";
const proxy = createAutomaticCircuitProxy();
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/circuit-inspections/[id]/[action]">,
) {
  const { id, action } = await params;
  return action === "image" || action === "evidence"
    ? proxy(request, action, id)
    : new Response(null, { status: 404 });
}
export async function POST(
  request: Request,
  { params }: RouteContext<"/api/circuit-inspections/[id]/[action]">,
) {
  const { id, action } = await params;
  return action === "review" ||
    action === "calibrate" ||
    action === "localize" ||
    action === "diagnose"
    ? proxy(request, action, id)
    : new Response(null, { status: 404 });
}
