import { createVisionProxy } from "@/lib/server/vision-proxy";

// Node.js is the default; an explicit runtime conflicts with Cache Components.
// Vercel Hobby supports a maximum function duration of 300 seconds.
export const maxDuration = 300;

export const POST = createVisionProxy();
