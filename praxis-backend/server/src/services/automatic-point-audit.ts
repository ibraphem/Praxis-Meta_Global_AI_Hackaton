import type { SceneGraph } from '../schemas/scene.js';
/** Audit the frozen v1 evidence filter; never consumes A results or reference pixels. */
export function auditAutomaticPoint(
  graph: SceneGraph,
  objectId: string,
  nativeObservationIds: string[],
  predictionObservationIds: string[],
) {
  const rejections = graph.observations
    .filter((o) => o.source === 'sam')
    .map((o) => {
      const reasons: string[] = [];
      if (predictionObservationIds.includes(o.id))
        reasons.push('experiment_prediction_excluded');
      if (!o.samSnapshotId) reasons.push('not_original_broad_sam');
      if (
        !graph.associations.some(
          (a) =>
            a.objectId === objectId &&
            a.observationId === o.id &&
            a.basis === 'category_and_overlap',
        )
      )
        reasons.push('no_target_baseline_association');
      if (!nativeObservationIds.includes(o.id))
        reasons.push('native_mask_unavailable');
      if (
        graph.maskIdentityReviews?.some(
          (r) =>
            r.objectId === objectId &&
            r.observationId === o.id &&
            r.decision === 'rejected',
        )
      )
        reasons.push('mask_identity_rejected');
      return { observationId: o.id, reasons };
    });
  return {
    auditVersion: 'automatic-point-audit-v1',
    targetingAlgorithmVersion: 'automatic-targeting-v1',
    objectId,
    eligibleEvidenceCount: rejections.filter((r) => !r.reasons.length).length,
    rejections,
    predictionObservationIdsExcluded: predictionObservationIds,
    independentBaselinePreserved: true,
    note: 'No reference annotations or Strategy A pixels were used to propose points. Eligibility is necessary, not sufficient: foreground depth and neighboring-object exclusions can still cause abstention. No targeting algorithm or original plan was changed.',
  };
}
