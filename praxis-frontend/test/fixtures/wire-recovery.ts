import type { RecoveryReport } from "../../lib/wire-recovery";
export function recoveryReport(snapshotId: string): RecoveryReport {
  return {
    version: "wire-coverage-v1",
    reportId: "1".repeat(64),
    sourceSnapshotId: snapshotId,
    sourceSnapshotHash: "2".repeat(64),
    imageHash: "1".repeat(64),
    image: { width: 1426, height: 1008 },
    auditScale: 1280 / 1426,
    candidates: [
      {
        id: "jumper_wire_1",
        source: "sam_full",
        bbox: [100, 200, 200, 100],
        points: [],
        mask: {
          format: "svg_path",
          width: 20,
          height: 10,
          path: "M0 0L20 0L20 2L0 2Z",
        },
        geometryAccepted: false,
        rejectionReasons: ["branched_mask"],
        metrics: {
          area: 50,
          components: 1,
          ends: 3,
          branches: 1,
          occupancy: 0.25,
          topologyScale: 1,
        },
        candidateCoverage: 0,
        verifiedCoverage: 0,
        touchesImageBoundary: false,
        identityStatus: "unverified",
        guidanceEligible: false,
      },
    ],
    summary: {
      rawSamCandidates: 1,
      geometryAccepted: 0,
      cvTraces: 0,
      uncoveredTraces: 0,
      unverifiedTraces: 0,
      truncated: false,
    },
    cropRegions: [[50, 150, 400, 400]],
    stopReason: "audit_only",
    modelReviews: [],
    hypotheses: [],
  };
}
