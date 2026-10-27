import { createVisionProxy } from "@/lib/server/vision-proxy";

// Node.js is the default; an explicit runtime conflicts with Cache Components.
// Deployment hint, longer than the maximum configurable application deadline.
export const maxDuration = 360;

export const POST = createVisionProxy();
