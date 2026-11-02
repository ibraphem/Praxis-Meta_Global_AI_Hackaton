import { format } from 'prettier';
/** Offline synthetic regression demonstration. Never opens a saved user job or a provider client. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { syntheticNightLight } from '../test/fixtures/night-light.js';
import {
  buildConnectivity,
  compareConnectivity,
} from '../src/services/connectivity.js';
import { JobStore, publicJob } from '../src/jobs/store.js';
import {
  ConnectivityService,
  connectivityPerceptionHash,
} from '../src/jobs/connectivity.js';
import { testConfig } from '../test/helpers.js';
import { prepareImage } from '../src/services/image.js';
import { analysisSchema } from '../src/schemas/vision.js';
const dir =
  process.argv[2] ?? 'benchmark-evidence/connectivity-synthetic-2026-11-02';
mkdirSync(dir, { recursive: true });
const good = syntheticNightLight(),
  bad = syntheticNightLight(true);
const control = compareConnectivity(
  buildConnectivity(good.input),
  good.reference,
  good.mapping,
);
const fault = compareConnectivity(
  buildConnectivity(bad.input),
  bad.reference,
  bad.mapping,
);
if (
  control.findings[0]!.status !== 'no_fault' ||
  fault.findings[0]!.status !== 'confirmed_fault'
)
  throw Error('Synthetic diagnosis regression failed.');
const config = testConfig(),
  store = new JobStore(config, ':memory:');
try {
  const svg = `<svg width="640" height="900"><rect width="640" height="900" fill="#f7f5ec"/><text x="28" y="35" font-size="20">SYNTHETIC connectivity fixture</text><rect x="60" y="70" width="440" height="740" rx="12" fill="#ddd" stroke="#777"/>${Array.from({ length: 30 }, (_, y) => Array.from({ length: 10 }, (_, x) => `<circle cx="${100 + (x < 5 ? x : x + 2) * 30}" cy="${100 + (y * 660) / 29}" r="3" fill="#555"/>`).join('')).join('')}<path d="M130 ${100 + (11 * 660) / 29} Q265 240 340 ${100 + (12 * 660) / 29}" fill="none" stroke="#1377be" stroke-width="7"/><text x="105" y="850" font-size="17">Abstract named transistor ports; no physical pinout</text></svg>`;
  const bytes = await sharp(Buffer.from(svg)).jpeg().toBuffer(),
    job = store.create(bytes, await prepareImage(bytes, config));
  job.sam.status = 'failed';
  job.sam.attempts.forEach((a) => (a.status = 'failed'));
  job.status = 'failed';
  store.save(job);
  bad.input.analysisId = job.analysisId;
  bad.input.imageHash = job.imageHash;
  const workspace = {
    boards: bad.input.boards.map((b) => ({
      calibration: b.calibration,
      rails: b.rails,
      revision: b.revision,
    })),
    assignments: [],
    reviews: [],
    photoId: job.imageHash,
    analysisRunId: job.analysisId,
  };
  store.db.prepare('INSERT INTO connectivity_sources VALUES (?,?)').run(
    job.analysisId,
    JSON.stringify({
      input: bad.input,
      workspace,
      sourceSceneHash: null,
      sourceAnalysisRevision: job.revision,
      sourcePerceptionHash: connectivityPerceptionHash(job),
    }),
  );
  const service = new ConnectivityService(store);
  service.build(job.analysisId, { expectedRevision: 1 });
  let view = service.registerReference(job.analysisId, {
    expectedRevision: 1,
    reviewer: 'synthetic_fixture',
    reason:
      'Synthetic abstract schematic and identity mapping, not real-photo evidence.',
    reference: bad.reference,
    mapping: bad.mapping,
  });
  view = service.compare(job.analysisId, {
    expectedRevision: 1,
    referenceId: view.references[0]!.id,
  });
  const corrected = service.review(job.analysisId, {
    expectedRevision: 1,
    reviewer: 'synthetic_browser',
    reason:
      'Synthetic correction to an equivalent hole on the required collector strip.',
    action: 'association',
    targetId: 'insert:jumper:b',
    value: {
      terminalId: 'jumper:b',
      target: {
        kind: 'hole',
        boardId: 'board_1',
        holeId: 'j12',
        calibrationRevision: 1,
      },
      type: 'insertion',
      decision: 'confirmed_manual',
    },
  });
  const rebuilt = service.build(job.analysisId, { expectedRevision: 2 });
  const compared = service.compare(job.analysisId, {
    expectedRevision: 2,
    referenceId: view.references[0]!.id,
  });
  const publicAnalysis = {
    ...publicJob(store.get(job.analysisId)),
    status: 'completed',
    result: analysisSchema.parse({
      image: job.image,
      objects: [],
      provenance: {
        mode: 'combined',
        reasoningModel: 'synthetic',
        segmentationModel: 'synthetic',
      },
    }),
  };
  const output = {
    evidence: service.evidence(job.analysisId),
    fixtureScope:
      'SYNTHETIC ONLY. Logical schematic and invented placements. No real photo, physical transistor pin order, provider inference, or Phase 5A physical acceptance.',
    job: publicAnalysis,
    view,
    corrected,
    rebuilt,
    compared,
    reference: { reference: bad.reference, mapping: bad.mapping },
  };
  writeFileSync(
    new URL(
      '../../../praxis-frontend/test/fixtures/connectivity.json',
      import.meta.url,
    ),
    JSON.stringify(output, null, 2) + '\n',
  );
  writeFileSync(
    new URL(
      '../../../praxis-frontend/test/fixtures/connectivity.jpg',
      import.meta.url,
    ),
    bytes,
  );
  const save = (file: string, value: unknown) =>
    writeFileSync(join(dir, file), JSON.stringify(value, null, 2) + '\n');
  save('correct-control.json', {
    input: good.input,
    reference: good.reference,
    mapping: good.mapping,
    graph: buildConnectivity(good.input),
    comparison: control,
  });
  save('misplaced-jumper.json', {
    input: bad.input,
    reference: bad.reference,
    mapping: bad.mapping,
    view,
  });
  save('reference-night-light.synthetic.json', output.reference);
  writeFileSync(join(dir, 'photograph.synthetic.jpg'), bytes);
  save('evaluation-bundle.json', {
    schemaVersion: 'praxis-connectivity-evaluation-v1',
    validationScope: 'synthetic_fixture',
    source: {
      analysisId: job.analysisId,
      imageHash: job.imageHash,
      image: job.image,
      photograph: 'photograph.synthetic.jpg',
    },
    topology: bad.input.boards,
    originalAssociations: bad.input.associations,
    reference: bad.reference,
    mapping: bad.mapping,
    evidence: service.evidence(job.analysisId),
    testResults: {
      correctControl: control.findings[0]!.status,
      misplacedJumper: view.comparisons[0]!.comparison.findings[0]!.status,
      afterCorrection:
        compared.comparisons.at(-1)!.comparison.findings[0]!.status,
    },
    manualIntervention:
      'Invented logical ports and board placements, simulated confirmations and one simulated correction. No real transistor package or physical connections asserted.',
    additionalSamRequests: 0,
    additionalMuseRequests: 0,
    physicalPhase5AAcceptance: 'pending_verified_real_demo_inputs',
  });
  mkdirSync('fixtures', { recursive: true });
  writeFileSync(
    'fixtures/reference-night-light.synthetic.json',
    await format(JSON.stringify(output.reference.reference), {
      parser: 'json',
    }),
  );
  save('result.json', {
    schemaVersion: 'praxis-connectivity-synthetic-evaluation-v1',
    validationScope: 'synthetic_fixture',
    control: control.findings[0]!.status,
    misplacedJumper: view.comparisons[0]!.comparison.findings[0]!.status,
    additionalSamRequests: 0,
    additionalMuseRequests: 0,
    physicalPhase5AAcceptance: 'pending_verified_real_demo_inputs',
  });
  console.log(
    'Synthetic control and misplaced-jumper diagnosis passed. No live inference or real-analysis modifications.',
  );
} finally {
  store.close();
}
