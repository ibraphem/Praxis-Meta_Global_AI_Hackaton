export const cameraPixelLimit = 1500000;
export function frameSize(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  )
    throw Error("Wait for the camera image.");
  const scale = Math.min(1, Math.sqrt(cameraPixelLimit / (width * height)));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
export async function captureCamera(video: HTMLVideoElement) {
  if (video.readyState < 2) throw Error("Wait for the camera image.");
  const size = frameSize(video.videoWidth, video.videoHeight),
    canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("Camera capture unavailable.");
  ctx.drawImage(video, 0, 0, size.width, size.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(Error("Could not capture this frame."))),
      "image/jpeg",
      0.94,
    ),
  );
  return {
    file: new File([blob], "praxis-capture.jpg", { type: "image/jpeg" }),
    ...size,
    capturedAt: Date.now(),
    cameraFrame: { width: video.videoWidth, height: video.videoHeight },
  };
}
export async function imagePixels(url: string) {
  const im = new Image();
  im.src = url;
  await im.decode();
  const c = document.createElement("canvas");
  c.width = im.naturalWidth;
  c.height = im.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(im, 0, 0);
  return rgbPixels(ctx.getImageData(0, 0, c.width, c.height));
}
export function rgbPixels(image: ImageData) {
  const data = new Uint8Array(image.width * image.height * 3);
  for (let s = 0, d = 0; s < image.data.length; s += 4, d += 3) {
    data[d] = image.data[s];
    data[d + 1] = image.data[s + 1];
    data[d + 2] = image.data[s + 2];
  }
  return { width: image.width, height: image.height, data };
}
