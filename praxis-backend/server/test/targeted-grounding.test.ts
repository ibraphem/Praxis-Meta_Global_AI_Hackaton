import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import {
  maskFixture,
  imageBytes,
  testConfig,
  completion,
  samEnvelope,
} from './helpers.js';
import { samWireRecord } from './helpers.js';
import { cropFragment } from '../src/services/wire-fragments.js';
import {
  reprojectCrop,
  createWireRecovery,
} from '../src/services/wire-recovery.js';
import { prepareImage } from '../src/services/image.js';
import { auditWireCoverage } from '../src/services/wire-coverage.js';
import { shortWireRegions } from '../src/services/short-wire-recovery.js';
import { snapshotHash, type SnapshotRef } from '../src/jobs/snapshots.js';
import { createEndpointProposalService } from '../src/services/endpoint-proposals.js';
import { JobStore } from '../src/jobs/store.js';
import { admittedClient } from '../src/jobs/model-admission.js';
import {
  boundedMap,
  runEndpointExperiment,
} from '../src/jobs/endpoint-experiment.js';
import { partialAnalysis } from '../src/services/partial-analysis.js';
import type { SamSnapshot } from '../src/services/vision.js';
import type { MetaClient } from '../src/lib/meta-client.js';
const wire = {
  id: 'jumper_wire_1',
  bbox: [200, 100, 200, 100],
  mask: {
    format: 'svg_path',
    width: 20,
    height: 20,
    path: 'M0 0L20 0L20 2L0 2Z',
  },
};
const context = {
  analysisId: 'analysis',
  imageId: 'image',
  image: { width: 800, height: 600 },
  wire,
  gridPoints: [
    [200, 100],
    [220, 100],
    [240, 100],
    [260, 100],
    [280, 100],
  ],
};
const endpoints = [
  {
    role: 'A',
    proposedImagePosition: [40, 40],
    connectorJunctionPosition: null,
    evidence: 'visible_insertion',
  },
  {
    role: 'B',
    proposedImagePosition: null,
    connectorJunctionPosition: [150, 70],
    evidence: 'occluded_insertion',
  },
];
function ref(snapshot: SamSnapshot): SnapshotRef {
  const context = {
    imageHash: 'a'.repeat(64),
    model: 'sam',
    processingVersion: 'test',
  };
  return {
    ...context,
    samSnapshotId: crypto.randomUUID(),
    sourceAttemptId: crypto.randomUUID(),
    samSnapshotHash: snapshotHash(snapshot, context),
    origin: 'recorded',
    createdAt: 1,
  };
}

test('crop edges remain distinct from photograph edges and insertion proposals are blocked without a provider call', async () => {
  const [c] = reprojectCrop(
    [
      {
        id: 'jumper_wire_1',
        type: 'jumper_wire',
        bbox: [0, 0, 20, 20],
        encodedMask: maskFixture('wire'),
      },
    ],
    [100, 100, 20, 20],
    1,
  );
  const fragment = cropFragment(c!);
  assert.equal(fragment.touchesCropBoundary, true);
  assert.ok(fragment.cropExitPoints.length > 0);
  assert.deepEqual(fragment.cropOrigin, [100, 100, 20, 20]);
  let calls = 0;
  const response = await createEndpointProposalService(testConfig(), {
    async post() {
      calls++;
      throw new Error('No call');
    },
  })(await imageBytes(800, 600), new AbortController().signal, undefined, {
    ...context,
    wire: {
      ...wire,
      touchesCropBoundary: true,
      cropOrigin: [100, 100, 20, 20],
    },
  });
  assert.equal(calls, 0);
  assert.equal(response.localization!.status, 'crop_fragment');
  assert.ok(response.endpoints.every((e) => e.proposedImagePosition === null));
});

test('short recovery scans native local evidence and uses spatial prompts while preserving original masks', async () => {
  const rgb = Buffer.alloc(400 * 300 * 3, 255);
  for (let x = 140; x < 165; x++)
    for (let y = 120; y < 123; y++) {
      const i = (y * 400 + x) * 3;
      rgb[i] = 210;
      rgb[i + 1] = 20;
      rgb[i + 2] = 20;
    }
  const bytes = await sharp(rgb, {
    raw: { width: 400, height: 300, channels: 3 },
  })
    .png()
    .toBuffer();
  const snapshot: SamSnapshot = {
      image: await prepareImage(bytes, testConfig()),
      candidates: [],
    },
    reference = ref(snapshot),
    report = await auditWireCoverage(snapshot, reference);
  const regions = await shortWireRegions(snapshot, report, {
    pitchPx: 10,
    gridPoints: [[150, 121]],
  });
  assert.ok(regions.length > 0);
  assert.ok(
    regions.every((r) => r.crop[2] <= 512 && r.positivePoints.length > 0),
  );
  let calls = 0;
  const before = JSON.stringify(snapshot);
  const result = await createWireRecovery(testConfig(), {
    async post(_path, body, _signal, op) {
      calls++;
      assert.equal(op!.maxRetries, 0);
      const prompt = (body.input as { content: { text: string }[] }[])[0]!
        .content[0]!.text;
      assert.match(prompt, /^<0f>1<\|box;/);
      assert.doesNotMatch(prompt, /^wire$/);
      return samEnvelope('');
    },
  })(
    {
      snapshot,
      ref: reference,
      reviews: [],
      budget: { requests: 0, pixels: 0, verificationRequests: 0, rounds: 0 },
      visited: [],
      operation: 'recover_short',
      target: { pitchPx: 10, gridPoints: [], manualPoint: [150, 121] },
    },
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(result.cropAttempts[0]!.mode, 'human');
  assert.equal(result.cropAttempts[0]!.status, 'succeeded');
  assert.equal(JSON.stringify(snapshot), before);
});

test('two-stage localization uses one extra request and preserves coarse and revised coordinates with separate frames', async () => {
  let calls = 0;
  const client: MetaClient = {
    async post(_path, _body, _signal, op) {
      calls++;
      assert.equal(op!.maxRetries, 0);
      assert.equal(
        op!.stage,
        calls === 1 ? 'muse.endpoints' : 'muse.insertion_closeups',
      );
      return completion({
        endpoints:
          calls === 1
            ? endpoints
            : [
                endpoints[0],
                {
                  ...endpoints[1],
                  connectorJunctionPosition: null,
                  evidence: 'insufficient',
                },
              ],
      });
    },
  };
  const result = await createEndpointProposalService(testConfig(), client)(
    await imageBytes(800, 600),
    new AbortController().signal,
    undefined,
    { ...context, view: 'endpoint_crops' },
  );
  assert.equal(calls, 2);
  assert.equal(result.localization!.status, 'completed');
  assert.equal(result.inputVariant, 'endpoint_crops');
  assert.equal(result.localization!.frames.length, 2);
  assert.equal(result.endpoints[1].proposedImagePosition, null);
  assert.notDeepEqual(
    result.endpoints[0].proposedImagePosition,
    result.localization!.coarseEndpoints[0].proposedImagePosition,
  );
  assert.deepEqual(result.endpoints[0].sourceCoordinates, [40, 40]);
});

test('a spatial response that misses the selected seed is retained as rejected evidence rather than a selectable wire', async () => {
  const snapshot: SamSnapshot = {
      image: await prepareImage(await imageBytes(400, 300), testConfig()),
      candidates: [],
    },
    reference = ref(snapshot);
  const result = await createWireRecovery(testConfig(), {
    async post(_path, _body, _signal, op) {
      const d = op!.imageDimensions![0]!;
      return samEnvelope(
        samWireRecord('wire', 1).replace(
          'w=100;h=80',
          `w=${d.width};h=${d.height}`,
        ),
      );
    },
  })(
    {
      snapshot,
      ref: reference,
      reviews: [],
      budget: { requests: 0, pixels: 0, verificationRequests: 0, rounds: 0 },
      visited: [],
      operation: 'recover_short',
      target: { pitchPx: 10, gridPoints: [], manualPoint: [150, 121] },
    },
    new AbortController().signal,
    undefined,
    (value) => (value.changed ? ref(value.snapshot) : undefined),
  );
  assert.equal(result.snapshot.candidates.length, 1);
  assert.ok(
    result.report.candidates[0]!.rejectionReasons.includes('prompt_mismatch'),
  );
  assert.equal(result.report.candidates[0]!.geometryAccepted, false);
  assert.deepEqual(result.cropAttempts[0]!.spatialPrompt!.positivePoints, [
    [150, 121],
  ]);
});

test('failed close-up refinement cannot quietly promote its coarse point or start automatic retries', async () => {
  let calls = 0;
  const result = await createEndpointProposalService(testConfig(), {
    async post() {
      calls++;
      if (calls === 1) return completion({ endpoints });
      throw new Error('failure');
    },
  })(await imageBytes(800, 600), new AbortController().signal, undefined, {
    ...context,
    view: 'endpoint_crops',
  });
  assert.equal(calls, 2);
  assert.equal(result.localization!.status, 'failed');
  assert.ok(result.localization!.coarseEndpoints[0].proposedImagePosition);
  assert.ok(result.endpoints.every((e) => e.proposedImagePosition === null));
});

test('normalized grounding converts through the actual cropped frame and rejects out-of-contract coordinates', async () => {
  const result = await createEndpointProposalService(testConfig(), {
    async post() {
      return completion({
        endpoints: [
          { ...endpoints[0], proposedImagePosition: [500, 500] },
          {
            ...endpoints[1],
            connectorJunctionPosition: null,
            evidence: 'insufficient',
          },
        ],
      });
    },
  })(await imageBytes(800, 600), new AbortController().signal, undefined, {
    ...context,
    view: 'candidate_crop',
    coordinateSpace: 'normalized_1000',
  });
  const frame = result.inputFrame!;
  assert.deepEqual(result.endpoints[0].proposedImagePosition, [
    frame.bbox[0] + frame.bbox[2] / 2,
    frame.bbox[1] + frame.bbox[3] / 2,
  ]);
  assert.deepEqual(result.endpoints[0].sourceCoordinates, [500, 500]);
  await assert.rejects(
    () =>
      createEndpointProposalService(testConfig(), {
        async post() {
          return completion({
            endpoints: [
              { ...endpoints[0], proposedImagePosition: [1000, 500] },
              endpoints[1],
            ],
          });
        },
      })(imageBytesBuffer, new AbortController().signal, undefined, {
        ...context,
        coordinateSpace: 'normalized_1000',
      }),
    /expected|invalid/i,
  );
});
let imageBytesBuffer: Buffer;
test.before(async () => {
  imageBytesBuffer = await imageBytes(800, 600);
});

test('shared Muse admission bounds independent request producers and releases capacity', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  let active = 0,
    maximum = 0;
  const base: MetaClient = {
    async post() {
      active++;
      maximum = Math.max(maximum, active);
      await delay(30);
      active--;
      return {};
    },
  };
  const a = admittedClient(store, undefined, base),
    b = admittedClient(store, undefined, base),
    signal = new AbortController().signal;
  await Promise.all([
    a.post('chat/completions', {}, signal, { stage: 'muse.endpoints' }),
    b.post('chat/completions', {}, signal, { stage: 'muse.interpret' }),
    a.post('chat/completions', {}, signal, { stage: 'muse.wire_verify' }),
  ]);
  assert.equal(maximum, 2);
  assert.equal(
    Number(
      store.db.prepare('SELECT COUNT(*) AS n FROM model_requests').get()!.n,
    ),
    0,
  );
});

test('bounded parallel batches wait for in-flight work to settle even when one operation fails', async () => {
  let completed = false;
  await assert.rejects(
    () =>
      boundedMap([0, 1], 2, async (value) => {
        if (!value) throw new Error('first');
        await delay(20);
        completed = true;
      }),
    /first/,
  );
  assert.equal(completed, true);
});

test('a late provider response cannot publish after its local admission lease has expired', async (t) => {
  const store = new JobStore(testConfig(), ':memory:');
  t.after(() => store.close());
  let release!: (value: unknown) => void,
    entered = false;
  const client = admittedClient(store, undefined, {
    async post() {
      entered = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const pending = client.post(
    'chat/completions',
    {},
    new AbortController().signal,
    { stage: 'muse.endpoints' },
  );
  while (!entered) await delay(1);
  store.db.prepare('UPDATE model_requests SET lease_until=0').run();
  release({});
  await assert.rejects(() => pending, /ownership was lost/);
  assert.equal(
    Number(
      store.db.prepare('SELECT COUNT(*) AS n FROM model_requests').get()!.n,
    ),
    0,
  );
});

test('controlled endpoint experiment binds derived evidence, reserves live admission, and leaves the original analysis intact', async (t) => {
  const config = testConfig(),
    store = new JobStore(config, ':memory:');
  t.after(() => store.close());
  const image = await prepareImage(imageBytesBuffer, config),
    job = store.create(imageBytesBuffer, image);
  const snapshot = { image, candidates: [] };
  job.sam.status = 'succeeded';
  job.sam.attempts[0]!.status = 'succeeded';
  job.sam.snapshot = snapshot;
  job.sam.result = partialAnalysis(snapshot, config);
  job.status = 'partial';
  store.save(job);
  const original = JSON.stringify(store.get(job.analysisId));
  const bundle = {
    schemaVersion: 'praxis-evaluation-v1',
    image: { id: 'photo', sha256: job.imageHash },
    analysisRunId: 'run',
    analysis: {
      image: { width: 800, height: 600 },
      objects: [
        {
          ...wire,
          type: 'jumper_wire',
          interpretation: 'uncertain',
          localizationSource: 'sam',
          geometryStatus: 'segmented',
          guidanceEligible: false,
          identityStatus: 'unverified',
        },
      ],
      provenance: {
        mode: 'combined',
        reasoningModel: config.META_REASONING_MODEL,
        segmentationModel: config.META_SAM_MODEL,
        samSnapshotId: job.sam.snapshotRef!.samSnapshotId,
        samSnapshotHash: job.sam.snapshotRef!.samSnapshotHash,
      },
    },
    boards: [
      {
        revision: 1,
        calibration: { rows: 30, forward: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      },
    ],
    reviews: [
      {
        proposal: {
          analysisId: 'run',
          imageId: 'photo',
          calibrationRevisions: {},
          endpoints: [
            {
              proposedImagePosition: [240, 140],
              evidence: 'visible_insertion',
            },
            { proposedImagePosition: null, evidence: 'insufficient' },
          ],
          wireCandidateId: 'jumper_wire_1',
        },
      },
    ],
  };
  let calls = 0;
  const report = await runEndpointExperiment(
    store,
    job.analysisId,
    Buffer.from(JSON.stringify(bundle)),
    {
      variants: ['full', 'candidate_crop'],
      runs: 1,
      concurrency: 2,
      coordinateSpace: 'pixels',
      signal: new AbortController().signal,
    },
    {
      async post() {
        calls++;
        return completion({ endpoints });
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(report.status, 'completed');
  assert.equal(report.measurements.length, 2);
  assert.equal(JSON.stringify(store.get(job.analysisId)), original);
  assert.equal(store.experiments.active(), undefined);
});
