import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { snapshotHash, type SnapshotRecord } from '../src/jobs/snapshots.js';
import { auditWireCoverage } from '../src/services/wire-coverage.js';

const usage =
  'Usage: npm run wire:audit -- EXPORTED_SNAPSHOT.json NEW_OUTPUT_DIRECTORY\nOffline only: no database writes or model calls. Creates report.json, overlay.png, and empty annotation templates; refuses to overwrite output.';
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log(usage);
  else {
    if (args.length !== 2) throw new Error(usage);
    const record = JSON.parse(readFileSync(args[0]!, 'utf8')) as SnapshotRecord;
    if (
      !record.ref ||
      !record.snapshot ||
      snapshotHash(record.snapshot, record.ref) !== record.ref.samSnapshotHash
    )
      throw new Error('The frozen snapshot failed its integrity check.');
    const report = await auditWireCoverage(record.snapshot, record.ref);
    const shapes = report.candidates
      .map((c) =>
        c.mask
          ? `<g transform="translate(${c.bbox[0]} ${c.bbox[1]}) scale(${c.bbox[2] / c.mask.width} ${c.bbox[3] / c.mask.height})"><path d="${c.mask.path}" fill="#f59e0b" fill-opacity=".15" stroke="#f59e0b" vector-effect="non-scaling-stroke"/></g>`
          : `<polyline points="${c.points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${c.candidateCoverage < 0.8 ? '#ff409d' : '#38bdf8'}" stroke-width="3"/>`,
      )
      .join('');
    const png = await sharp(
      Buffer.from(record.snapshot.image.dataUrl.split(',')[1]!, 'base64'),
    )
      .composite([
        {
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${report.image.width}" height="${report.image.height}">${shapes}</svg>`,
          ),
        },
      ])
      .png()
      .toBuffer();
    mkdirSync(dirname(args[1]!), { recursive: true, mode: 0o700 });
    mkdirSync(args[1]!, { mode: 0o700 });
    const write = (name: string, value: unknown) =>
      writeFileSync(
        join(args[1]!, name),
        JSON.stringify(value, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    write('report.json', report);
    writeFileSync(join(args[1]!, 'overlay.png'), png, {
      flag: 'wx',
      mode: 0o600,
    });
    write('truth-template.json', {
      version: 'wire-truth-v1',
      imageHash: record.ref.imageHash,
      recordedBeforeInference: false,
      completeInventory: false,
      wires: [],
    });
    write('evaluation-template.json', {
      version: 'wire-evaluation-v1',
      imageHash: record.ref.imageHash,
      reportId: report.reportId,
      sourceSnapshotHash: report.sourceSnapshotHash,
      groups: report.candidates.map((c) => ({
        candidateIds: [c.id],
        truthWireId: null,
        matchKind: 'clutter',
        identityAccepted: false,
        endpoints: [
          { holeId: null, position: null, accepted: false },
          { holeId: null, position: null, accepted: false },
        ],
      })),
    });
    console.table(report.summary);
    console.log('Native SAM rejection diagnostics (reasons can overlap):');
    console.table(
      Object.entries(
        report.candidates
          .filter((c) => c.source !== 'cv_trace')
          .flatMap((c) => c.rejectionReasons)
          .reduce<Record<string, number>>(
            (out, r) => ((out[r] = (out[r] ?? 0) + 1), out),
            {},
          ),
      ).map(([reason, count]) => ({ reason, count })),
    );
    console.log(
      'Audit saved. Trace counts are hypotheses, not measured wire recall. Record independent ground truth before inspecting model output; do not relabel post-hoc annotations as a blinded baseline.',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Wire audit failed.');
  process.exitCode = 1;
}
