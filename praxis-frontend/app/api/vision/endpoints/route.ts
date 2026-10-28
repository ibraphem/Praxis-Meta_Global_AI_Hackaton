import { createVisionProxy } from "@/lib/server/vision-proxy";

export const maxDuration = 360;
export const POST = createVisionProxy({ operation: "endpoints" });
