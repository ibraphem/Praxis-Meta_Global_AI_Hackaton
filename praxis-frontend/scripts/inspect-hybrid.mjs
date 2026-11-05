import cv from "@techstark/opencv-js";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { detectGeometry } from "../lib/cv/geometry";
import {replayEndpoints} from './replay-hybrid.mjs';
import { AutomaticCircuitService } from "../../praxis-backend/server/src/jobs/automatic-circuits";
import { JobStore } from "../../praxis-backend/server/src/jobs/store";
import { loadConfig } from "../../praxis-backend/server/src/config";
import { admittedClient } from "../../praxis-backend/server/src/jobs/model-admission";
const sharp = createRequire(
  new URL("../../praxis-backend/server/package.json", import.meta.url),
)("sharp");
const [file, output] = process.argv.slice(2);
if (!file || !output) throw Error("Provide IMAGE OUTPUT.json");
if (!cv.Mat)
  await new Promise((resolve) => {
    cv.onRuntimeInitialized = resolve;
  });
const bytes = await readFile(file),
  canonical = await sharp(bytes).rotate().toBuffer(),
  metadata = await sharp(canonical).metadata();
const { data, info } = await sharp(canonical)
  .resize({ width: 1600, height: 1600, fit: "inside" })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const geometry = detectGeometry(
  cv,
  new Uint8ClampedArray(data),
  info.width,
  info.height,
  { width: metadata.width, height: metadata.height },
);
console.log(
  JSON.stringify({
    geometry: geometry.status,
    holes: geometry.fit?.holes.length,
    rmsPitch: geometry.fit?.rmsPitch,
  }),
);
const store = new JobStore(loadConfig(), ":memory:"),
  service = new AutomaticCircuitService(store, admittedClient(store));
try {
  const initial = await service.create(bytes, {
    sourceHash: createHash("sha256").update(bytes).digest("hex"),
    geometry,
  });
  let view = initial,
    last = "";
  while (["queued", "running"].includes(view.status)) {
    if (view.stage !== last) {
      console.log(view.stage);
      last = view.stage;
    }
    await new Promise((r) => setTimeout(r, 1000));
    view = service.get(initial.id);
  }
  if(view.input&&view.hybrid){const endpoints=await replayEndpoints(file,view);view=service.localize(view.id,{expectedRevision:view.revision,imageHash:view.imageHash,endpoints});}
  await writeFile(output, JSON.stringify(service.evidence(view.id), null, 2), {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      status: view.status,
      elapsedSeconds:Math.round((Date.now()-view.createdAt)/1000),
      requests: view.requestCount,
      components: view.input?.components.length,
      wireMasks: view.hybrid?.wireMasks.length,
      assignedMasks: view.hybrid?.wireMasks.filter((m) => m.componentId).length,
      numbering: view.hybrid?.numbering,
      clearConnections:view.hybrid?.endpoints.filter(e=>e.status==='supported').length,
      externalConnections:view.hybrid?.endpoints.filter(e=>e.status==='external').length,
      ambiguousConnections:view.hybrid?.endpoints.filter(e=>e.status==='ambiguous').length,
      error: view.error,
      output,
    }),
  );
} finally {
  await service.close();
  store.close();
}
