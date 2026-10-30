export const FRONTEND_RUNTIME = {
  buildId: process.env.NEXT_PUBLIC_PRAXIS_BUILD_ID ?? null,
  mode: process.env.NODE_ENV,
  fingerprintBasis: "source-at-build-or-dev-session-start",
  algorithms: {
    candidateLayer: "sam-candidate-layer-v1",
    wireSelection: "preserve-wire-evidence-v1",
    interpretation: "incremental-experiments-v2",
  },
};
