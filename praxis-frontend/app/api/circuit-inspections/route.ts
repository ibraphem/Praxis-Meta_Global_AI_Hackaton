import { createAutomaticCircuitProxy } from "@/lib/server/automatic-circuit-proxy";
const proxy = createAutomaticCircuitProxy();
export const POST = (request: Request) => proxy(request, "create");
