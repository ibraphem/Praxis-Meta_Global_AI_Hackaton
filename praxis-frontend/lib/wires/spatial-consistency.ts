import type { Component } from "../vision";
import type { Point } from "../breadboard/calibration";
export interface WireConsistency {
  status: "near_mask" | "review_needed" | "not_assessed";
  reasons: string[];
  distancesPx: [number | null, number | null];
  tolerancePx: number;
  basis: "mask_proximity_only";
  physicalWireIdentity: "unverified";
}
/** Soft signal only: insulation masks may stop before exposed pins or insertion points. */
export function spatialConsistency(
  wire: Component,
  positions: [Point | null, Point | null],
  tolerancePx: number,
): WireConsistency {
  const contours = (wire.mask?.path.match(/M[^M]+/g) ?? [])
    .map((contour) =>
      [
        ...contour.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g),
      ].map((match) => ({
        x: wire.bbox[0] + (Number(match[1]) * wire.bbox[2]) / wire.mask!.width,
        y: wire.bbox[1] + (Number(match[2]) * wire.bbox[3]) / wire.mask!.height,
      })),
    )
    .filter((contour) => contour.length >= 3);
  const distance = (p: Point) => {
    let inside = false,
      nearest = Infinity;
    for (const contour of contours)
      for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
        const a = contour[j],
          b = contour[i];
        if (
          a.y > p.y !== b.y > p.y &&
          p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
        )
          inside = !inside;
        const dx = b.x - a.x,
          dy = b.y - a.y,
          length = dx * dx + dy * dy;
        const t = length
          ? Math.max(
              0,
              Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length),
            )
          : 0;
        nearest = Math.min(
          nearest,
          Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy),
        );
      }
    return inside ? 0 : nearest;
  };
  const distancesPx = positions.map((p) =>
    p && contours.length ? distance(p) : null,
  ) as WireConsistency["distancesPx"];
  const reasons = distancesPx.flatMap((d, i) =>
    d !== null && d > tolerancePx
      ? [`endpoint_${i ? "B" : "A"}_far_from_visible_mask`]
      : [],
  );
  if (
    positions[0] &&
    positions[1] &&
    Math.hypot(
      positions[0].x - positions[1].x,
      positions[0].y - positions[1].y,
    ) < 1
  )
    reasons.push("coincident_endpoint_proposals");
  else if (
    positions[0] &&
    positions[1] &&
    Math.max(wire.bbox[2], wire.bbox[3]) > tolerancePx * 4 &&
    Math.hypot(
      positions[0].x - positions[1].x,
      positions[0].y - positions[1].y,
    ) <
      Math.max(wire.bbox[2], wire.bbox[3]) * 0.2
  )
    reasons.push("endpoint_pair_concentrated_on_one_region");
  return {
    status: reasons.length
      ? "review_needed"
      : contours.length
        ? "near_mask"
        : "not_assessed",
    reasons,
    distancesPx,
    tolerancePx,
    basis: "mask_proximity_only",
    physicalWireIdentity: "unverified",
  };
}
