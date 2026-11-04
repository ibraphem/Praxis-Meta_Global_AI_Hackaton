import type * as OpenCV from "@techstark/opencv-js";
import { fitHoleLattice, type PixelPoint, type LatticeFit } from "./lattice";
import { fitPowerRails } from "./rails";
export type CV = typeof OpenCV;
export interface GeometryResult {
  version: "opencv-lattice-v1";
  image: { width: number; height: number };
  processing: { width: number; height: number };
  status: "measured" | "unresolved";
  reason: string;
  holeCount: number;
  fit: LatticeFit | null;
}
export function extractHoleCentres(
  cv: CV,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const src = new cv.Mat(height, width, cv.CV_8UC4),
    gray = new cv.Mat(),
    binary = new cv.Mat(),
    hierarchy = new cv.Mat(),
    contours = new cv.MatVector();
  src.data.set(rgba);
  const points: PixelPoint[] = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.adaptiveThreshold(
      gray,
      binary,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      31,
      8,
    );
    cv.findContours(
      binary,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      try {
        const box = cv.boundingRect(contour),
          area = cv.contourArea(contour),
          ratio = box.width / box.height;
        if (
          box.width < 3 ||
          box.height < 3 ||
          box.width > Math.min(width, height) * 0.035 ||
          box.height > Math.min(width, height) * 0.035 ||
          area < 9 ||
          ratio < 0.55 ||
          ratio > 1.65 ||
          area / (box.width * box.height) < 0.45
        )
          continue;
        const moments = cv.moments(contour, false);
        if (!moments.m00) continue;
        const point = {
          x: moments.m10 / moments.m00,
          y: moments.m01 / moments.m00,
        };
        if (!points.some((p) => Math.hypot(p.x - point.x, p.y - point.y) < 3))
          points.push(point);
      } finally {
        contour.delete();
      }
    }
    return points;
  } finally {
    src.delete();
    gray.delete();
    binary.delete();
    hierarchy.delete();
    contours.delete();
  }
}
export function detectGeometry(
  cv: CV,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  original = { width, height },
): GeometryResult {
  const points = extractHoleCentres(cv, rgba, width, height);
  const base = {
    version: "opencv-lattice-v1" as const,
    image: original,
    processing: { width, height },
    holeCount: points.length,
  };
  try {
    const fit = fitHoleLattice(points, width, height),
      sx = original.width / width,
      sy = original.height / height;
    fit.rails = fitPowerRails(points, fit, { width, height });
    return {
      ...base,
      status: "measured",
      reason:
        "Grid fitted to observed hole centres. Printed numbering and terminal contact still need validation.",
      fit: {
        ...fit,
        pitch: fit.pitch * Math.sqrt(sx * sy),
        anchors: fit.anchors.map((p) => ({
          x: p.x * sx,
          y: p.y * sy,
        })) as LatticeFit["anchors"],
        holes: fit.holes.map((p) => ({ ...p, x: p.x * sx, y: p.y * sy })),
        rails: fit.rails.map((r) => ({
          ...r,
          first: { x: r.first.x * sx, y: r.first.y * sy },
          last: { x: r.last.x * sx, y: r.last.y * sy },
        })),
      },
    };
  } catch (error) {
    return {
      ...base,
      status: "unresolved",
      reason: error instanceof Error ? error.message : "Grid detection failed.",
      fit: null,
    };
  }
}
