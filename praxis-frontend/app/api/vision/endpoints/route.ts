import { createVisionProxy } from "@/lib/server/vision-proxy";

export const maxDuration = 300;
export const POST = createVisionProxy({ operation: "endpoints" });
