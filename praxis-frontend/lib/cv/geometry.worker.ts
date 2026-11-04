import { detectGeometry, type CV } from "./geometry";
import { matchLocalEndpoints, type RasterMask } from "./endpoints";
import type { CircuitInput } from "../automatic-circuit";
declare const self: {
  importScripts: (url: string) => void;
  cv: CV | Promise<CV>;
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};
let runtime: Promise<{ cv: CV }> | null = null;
function getCV() {
  return (runtime ??= new Promise<{ cv: CV }>((resolve, reject) => {
    try {
      self.importScripts("/cv/opencv-4.12.0.js");
      const cvRuntime = self.cv;
      if (cvRuntime instanceof Promise)
        cvRuntime.then((cv) => resolve({ cv }), reject);
      else if (cvRuntime.Mat) resolve({ cv: cvRuntime });
      else
        (
          cvRuntime as CV & { onRuntimeInitialized: () => void }
        ).onRuntimeInitialized = () => resolve({ cv: cvRuntime });
    } catch (error) {
      reject(error);
    }
  }));
}
self.onmessage = async (
  event: MessageEvent<{
    id: number;
    rgba: ArrayBuffer;
    width: number;
    height: number;
    original: { width: number; height: number };
    input?: CircuitInput;
    masks?: RasterMask[];
  }>,
) => {
  try {
    const { cv } = await getCV(),
      data = event.data;
    self.postMessage({
      id: data.id,
      result: data.input
        ? matchLocalEndpoints(
            cv,
            new Uint8ClampedArray(data.rgba),
            data.width,
            data.height,
            data.input,
            data.masks ?? [],
          )
        : detectGeometry(
            cv,
            new Uint8ClampedArray(data.rgba),
            data.width,
            data.height,
            data.original,
          ),
    });
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      error:
        error instanceof Error
          ? error.message
          : "Local computer vision failed.",
    });
  }
};
