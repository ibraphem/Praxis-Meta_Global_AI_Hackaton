import type { Component } from "../vision";
import type { Point } from "../breadboard/calibration";
import { refineWireTip } from "./refinement";

/** Read only a local original-image patch. Nothing is uploaded or painted onto the photograph. */
export function refinePhotographEndpoint(
  photo: HTMLImageElement,
  wire: Component,
  seed: Point,
  radius: number,
) {
  if (!wire.mask || !photo.complete || photo.naturalWidth < 1)
    throw new Error(
      "The original photograph and selected mask must be available.",
    );
  const r = Math.max(16, Math.min(64, radius));
  const left = Math.max(0, Math.floor(seed.x - r)),
    top = Math.max(0, Math.floor(seed.y - r));
  const width = Math.min(
      photo.naturalWidth - left,
      Math.ceil(seed.x + r + 1) - left,
    ),
    height = Math.min(
      photo.naturalHeight - top,
      Math.ceil(seed.y + r + 1) - top,
    );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context)
    throw new Error("Local image inspection is unavailable in this browser.");
  context.drawImage(photo, left, top, width, height, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  context.clearRect(0, 0, width, height);
  context.translate(wire.bbox[0] - left, wire.bbox[1] - top);
  context.scale(
    wire.bbox[2] / wire.mask.width,
    wire.bbox[3] / wire.mask.height,
  );
  context.fillStyle = "white";
  context.fill(new Path2D(wire.mask.path), "evenodd");
  const selectedMask = context.getImageData(0, 0, width, height).data;
  return refineWireTip({
    width,
    height,
    rgba,
    selectedMask,
    origin: { x: left, y: top },
    seed,
    searchRadius: r,
  });
}
