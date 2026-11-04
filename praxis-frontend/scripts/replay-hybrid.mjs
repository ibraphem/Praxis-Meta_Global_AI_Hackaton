import cv from "@techstark/opencv-js";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { matchLocalEndpoints } from "../lib/cv/endpoints.ts";
const sharp = createRequire(
  new URL("../../praxis-backend/server/package.json", import.meta.url),
)("sharp");
export async function replayEndpoints(photo, inspection) {
  if (!cv.Mat)
    await new Promise((resolve) => {
      cv.onRuntimeInitialized = resolve;
    });
  const canonical=await sharp(photo).rotate().flatten({background:'#ffffff'}).jpeg({quality:90}).toBuffer();
  const { data, info } = await sharp(canonical)
    .resize({ width: 1600, height: 1600, fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const masks = [];
  for (const m of inspection.hybrid.wireMasks.filter((m) => m.componentId)) {
    const [x, y, w, h] = m.bbox,
      sx = info.width / inspection.image.width,
      sy = info.height / inspection.image.height,
      mw = Math.ceil(w * sx) + 4,
      mh = Math.ceil(h * sy) + 4;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${mw}" height="${mh}"><g transform="translate(2 2) scale(${(w * sx) / m.mask.width} ${(h * sy) / m.mask.height})"><path d="${m.mask.path}" fill="white" fill-rule="evenodd"/></g></svg>`;
    const pixels = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer(),
      binary = new Uint8Array(mw * mh);
    for (let i = 0; i < binary.length; i++)
      binary[i] = pixels[i * 4 + 3] > 127 ? 1 : 0;
    masks.push({
      componentId: m.componentId,
      data: binary,
      width: mw,
      height: mh,
      left: Math.floor(x * sx) - 2,
      top: Math.floor(y * sy) - 2,
    });
  }
  return matchLocalEndpoints(
    cv,
    new Uint8ClampedArray(data),
    info.width,
    info.height,
    inspection.input,
    masks,
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [photo, bundle, output] = process.argv.slice(2);
  if (!photo || !bundle || !output)
    throw Error("Provide IMAGE BUNDLE.json OUTPUT.json");
  const inspection = JSON.parse(await readFile(bundle, "utf8")),
    start = Date.now(),
    endpoints = await replayEndpoints(photo, inspection);
  await writeFile(
    output,
    JSON.stringify({ endpoints, elapsedMs: Date.now() - start }, null, 2),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      supported: endpoints.filter((e) => e.status === "supported").length,
      ambiguous: endpoints.filter((e) => e.status === "ambiguous").length,
      unresolved: endpoints.filter((e) => e.status === "unresolved").length,
      output,
    }),
  );
}
