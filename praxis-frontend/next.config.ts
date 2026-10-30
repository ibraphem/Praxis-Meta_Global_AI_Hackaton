import { frontendBuildId } from "./build-fingerprint";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_PRAXIS_BUILD_ID: frontendBuildId(process.cwd()) },
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
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
