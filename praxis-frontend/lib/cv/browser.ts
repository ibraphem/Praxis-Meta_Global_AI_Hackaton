import type { GeometryResult } from "./geometry";
import type { CircuitInspection } from "../automatic-circuit";
import type { RasterMask } from "./endpoints";
import type { LocalEndpoint } from "../../../praxis-backend/server/src/shared/hybrid-geometry";
async function runVision<T>(
  file: Blob,
  inspection?: CircuitInspection,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)),
      width = Math.round(bitmap.width * scale),
      height = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw Error("Image processing is unavailable.");
    context.drawImage(bitmap, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const masks: RasterMask[] = [];
    for (const source of inspection?.hybrid?.wireMasks ?? []) {
      if (!source.componentId) continue;
      const [x, y, w, h] = source.bbox,
        sx = width / bitmap.width,
        sy = height / bitmap.height;
      const mw = Math.ceil(w * sx) + 4,
        mh = Math.ceil(h * sy) + 4;
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = mw;
      maskCanvas.height = mh;
      const ctx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
      ctx.translate(2, 2);
      ctx.scale((w * sx) / source.mask.width, (h * sy) / source.mask.height);
      ctx.fillStyle = "white";
      ctx.fill(new Path2D(source.mask.path), "evenodd");
      const pixels = ctx.getImageData(0, 0, mw, mh).data,
        data = new Uint8Array(mw * mh);
      for (let i = 0; i < data.length; i++)
        data[i] = pixels[i * 4 + 3] > 127 ? 1 : 0;
      masks.push({
        componentId: source.componentId,
        data,
        width: mw,
        height: mh,
        left: Math.floor(x * sx) - 2,
        top: Math.floor(y * sy) - 2,
      });
    }
    const worker = new Worker(
      `/cv/geometry-worker.js?build=${process.env.NEXT_PUBLIC_PRAXIS_BUILD_ID ?? "dev"}`,
    );
    return await new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        worker.terminate();
      };
      const cancel = () => {
        finish();
        reject(Error("Local image inspection was cancelled."));
      };
      const timer = setTimeout(() => {
        finish();
        reject(Error("Local grid detection timed out."));
      }, 30000);
      signal?.addEventListener("abort", cancel, { once: true });
      worker.onerror = () => {
        finish();
        reject(
          Error("Computer vision could not load. Reload the app to try again."),
        );
      };
      worker.onmessage = (
        event: MessageEvent<{ result: T; error?: string }>,
      ) => {
        finish();
        if (event.data.error) reject(Error(event.data.error));
        else resolve(event.data.result);
      };
      worker.postMessage(
        {
          id: 1,
          rgba: rgba.buffer,
          width,
          height,
          original: { width: bitmap.width, height: bitmap.height },
          ...(inspection?.input ? { input: inspection.input, masks } : {}),
        },
        [rgba.buffer, ...masks.map((m) => m.data.buffer)],
      );
    });
  } finally {
    bitmap.close();
  }
}
export const measureBreadboard = (file: Blob, signal?: AbortSignal) =>
  runVision<GeometryResult>(file, undefined, signal);
export async function measureEndpoints(
  inspection: CircuitInspection,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/circuit-inspections/${inspection.id}/image`,
    { signal },
  );
  if (!response.ok) throw Error("The captured photograph is unavailable.");
  return runVision<LocalEndpoint[]>(await response.blob(), inspection, signal);
}
