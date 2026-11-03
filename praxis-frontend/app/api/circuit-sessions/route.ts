import { createCircuitSessionProxy } from "@/lib/server/circuit-session-proxy";
const proxy = createCircuitSessionProxy();
export const POST = (request: Request) => proxy(request, "create");
