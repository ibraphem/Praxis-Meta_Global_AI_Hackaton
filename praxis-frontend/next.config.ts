import { resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { frontendBuildId } from "./build-fingerprint";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Binding to 0.0.0.0 does not allow the actual LAN/loopback origins in Next.
  // Its dev WebSocket must connect before the page becomes interactive.
  allowedDevOrigins: [
    ...new Set([
      "127.0.0.1",
      ...Object.values(networkInterfaces()).flatMap(
        (entries) =>
          entries
            ?.filter((entry) => entry.family === "IPv4")
            .map((entry) => entry.address) ?? [],
      ),
    ]),
  ],
  async redirects() {
    return [
      {
        source: "/",
        has: [{ type: "query" as const, key: "analysis" }],
        destination: "/workspace",
        permanent: false,
      },
    ];
  },
  outputFileTracingRoot: resolve(process.cwd(), ".."),
  env: { NEXT_PUBLIC_PRAXIS_BUILD_ID: frontendBuildId(process.cwd()) },
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    root: resolve(process.cwd(), ".."),
    rules: {
      // Tailwind owns the global entry. CSS modules must retain Next's native
      // module transform rather than being rewritten as ordinary CSS.
      "globals.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
