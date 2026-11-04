import { createAutomaticCircuitProxy } from "@/lib/server/automatic-circuit-proxy";
const proxy = createAutomaticCircuitProxy();
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/circuit-inspections/[id]">,
) {
  return proxy(request, "get", (await params).id);
}
export async function DELETE(
  request: Request,
  { params }: RouteContext<"/api/circuit-inspections/[id]">,
) {
  return proxy(request, "delete", (await params).id);
}
