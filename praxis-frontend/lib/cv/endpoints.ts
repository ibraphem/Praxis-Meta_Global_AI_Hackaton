import type { CV } from "./geometry";
import type { CircuitInput } from "../automatic-circuit";
import type { LocalEndpoint } from "../../../praxis-backend/server/src/shared/hybrid-geometry";
import {
  allHoles,
  project,
  unproject,
  type Calibration,
  type Rail,
} from "../../../praxis-backend/server/src/shared/calibration";
export interface RasterMask {
  componentId: string;
  data: Uint8Array;
  width: number;
  height: number;
  left: number;
  top: number;
}
function connectorFootprints(
  cv: CV,
  gray: InstanceType<CV["Mat"]>,
  pitch: number,
  masks: RasterMask[],
) {
  const dark = new cv.Mat(),
    opened = new cv.Mat(),
    contours = new cv.MatVector(),
    hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(
    cv.MORPH_RECT,
    new cv.Size(
      Math.max(3, Math.round(pitch * 0.48)),
      Math.max(3, Math.round(pitch * 0.48)),
    ),
  );
  const result: {
    componentId: string;
    point: { x: number; y: number };
    separation: number;
  }[] = [];
  try {
    cv.threshold(gray, dark, 85, 255, cv.THRESH_BINARY_INV);
    cv.morphologyEx(dark, opened, cv.MORPH_OPEN, kernel);
    cv.findContours(
      opened,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      try {
        const rect = cv.minAreaRect(contour),
          short = Math.min(rect.size.width, rect.size.height),
          long = Math.max(rect.size.width, rect.size.height);
        if (
          short < pitch * 0.3 ||
          short > pitch * 1.3 ||
          long < pitch * 0.8 ||
          long > pitch * 4 ||
          long / short < 1.5 ||
          cv.contourArea(contour) / (short * long) < 0.65
        )
          continue;
        const angle =
            ((rect.angle + (rect.size.width < rect.size.height ? 90 : 0)) *
              Math.PI) /
            180,
          axis = { x: Math.cos(angle), y: Math.sin(angle) };
        const ends = [-1, 1].map((sign) => ({
          x: rect.center.x + ((axis.x * long) / 2) * sign,
          y: rect.center.y + ((axis.y * long) / 2) * sign,
          sign,
        }));
        const scores = masks
          .map((mask) => {
            const sample = (end: (typeof ends)[number]) => {
              let count = 0;
              for (let d = pitch * 0.12; d < pitch * 0.85; d += 1)
                for (
                  let offset = -short * 0.4;
                  offset <= short * 0.4;
                  offset += 1
                ) {
                  const x =
                      Math.round(
                        end.x + axis.x * d * end.sign - axis.y * offset,
                      ) - mask.left,
                    y =
                      Math.round(
                        end.y + axis.y * d * end.sign + axis.x * offset,
                      ) - mask.top;
                  if (
                    x >= 0 &&
                    y >= 0 &&
                    x < mask.width &&
                    y < mask.height &&
                    mask.data[y * mask.width + x]
                  )
                    count++;
                }
              return count;
            };
            const counts = ends.map(sample);
            return {
              componentId: mask.componentId,
              counts,
              score: Math.max(...counts),
            };
          })
          .sort((a, b) => b.score - a.score);
        const best = scores[0];
        if (
          !best ||
          best.score < pitch * 0.25 ||
          (scores[1] && scores[1].score > best.score * 0.65)
        )
          continue;
        const stronger = best.counts[0] > best.counts[1] ? 0 : 1,
          weaker = 1 - stronger;
        if (best.counts[weaker] > best.counts[stronger] * 0.55) continue;
        result.push({
          componentId: best.componentId,
          point: ends[weaker],
          separation:
            (best.counts[stronger] - best.counts[weaker]) /
            Math.max(1, best.counts[stronger]),
        });
      } finally {
        contour.delete();
      }
    }
    return result;
  } finally {
    dark.delete();
    opened.delete();
    contours.delete();
    hierarchy.delete();
    kernel.delete();
  }
}
function thin(input: Uint8Array, width: number, height: number) {
  const data = new Uint8Array(input);
  let converged = false;
  for (let iteration = 0; iteration < 120; iteration++) {
    let changed = 0;
    for (let phase = 0; phase < 2; phase++) {
      const remove: number[] = [];
      for (let y = 1; y < height - 1; y++)
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          if (!data[i]) continue;
          const p = [
            data[i - width],
            data[i - width + 1],
            data[i + 1],
            data[i + width + 1],
            data[i + width],
            data[i + width - 1],
            data[i - 1],
            data[i - width - 1],
          ];
          const n = p.reduce((s, v) => s + v, 0),
            transitions = p.filter((v, j) => !v && p[(j + 1) % 8]).length;
          if (n < 2 || n > 6 || transitions !== 1) continue;
          if (
            phase === 0
              ? !(p[0] * p[2] * p[4]) && !(p[2] * p[4] * p[6])
              : !(p[0] * p[2] * p[6]) && !(p[0] * p[4] * p[6])
          )
            remove.push(i);
        }
      remove.forEach((i) => (data[i] = 0));
      changed += remove.length;
    }
    if (!changed) {
      converged = true;
      break;
    }
  }
  return { data, converged };
}
function skeletonEnds(mask: RasterMask) {
  const { data, converged } = thin(mask.data, mask.width, mask.height);
  if (!converged)
    return {
      points: [] as { x: number; y: number }[],
      reason: "Wire thinning did not converge.",
    };
  const offsets = [
    -mask.width - 1,
    -mask.width,
    -mask.width + 1,
    -1,
    1,
    mask.width - 1,
    mask.width,
    mask.width + 1,
  ];
  const seed = data.findIndex((v) => !!v);
  if (seed < 0) return { points: [], reason: "Empty wire mask." };
  function farthest(start: number) {
    const queue = new Int32Array(data.length),
      visited = new Uint8Array(data.length);
    let head = 0,
      tail = 1,
      last = start;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      last = i;
      for (const delta of offsets) {
        const n = i + delta;
        if (
          n < 0 ||
          n >= data.length ||
          Math.abs((n % mask.width) - (i % mask.width)) > 1 ||
          !data[n] ||
          visited[n]
        )
          continue;
        visited[n] = 1;
        queue[tail++] = n;
      }
    }
    return { last, visited: tail };
  }
  const marked = new Uint8Array(data.length);
  let largestSeed = seed,
    largestCount = 0;
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || marked[start]) continue;
    const queue = [start];
    marked[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      for (const delta of offsets) {
        const n = i + delta;
        if (
          n < 0 ||
          n >= data.length ||
          Math.abs((n % mask.width) - (i % mask.width)) > 1 ||
          !data[n] ||
          marked[n]
        )
          continue;
        marked[n] = 1;
        queue.push(n);
      }
    }
    if (queue.length > largestCount) {
      largestCount = queue.length;
      largestSeed = start;
    }
  }
  const a = farthest(largestSeed),
    b = farthest(a.last),
    total = data.reduce((sum, v) => sum + v, 0);
  if (b.visited / total < 0.94)
    return { points: [], reason: "Wire mask has disconnected fragments." };
  const points = [a.last, b.last].map((i) => ({
    x: mask.left + (i % mask.width),
    y: mask.top + Math.floor(i / mask.width),
  }));
  return {
    points,
    reason:
      "Endpoints measured along a connected wire mask; hidden insertion remains a proposal.",
  };
}
function chromaticWireMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  bbox: [number, number, number, number],
  pitch: number,
  componentId: string,
): RasterMask | null {
  const pad = pitch * 1.8,
    left = Math.max(0, Math.floor(bbox[0] - pad)),
    top = Math.max(0, Math.floor(bbox[1] - pad)),
    right = Math.min(width, Math.ceil(bbox[0] + bbox[2] + pad)),
    bottom = Math.min(height, Math.ceil(bbox[1] + bbox[3] + pad)),
    w = right - left,
    h = bottom - top;
  if (w < 3 || h < 3) return null;
  const saturated = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = ((top + y) * width + left + x) * 4,
        r = rgba[i],
        g = rgba[i + 1],
        b = rgba[i + 2],
        high = Math.max(r, g, b),
        low = Math.min(r, g, b),
        chroma = high - low;
      if (high >= 70 && chroma >= 42 && chroma / high >= 0.28)
        saturated[y * w + x] = 1;
    }
  // Bridge one-pixel highlight gaps without introducing a color-specific rule.
  const joined = new Uint8Array(saturated);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (saturated[i]) continue;
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          neighbors += saturated[(y + dy) * w + x + dx];
      if (neighbors >= 3) joined[i] = 1;
    }
  const seen = new Uint8Array(joined.length),
    offsets = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  let best: number[] = [],
    bestScore = -Infinity;
  for (let start = 0; start < joined.length; start++) {
    if (!joined[start] || seen[start]) continue;
    const queue = [start];
    seen[start] = 1;
    let minX = start % w,
      maxX = minX,
      minY = Math.floor(start / w),
      maxY = minY;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head],
        x = i % w,
        y = Math.floor(i / w);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const delta of offsets) {
        const n = i + delta;
        if (
          n < 0 ||
          n >= joined.length ||
          Math.abs((n % w) - x) > 1 ||
          !joined[n] ||
          seen[n]
        )
          continue;
        seen[n] = 1;
        queue.push(n);
      }
    }
    const bw = maxX - minX + 1,
      bh = maxY - minY + 1,
      length = Math.hypot(bw, bh),
      fill = queue.length / (bw * bh),
      score = length + queue.length / Math.max(1, pitch);
    if (
      queue.length >= pitch * 0.8 &&
      length >= pitch * 2 &&
      fill < 0.42 &&
      score > bestScore
    ) {
      best = queue;
      bestScore = score;
    }
  }
  if (!best.length) return null;
  const data = new Uint8Array(w * h);
  best.forEach((i) => (data[i] = 1));
  return { componentId, data, width: w, height: h, left, top };
}
function collinearExtremes(
  candidates: { p: { x: number; y: number }; length: number; hole: string }[],
  pitch: number,
) {
  if (candidates.length < 2) return null;
  let best: [typeof candidates[number], typeof candidates[number]] | null = null,
    separation = 0;
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i],
        b = candidates[j],
        d = Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y);
      if (d > separation) {
        separation = d;
        best = [a, b];
      }
    }
  if (!best || separation < pitch * 0.75) return null;
  const [a, b] = best,
    dx = b.p.x - a.p.x,
    dy = b.p.y - a.p.y;
  if (
    candidates.some(
      (c) =>
        Math.abs((c.p.x - a.p.x) * dy - (c.p.y - a.p.y) * dx) /
          separation >
        pitch * 0.3,
    )
  )
    return null;
  return best;
}
/** Raster masks and image evidence locate references; no LLM terminal coordinates enter this function. */
export function matchLocalEndpoints(
  cv: CV,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  input: CircuitInput,
  masks: RasterMask[],
): LocalEndpoint[] {
  const sx = input.boards[0]?.calibration.image.width / width || 1,
    sy = input.boards[0]?.calibration.image.height / height || 1;
  const holes = input.boards.flatMap((b) =>
    allHoles(b.calibration as Calibration, b.rails as Rail[]).map((h) => ({
      board: b,
      hole: h,
      pixel: project(b.calibration as Calibration, h.grid),
    })),
  );
  const result: LocalEndpoint[] = [];
  const rank = (position: { x: number; y: number }) =>
    holes
      .map((h) => {
        const grid = unproject(h.board.calibration as Calibration, position);
        return {
          boardId: h.board.id,
          holeId: h.hole.id,
          distancePitch: Math.hypot(
            grid.x - h.hole.grid.x,
            grid.y - h.hole.grid.y,
          ),
        };
      })
      .sort((a, b) => a.distancePitch - b.distancePitch)
      .slice(0, 3);
  const unresolved = (c: CircuitInput["components"][number], reason: string) =>
    c.terminalIds.forEach((terminalId) =>
      result.push({
        terminalId,
        componentId: c.id,
        position: null,
        basis: "unresolved",
        status: "unresolved",
        reason,
        candidates: [],
      }),
    );
  let binary: InstanceType<CV["Mat"]> | null = null;
  const src = new cv.Mat(height, width, cv.CV_8UC4),
    gray = new cv.Mat();
  src.data.set(rgba);
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    binary = new cv.Mat();
    cv.adaptiveThreshold(
      gray,
      binary,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      31,
      8,
    );
    const anchors = input.boards[0]?.calibration.anchors;
    const pitch = anchors
      ? Math.hypot(anchors[1].x - anchors[0].x, anchors[1].y - anchors[0].y) /
        11 /
        Math.sqrt(sx * sy)
      : 20;
    const footprints = connectorFootprints(cv, gray, pitch, masks),
      claimedLeadHoles = new Set<string>(),
      componentPriority = (type: string) =>
        type === "resistor" ? 0 : ["led", "capacitor"].includes(type) ? 1 : 2;
    for (const c of [...input.components].sort(
      (a, b) => componentPriority(a.type) - componentPriority(b.type),
    )) {
      if (c.state === "rejected" || !c.terminalIds.length) continue;
      if (!holes.length) {
        unresolved(c, "A measured board grid is required.");
        continue;
      }
      let points: { x: number; y: number }[] = [],
        reason = "",
        basis: LocalEndpoint["basis"] = "unresolved";
      if (c.type === "jumper_wire") {
        let selected = masks.filter((m) => m.componentId === c.id);
        let chromatic = false;
        if (!selected.length && c.bbox) {
          const derived = chromaticWireMask(
            rgba,
            width,
            height,
            [c.bbox[0] / sx, c.bbox[1] / sy, c.bbox[2] / sx, c.bbox[3] / sy],
            pitch,
            c.id,
          );
          if (derived) {
            selected = [derived];
            chromatic = true;
          }
        }
        if (selected.length !== 1) {
          unresolved(
            c,
            selected.length
              ? "Multiple masks could represent this wire."
              : "No uniquely associated complete wire mask.",
          );
          continue;
        }
        const ends = skeletonEnds(selected[0]);
        points = ends.points;
        reason = chromatic
          ? "A connected high-chroma conductor trace supplies two image endpoints independently of the semantic label."
          : ends.reason;
        basis = chromatic ? "chromatic_trace" : "mask_endpoint";
        const feet = footprints
          .filter((f) => f.componentId === c.id)
          .map((f) => ({
            point: f.point,
            nearest: rank({ x: f.point.x * sx, y: f.point.y * sy })[0],
          }))
          .filter((f) => f.nearest && f.nearest.distancePitch < 0.6);
        if (feet.length && feet.length <= 2) {
          if (points.length !== 2) points = feet.map((f) => f.point);
          else
            for (const foot of feet) {
              const nearest = points
                .map((p, i) => ({
                  i,
                  d: Math.hypot(p.x - foot.point.x, p.y - foot.point.y),
                }))
                .sort((a, b) => a.d - b.d)[0];
              if (nearest.d < pitch * 3) points[nearest.i] = foot.point;
            }
          reason =
            "Connector housing base measured from its shape and the entering wire mask; hidden metal contact requires confirmation.";
          basis = "connector_footprint";
          // A visible housing can support one end while the other remains outside the image.
          if (points.length === 1) points.push({ x: -100, y: -100 });
        }
        if (
          points.some(
            (p) => p.x < 3 || p.y < 3 || p.x > width - 4 || p.y > height - 4,
          )
        )
          reason += " A wire end touches the image boundary.";
      } else if (["resistor", "led", "capacitor"].includes(c.type) && c.bbox) {
        const b = c.bbox,
          pad = 20,
          left = Math.max(0, Math.floor(b[0] / sx - pad)),
          top = Math.max(0, Math.floor(b[1] / sy - pad)),
          w = Math.min(width - left, Math.ceil(b[2] / sx + pad * 2)),
          h = Math.min(height - top, Math.ceil(b[3] / sy + pad * 2));
        const roi = binary.roi(new cv.Rect(left, top, w, h)),
          segments = new cv.Mat();
        try {
          const pitch = Math.max(
            8,
            Math.hypot(
              input.boards[0].calibration.anchors[1].x -
                input.boards[0].calibration.anchors[0].x,
              input.boards[0].calibration.anchors[1].y -
                input.boards[0].calibration.anchors[0].y,
            ) /
              11 /
              Math.sqrt(sx * sy),
          );
          cv.HoughLinesP(
            roi,
            segments,
            1,
            Math.PI / 180,
            12,
            pitch * 0.6,
            pitch * 0.2,
          );
          const candidates: {
            p: { x: number; y: number };
            length: number;
            hole: string;
          }[] = [];
          for (let i = 0; i < segments.rows; i++) {
            const s = segments.intPtr(i, 0),
              length = Math.hypot(s[0] - s[2], s[1] - s[3]);
            for (const [x, y] of [
              [s[0], s[1]],
              [s[2], s[3]],
            ]) {
              const p = { x: (left + x) * sx, y: (top + y) * sy },
                nearest = rank(p)[0];
              if (
                nearest &&
                nearest.distancePitch < 0.23 &&
                !claimedLeadHoles.has(nearest.holeId) &&
                !candidates.some((v) => v.hole === nearest.holeId)
              )
                candidates.push({ p, length, hole: nearest.holeId });
            }
          }
          candidates.sort((a, b) => b.length - a.length);
          const selected =
            candidates.length === 2
              ? candidates
              : collinearExtremes(candidates, pitch);
          if (selected) {
            selected.forEach((candidate) =>
              claimedLeadHoles.add(candidate.hole),
            );
            points = selected.map((c) => ({ x: c.p.x / sx, y: c.p.y / sy }));
            reason =
              candidates.length === 2
                ? "Two local lead-line endpoints uniquely meet hole candidates."
                : "Multiple line fragments form one continuous lead axis; its two calibrated extremes meet unique holes.";
            basis = "exposed_lead";
          } else
            reason =
              "Lead geometry is obscured or has multiple possible hole assignments.";
        } finally {
          roi.delete();
          segments.delete();
        }
      }
      if (points.length !== c.terminalIds.length) {
        unresolved(c, reason || "Terminal geometry is unresolved.");
        continue;
      }
      for (const [i, p] of points.entries()) {
        if (p.x < 0 || p.y < 0) {
          result.push({
            terminalId: c.terminalIds[i],
            componentId: c.id,
            position: null,
            basis: "unresolved",
            status: "unresolved",
            reason: "The other end has no supported visible location.",
            candidates: [],
          });
          continue;
        }
        const position = { x: p.x * sx, y: p.y * sy },
          candidates = rank(position),
          best = candidates[0],
          margin = candidates[1]
            ? candidates[1].distancePitch - best.distancePitch
            : 1;
        const boundary =
          p.x < 3 || p.y < 3 || p.x > width - 4 || p.y > height - 4;
        const external =
          c.type === "jumper_wire" &&
          best &&
          best.distancePitch > 1.5 &&
          !boundary;
        result.push({
          terminalId: c.terminalIds[i],
          componentId: c.id,
          position,
          basis: external ? "external_connector" : basis,
          status:
            external
              ? "external"
              : !boundary && best && best.distancePitch <= 0.32 && margin >= 0.15
              ? "supported"
              : "ambiguous",
          reason: external
            ? "The traced conductor end is outside the calibrated breadboard and is retained as an external connection."
            : boundary
              ? "Mask terminates at the image boundary; the physical end may be outside the photo."
              : reason,
          candidates: external ? [] : candidates,
        });
      }
    }
  } finally {
    src.delete();
    gray.delete();
    binary?.delete();
  }
  return result;
}
