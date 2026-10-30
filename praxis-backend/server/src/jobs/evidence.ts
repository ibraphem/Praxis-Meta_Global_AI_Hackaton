import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AppError } from '../lib/errors.js';
import type { JobStore } from './store.js';

/** Offline evidence archive, distinct from the browser's calibration/review evaluation bundle. */
export function exportJobEvidence(
  store: JobStore,
  analysisId: string,
  outputDirectory: string,
  attachments: { bundle?: string; truth?: string } = {},
) {
  const evidence = store.transaction(() => ({
    job: store.get(analysisId),
    image: store.image(analysisId),
    snapshots: store.snapshots(analysisId),
    experiments: store.experiments.forAnalysis(analysisId),
  }));
  const extras: {
    path: string;
    bytes: Buffer;
    binding: 'identity_fields_checked' | 'unverified_external_annotations';
  }[] = [];
  for (const [key, path] of Object.entries(attachments)) {
    if (!path) continue;
    const bytes = readFileSync(path),
      parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new AppError(
        400,
        'INVALID_EVIDENCE_ATTACHMENT',
        'Evidence attachments must contain a JSON object.',
      );
    if (
      parsed.imageHash !== undefined &&
      parsed.imageHash !== evidence.job.imageHash
    )
      throw new AppError(
        409,
        'EVIDENCE_IMAGE_MISMATCH',
        'The annotation image hash does not match this analysis.',
      );
    if (
      parsed.analysisRunId !== undefined &&
      ![
        evidence.job.analysisId,
        evidence.job.revision,
        ...evidence.job.muse.attempts.map((a) => a.attemptId),
        ...evidence.snapshots.map((s) => s.ref.samSnapshotId),
      ].includes(parsed.analysisRunId as string)
    )
      throw new AppError(
        409,
        'EVIDENCE_RUN_MISMATCH',
        'The annotation run identity does not match this analysis.',
      );
    extras.push({
      path: key === 'truth' ? 'ground-truth.json' : 'evaluation-bundle.json',
      bytes,
      binding:
        parsed.imageHash !== undefined || parsed.analysisRunId !== undefined
          ? 'identity_fields_checked'
          : 'unverified_external_annotations',
    });
  }
  // Exclusive directory creation and file creation: no prior report, photo, or annotation is overwritten.
  mkdirSync(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  mkdirSync(outputDirectory, { mode: 0o700 });
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const write = (path: string, bytes: Buffer) => {
    writeFileSync(join(outputDirectory, path), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    files.push({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  };
  const json = (value: unknown) =>
    Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const { snapshot: _payload, ...sam } = evidence.job.sam;
  void _payload;
  write('job.json', json({ ...evidence.job, sam }));
  const format =
    evidence.image[0] === 0xff
      ? 'jpg'
      : evidence.image.toString('ascii', 0, 4) === 'RIFF'
        ? 'webp'
        : 'png';
  write(`photograph.${format}`, evidence.image);
  mkdirSync(join(outputDirectory, 'snapshots'), { mode: 0o700 });
  evidence.snapshots.forEach((record, i) =>
    write(`snapshots/${i + 1}.json`, json(record)),
  );
  mkdirSync(join(outputDirectory, 'experiments'), { mode: 0o700 });
  evidence.experiments.forEach((record, i) =>
    write(`experiments/${i + 1}.json`, json(record)),
  );
  extras.forEach((file) => write(file.path, file.bytes));
  const manifest = {
    schemaVersion: 1,
    kind: 'praxis-job-evidence',
    analysisId,
    imageHash: evidence.job.imageHash,
    exportedAt: Date.now(),
    snapshots: evidence.snapshots.map((record) => record.ref),
    attachments: extras.map(({ path, binding }) => ({
      path,
      binding,
      source: 'user_supplied',
    })),
    files,
    note: 'This archive survives job-store retention. Calibration/reviews and independent ground truth are included only when explicitly supplied; no model prediction is promoted into ground truth.',
  };
  writeFileSync(join(outputDirectory, 'manifest.json'), json(manifest), {
    flag: 'wx',
    mode: 0o600,
  });
  return manifest;
}
