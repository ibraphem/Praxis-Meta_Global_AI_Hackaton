import { recoveryEligible, quarantineReason } from './wire-evidence-policy.js';
import { extendsCropFragment } from './wire-continuation.js';
import {
  maskEvidenceReader,
  prioritizeWireEvidence,
} from './wire-mask-evidence.js';
import { cropFragment } from './wire-fragments.js';
import { reconcileWireReviews } from './wire-review-reconciliation.js';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { decodeMaskToRaster } from '@meta-sam/parser';
import type { SamSnapshot } from './vision.js';
import type { SnapshotRef } from '../jobs/snapshots.js';
import type {
  WireIdentity,
  RecoveryCandidate,
  RecoveryReport,
} from '../schemas/wire-recovery.js';
import {
  recoveryReportSchema,
  effectiveIdentityReviews,
} from '../schemas/wire-recovery.js';
import { inspectWire } from './wire-inspection.js';
import { WireGeometry } from './wire-geometry.js';
import type { BoundingBox } from '../schemas/vision.js';

export function thinBinary(
  input: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const data = input.slice();
  for (let it = 0; it < 48; it++) {
    let changed = false;
    for (let phase = 0; phase < 2; phase++) {
      const remove: number[] = [];
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!data[i]) continue;
          const p = [
            data[i - w]!,
            data[i - w + 1]!,
            data[i + 1]!,
            data[i + w + 1]!,
            data[i + w]!,
            data[i + w - 1]!,
            data[i - 1]!,
            data[i - w - 1]!,
          ];
          let n = 0,
            t = 0;
          for (let k = 0; k < 8; k++) {
            n += p[k]!;
            if (!p[k] && p[(k + 1) % 8]) t++;
          }
          if (n < 2 || n > 6 || t !== 1) continue;
          const a = phase === 0 ? p[0]! * p[2]! * p[4]! : p[0]! * p[2]! * p[6]!,
            b = phase === 0 ? p[2]! * p[4]! * p[6]! : p[0]! * p[4]! * p[6]!;
          if (!a && !b) remove.push(i);
        }
      for (const i of remove) data[i] = 0;
      if (remove.length) changed = true;
    }
    if (!changed) break;
  }
  return data;
}
function pathOf(binary: Uint8Array, w: number, h: number) {
  const start = binary.findIndex((v) => v !== 0);
  if (start < 0) return { path: [] as number[], ends: 0, branches: 0 };
  const neighbors = (i: number) => {
    const out: number[] = [],
      x = i % w,
      y = Math.floor(i / w);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx,
          ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && binary[ny * w + nx])
          out.push(ny * w + nx);
      }
    return out;
  };
  let ends = 0,
    branches = 0;
  for (let i = 0; i < binary.length; i++)
    if (binary[i]) {
      const n = neighbors(i).length;
      if (n === 1) ends++;
      if (n > 2) branches++;
    }
  const bfs = (s: number) => {
    const visited = new Uint8Array(binary.length),
      parent = new Int32Array(binary.length).fill(-1),
      queue = [s];
    visited[s] = 1;
    for (let head = 0; head < queue.length; head++)
      for (const next of neighbors(queue[head]!))
        if (!visited[next]) {
          visited[next] = 1;
          parent[next] = queue[head]!;
          queue.push(next);
        }
    return { last: queue.at(-1)!, parent };
  };
  const first = bfs(start),
    second = bfs(first.last),
    path = [second.last];
  while (second.parent[path.at(-1)!]! >= 0)
    path.push(second.parent[path.at(-1)!]!);
  return { path, ends, branches };
}
function labelsOf(
  rgb: Uint8Array,
  w: number,
  h: number,
  short = false,
): Uint8Array {
  const labels = new Uint8Array(w * h),
    values = new Float32Array(w * h);
  for (let i = 0; i < labels.length; i++) {
    const r = rgb[i * 3]! / 255,
      g = rgb[i * 3 + 1]! / 255,
      b = rgb[i * 3 + 2]! / 255,
      max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      d = max - min;
    values[i] = max;
    if (max > 0.16 && d / Math.max(max, 0.01) > 0.36) {
      let hue =
        max === r
          ? ((g - b) / d) % 6
          : max === g
            ? (b - r) / d + 2
            : (r - g) / d + 4;
      if (hue < 0) hue += 6;
      labels[i] = short && hue >= 5 ? 1 : 1 + Math.floor(hue);
    }
  }
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (labels[i]) continue;
      if (short) {
        for (const radius of [1, 2, 4, 8])
          for (const [dx, dy] of [
            [1, 0],
            [0, 1],
            [1, 1],
            [1, -1],
          ]) {
            const ax = x - dx! * radius,
              ay = y - dy! * radius,
              bx = x + dx! * radius,
              by = y + dy! * radius;
            if (
              ax >= 0 &&
              ay >= 0 &&
              bx >= 0 &&
              by >= 0 &&
              ax < w &&
              bx < w &&
              ay < h &&
              by < h &&
              values[i]! < 0.5 &&
              values[ay * w + ax]! > values[i]! + 0.1 &&
              values[by * w + bx]! > values[i]! + 0.1
            )
              labels[i] = 7;
          }
        if (labels[i]) continue;
      }
      const v = values[i]!,
        sides = [
          values[i - 2]!,
          values[i + 2]!,
          values[i - 2 * w]!,
          values[i + 2 * w]!,
        ];
      if (
        v < 0.36 &&
        ((sides[0]! > v + 0.13 && sides[1]! > v + 0.13) ||
          (sides[2]! > v + 0.13 && sides[3]! > v + 0.13))
      )
        labels[i] = 7;
      else if (
        v > 0.78 &&
        ((sides[0]! < v - 0.12 && sides[1]! < v - 0.12) ||
          (sides[2]! < v - 0.12 && sides[3]! < v - 0.12))
      )
        labels[i] = 8;
    }
  return labels;
}
export function classicalTraces(
  rgb: Uint8Array,
  w: number,
  h: number,
  image: { width: number; height: number },
  limit = 64,
  options: { short?: boolean } = {},
): { candidates: RecoveryCandidate[]; truncated: boolean } {
  const labels = labelsOf(rgb, w, h, options.short),
    seen = new Uint8Array(labels.length),
    candidates: RecoveryCandidate[] = [];
  let roiPixels = 0,
    truncated = false;
  const colors = [
    '',
    'red/orange',
    'yellow',
    'green',
    'cyan',
    'blue',
    'magenta',
    'dark',
    'light',
  ];
  for (let start = 0; start < labels.length; start++) {
    if (!labels[start] || seen[start]) continue;
    const label = labels[start]!,
      queue = [start];
    seen[start] = 1;
    let minX = w,
      maxX = 0,
      minY = h,
      maxY = 0;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!,
        x = i % w,
        y = Math.floor(i / w);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (!seen[n] && labels[n] === label) {
            seen[n] = 1;
            queue.push(n);
          }
        }
    }
    const bw = maxX - minX + 1,
      bh = maxY - minY + 1,
      span = Math.max(bw, bh);
    if (
      queue.length < 6 ||
      span < (options.short ? 4 : 9) ||
      queue.length / (span * span) > 0.5
    )
      continue;
    if (
      candidates.length >= limit ||
      bw * bh > 160000 ||
      roiPixels + bw * bh > 1600000
    ) {
      truncated = true;
      continue;
    }
    roiPixels += bw * bh;
    const pw = bw + 2,
      ph = bh + 2,
      binary = new Uint8Array(pw * ph);
    for (const i of queue)
      binary[(Math.floor(i / w) - minY + 1) * pw + ((i % w) - minX + 1)] = 1;
    const skeleton = thinBinary(binary, pw, ph),
      topology = pathOf(skeleton, pw, ph);
    if (topology.path.length < (options.short ? 4 : 8)) continue;
    const points: [number, number][] = topology.path
      .filter(
        (_p, i) =>
          i === 0 ||
          i === topology.path.length - 1 ||
          i % Math.max(1, Math.ceil(topology.path.length / 126)) === 0,
      )
      .slice(0, 128)
      .map((i) => [
        Math.min(
          image.width - 1,
          ((minX + (i % pw) - 1 + 0.5) * image.width) / w,
        ),
        Math.min(
          image.height - 1,
          ((minY + Math.floor(i / pw) - 1 + 0.5) * image.height) / h,
        ),
      ]);
    const x = Math.floor((minX * image.width) / w),
      y = Math.floor((minY * image.height) / h),
      bbox: BoundingBox = [
        x,
        y,
        Math.min(image.width, Math.ceil(((maxX + 1) * image.width) / w)) - x,
        Math.min(image.height, Math.ceil(((maxY + 1) * image.height) / h)) - y,
      ];
    candidates.push({
      id: `cv_trace_${candidates.length + 1}`,
      source: 'cv_trace',
      bbox,
      points,
      color: colors[label]!,
      geometryAccepted: false,
      rejectionReasons: topology.branches
        ? ['fragment_hypothesis', 'branched_mask']
        : ['fragment_hypothesis'],
      metrics: {
        area: queue.length,
        components: 1,
        ends: topology.ends,
        branches: topology.branches,
        occupancy: queue.length / (bw * bh),
        topologyScale: w / image.width,
      },
      candidateCoverage: 0,
      verifiedCoverage: 0,
      touchesImageBoundary:
        minX <= 1 || minY <= 1 || maxX >= w - 2 || maxY >= h - 2,
      identityStatus: 'unverified',
      guidanceEligible: false,
    });
  }
  return { candidates, truncated };
}
export function selectRecoveryTiles(
  candidates: RecoveryCandidate[],
  image: { width: number; height: number },
): BoundingBox[] {
  const scores = new Map<number, number>();
  for (const c of candidates) {
    // Crop exits have dedicated wire-centered recovery; broad tiles truncate them again.
    if (c.touchesCropBoundary) continue;
    if (
      c.source === 'cv_trace' ? c.candidateCoverage >= 0.8 : c.geometryAccepted
    )
      continue;
    const cx = c.bbox[0] + c.bbox[2] / 2,
      cy = c.bbox[1] + c.bbox[3] / 2,
      col = Math.min(2, Math.floor((cx / image.width) * 3)),
      row = Math.min(2, Math.floor((cy / image.height) * 3));
    const id = row * 3 + col;
    scores.set(
      id,
      (scores.get(id) ?? 0) +
        Math.max(c.bbox[2], c.bbox[3]) *
          (c.source === 'cv_trace' ? 1 - c.candidateCoverage : 0.5),
    );
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id]) => {
      const col = id % 3,
        row = Math.floor(id / 3),
        padX = image.width / 24,
        padY = image.height / 24,
        x = Math.max(0, Math.floor((col * image.width) / 3 - padX)),
        y = Math.max(0, Math.floor((row * image.height) / 3 - padY));
      return [
        x,
        y,
        Math.min(image.width, Math.ceil(((col + 1) * image.width) / 3 + padX)) -
          x,
        Math.min(
          image.height,
          Math.ceil(((row + 1) * image.height) / 3 + padY),
        ) - y,
      ];
    });
}
export async function auditWireCoverage(
  snapshot: SamSnapshot,
  ref: SnapshotRef,
  reviews: WireIdentity[] = [],
  maxDimension = 1280,
  previous?: RecoveryReport,
): Promise<RecoveryReport> {
  const image = { width: snapshot.image.width, height: snapshot.image.height };
  const { data, info } = await sharp(
    Buffer.from(snapshot.image.dataUrl.split(',')[1]!, 'base64'),
  )
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const imageEvidenceHash = createHash('sha256')
    .update(ref.imageHash)
    .update(`${image.width}x${image.height}:`)
    .update(snapshot.image.dataUrl)
    .digest('hex');
  const raw = prioritizeWireEvidence(
      snapshot.candidates.filter(
        (c) => c.type === 'jumper_wire' && recoveryEligible(c),
      ),
    ),
    geometry = new WireGeometry(image),
    candidates: RecoveryCandidate[] = [],
    coverage = new Uint8Array(info.width * info.height),
    verified = new Uint8Array(coverage.length);
  let decoded = 0,
    paths = 0,
    truncated = false;
  const reportId = createHash('sha256')
    .update(
      'wire-coverage-policy-v2:' + ref.samSnapshotHash + ':' + maxDimension,
    )
    .digest('hex');
  for (const c of raw) {
    const accepted = geometry.resolve(c),
      fragment = cropFragment(c);
    const mask = c.encodedMask;
    let inspection = inspectWire(
      mask && decoded + mask.width * mask.height > 12000000
        ? { id: c.id, type: c.type, bbox: c.bbox }
        : c,
    );
    if (mask && decoded + mask.width * mask.height <= 12000000) {
      decoded += mask.width * mask.height;
      try {
        const raster = decodeMaskToRaster(mask);
        for (let y = 0; y < mask.height; y++)
          for (let x = 0; x < mask.width; x++)
            if (raster[y * mask.width + x]) {
              const gx = Math.min(
                  info.width - 1,
                  Math.floor(
                    ((c.bbox[0] + ((x + 0.5) * c.bbox[2]) / mask.width) *
                      info.width) /
                      image.width,
                  ),
                ),
                gy = Math.min(
                  info.height - 1,
                  Math.floor(
                    ((c.bbox[1] + ((y + 0.5) * c.bbox[3]) / mask.height) *
                      info.height) /
                      image.height,
                  ),
                );
              if (accepted.ok) coverage[gy * info.width + gx] = 1;
            }
      } catch {
        inspection = {
          ...inspection,
          reasons: [...inspection.reasons, 'invalid_mask'],
        };
      }
    } else if (mask) {
      truncated = true;
      inspection = { ...inspection, reasons: ['decode_budget'] };
      delete inspection.preview;
    }
    if (!accepted.ok && !inspection.reasons.includes(accepted.reason))
      inspection.reasons.push(accepted.reason);
    const candidate: RecoveryCandidate = {
      id: c.id,
      source:
        (c as { recoverySource?: string }).recoverySource === 'sam_crop'
          ? 'sam_crop'
          : 'sam_full',
      bbox: c.bbox,
      points: [],
      ...fragment,
      geometryAccepted: accepted.ok && !fragment.touchesCropBoundary,
      rejectionReasons: inspection.reasons,
      metrics: {
        area: inspection.area,
        components: inspection.components,
        ends: inspection.ends,
        branches: inspection.branches,
        occupancy: inspection.occupancy,
        topologyScale: inspection.topologyScale,
      },
      candidateCoverage: accepted.ok ? 1 : 0,
      verifiedCoverage: 0,
      touchesImageBoundary:
        c.bbox[0] <= 1 ||
        c.bbox[1] <= 1 ||
        c.bbox[0] + c.bbox[2] >= image.width - 1 ||
        c.bbox[1] + c.bbox[3] >= image.height - 1,
      identityStatus: 'unverified',
      guidanceEligible: false,
    };
    if (
      inspection.preview &&
      paths + inspection.preview.path.length <= 120000
    ) {
      if (mask)
        candidate.evidenceHash = createHash('sha256')
          .update(
            JSON.stringify([
              imageEvidenceHash,
              'native-mask-v1',
              c.bbox,
              mask.width,
              mask.height,
              mask.encoding,
              mask.payload,
            ]),
          )
          .digest('hex');
      candidate.mask = inspection.preview;
      paths += candidate.mask.path.length;
    }
    if (fragment.touchesCropBoundary)
      candidate.rejectionReasons.push('crop_truncated');
    candidates.push(candidate);
  }
  const cv = classicalTraces(
    data,
    info.width,
    info.height,
    image,
    Math.min(64, Math.max(0, 100 - candidates.length)),
  );
  const hit = (grid: Uint8Array, p: [number, number]) => {
    const x = Math.floor((p[0] * info.width) / image.width),
      y = Math.floor((p[1] * info.height) / image.height);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (
          x + dx >= 0 &&
          y + dy >= 0 &&
          x + dx < info.width &&
          y + dy < info.height &&
          grid[(y + dy) * info.width + x + dx]
        )
          return true;
      }
    return false;
  };
  for (const trace of cv.candidates) {
    trace.candidateCoverage =
      trace.points.filter((p) => hit(coverage, p)).length /
      Math.max(1, trace.points.length);
    trace.evidenceHash = createHash('sha256')
      .update(
        JSON.stringify([
          imageEvidenceHash,
          'cv-trace-v1',
          maxDimension,
          trace.bbox,
          trace.points,
          trace.color,
        ]),
      )
      .digest('hex');
    candidates.push(trace);
  }
  const hypotheses: RecoveryReport['hypotheses'] = [];
  const readExtension = maskEvidenceReader();
  for (const a of raw)
    for (const b of raw) {
      if (a === b || hypotheses.length >= 32) continue;
      if (
        candidates.find((c) => c.id === b.id)?.candidateCoverage === 1 &&
        extendsCropFragment(a, b, readExtension)
      )
        hypotheses.push({
          candidateIds: [a.id, b.id],
          kind: 'mask_extension_proposal',
          signals: ['spatial_overlap'],
          status: 'unverified',
        });
    }
  for (let i = 0; i < cv.candidates.length && hypotheses.length < 32; i++)
    for (
      let j = i + 1;
      j < cv.candidates.length && hypotheses.length < 32;
      j++
    ) {
      const a = cv.candidates[i]!,
        b = cv.candidates[j]!;
      if (a.color !== b.color) continue;
      const endsA = [a.points[0]!, a.points.at(-1)!],
        endsB = [b.points[0]!, b.points.at(-1)!];
      if (
        endsA.some((p) =>
          endsB.some(
            (q) =>
              Math.hypot(p[0] - q[0], p[1] - q[1]) <
              Math.max(image.width, image.height) / 80,
          ),
        )
      )
        hypotheses.push({
          candidateIds: [a.id, b.id],
          kind: 'possible_fragment_continuation',
          status: 'unverified',
        });
    }
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length && hypotheses.length < 32; j++) {
      const a = candidates[i]!,
        b = candidates[j]!;
      if (!a.touchesCropBoundary && !b.touchesCropBoundary) continue;
      if (a.source === 'cv_trace' || b.source === 'cv_trace') continue;
      const overlap =
        a.bbox[0] < b.bbox[0] + b.bbox[2] &&
        b.bbox[0] < a.bbox[0] + a.bbox[2] &&
        a.bbox[1] < b.bbox[1] + b.bbox[3] &&
        b.bbox[1] < a.bbox[1] + a.bbox[3];
      const sample = (c: RecoveryCandidate) => {
        const p = c.cropExitPoints?.[0] ?? [
          c.bbox[0] + c.bbox[2] / 2,
          c.bbox[1] + c.bbox[3] / 2,
        ];
        const idx =
          (Math.min(
            info.height - 1,
            Math.floor((p[1]! * info.height) / image.height),
          ) *
            info.width +
            Math.min(
              info.width - 1,
              Math.floor((p[0]! * info.width) / image.width),
            )) *
          3;
        return [data[idx]!, data[idx + 1]!, data[idx + 2]!];
      };
      const ca = sample(a),
        cb = sample(b),
        color =
          Math.hypot(ca[0]! - cb[0]!, ca[1]! - cb[1]!, ca[2]! - cb[2]!) < 90;
      const aligned = a.bbox[2] >= a.bbox[3] === b.bbox[2] >= b.bbox[3];
      const near = (a.cropExitPoints ?? []).some((p) =>
        (b.cropExitPoints ?? []).some(
          (q) =>
            Math.hypot(p[0] - q[0], p[1] - q[1]) <
            Math.max(image.width, image.height) / 100,
        ),
      );
      if (color && aligned && (overlap || near))
        hypotheses.push({
          candidateIds: [a.id, b.id],
          kind: 'crop_fragment_association',
          signals: [
            ...(overlap ? ['spatial_overlap' as const] : []),
            'similar_color',
            'aligned_direction',
            ...(near ? ['near_crop_exit' as const] : []),
          ],
          status: 'unverified',
        });
    }
  const report: RecoveryReport = {
    version: 'wire-coverage-v1',
    reportId,
    sourceSnapshotId: ref.samSnapshotId,
    sourceSnapshotHash: ref.samSnapshotHash,
    imageHash: ref.imageHash,
    image,
    auditScale: info.width / image.width,
    candidates,
    quarantinedCandidates: snapshot.candidates
      .filter((c) => quarantineReason(c))
      .map((c) => ({ id: c.id, reason: quarantineReason(c)! })),
    summary: {
      rawSamCandidates: snapshot.candidates.filter(
        (c) => c.type === 'jumper_wire',
      ).length,
      geometryAccepted: candidates.filter(
        (c) => c.source !== 'cv_trace' && c.geometryAccepted,
      ).length,
      cvTraces: cv.candidates.length,
      uncoveredTraces: cv.candidates.filter((c) => c.candidateCoverage < 0.8)
        .length,
      unverifiedTraces: cv.candidates.filter((c) => c.verifiedCoverage < 0.8)
        .length,
      truncated: truncated || cv.truncated,
    },
    cropRegions: selectRecoveryTiles(candidates, image),
    stopReason: 'audit_only',
    modelReviews: [],
    hypotheses,
  };
  report.reviewReconciliation = previous
    ? reconcileWireReviews(previous, report, reviews)
    : [];
  if (previous?.reportId === report.reportId) {
    report.modelReviews = previous.modelReviews;
    if (previous.extensionReviews)
      report.extensionReviews = previous.extensionReviews;
  }
  const verifiedIds = new Set(
    effectiveIdentityReviews(reviews, report)
      .filter((r) => r.state === 'verified')
      .flatMap((r) => r.candidateIds),
  );
  let verifiedPixels = 0;
  for (const c of raw) {
    const m = c.encodedMask;
    if (
      !m ||
      !verifiedIds.has(c.id) ||
      !candidates.find((n) => n.id === c.id)?.evidenceHash ||
      verifiedPixels + m.width * m.height > 12000000
    )
      continue;
    verifiedPixels += m.width * m.height;
    try {
      const raster = decodeMaskToRaster(m);
      for (let y = 0; y < m.height; y++)
        for (let x = 0; x < m.width; x++)
          if (raster[y * m.width + x]) {
            const gx = Math.min(
              info.width - 1,
              Math.floor(
                ((c.bbox[0] + ((x + 0.5) * c.bbox[2]) / m.width) * info.width) /
                  image.width,
              ),
            );
            const gy = Math.min(
              info.height - 1,
              Math.floor(
                ((c.bbox[1] + ((y + 0.5) * c.bbox[3]) / m.height) *
                  info.height) /
                  image.height,
              ),
            );
            verified[gy * info.width + gx] = 1;
          }
    } catch {
      verifiedIds.delete(c.id);
    }
  }
  for (const c of candidates)
    c.verifiedCoverage =
      c.source === 'cv_trace'
        ? verifiedIds.has(c.id)
          ? 1
          : c.points.filter((p) => hit(verified, p)).length /
            Math.max(1, c.points.length)
        : verifiedIds.has(c.id) && c.evidenceHash
          ? 1
          : 0;
  report.summary.unverifiedTraces = cv.candidates.filter(
    (c) => c.verifiedCoverage < 0.8,
  ).length;
  return recoveryReportSchema.parse(report);
}
