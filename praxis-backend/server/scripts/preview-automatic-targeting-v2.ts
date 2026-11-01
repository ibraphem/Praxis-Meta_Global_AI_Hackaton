import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs/store.js';
import { prepareAutomaticConnectorExperiment } from '../src/jobs/scene-connector-experiment.js';
import { prepareSceneCrop } from '../src/services/scene.js';
const [analysisId, objectId, directory] = process.argv.slice(2);
if (!analysisId || !objectId || !directory || process.argv.length !== 5)
  throw Error(
    'Usage: npm run scene:preview-targeting-v2 -- ANALYSIS_ID OBJECT_ID NEW_DIRECTORY. Offline only: no workflow admission, SAM or Muse calls.',
  );
const store = new JobStore(loadConfig());
try {
  const startedAt = Date.now(),
    plan = await prepareAutomaticConnectorExperiment(
      store,
      analysisId,
      objectId,
      'v2',
    );
  mkdirSync(directory, { mode: 0o700 });
  const write = (name: string, data: unknown) =>
    writeFileSync(join(directory, name), JSON.stringify(data, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  write('plan.json', plan);
  write('preview.json', {
    schemaVersion: 'praxis-automatic-targeting-preview-v2',
    analysisId,
    objectId,
    planHash: plan.planHash,
    elapsedMs: Date.now() - startedAt,
    additionalSamRequests: 0,
    additionalMuseRequests: 0,
    registeredWorkflow: false,
    segmentationQuality: 'not_evaluated',
    gate: 'unchanged',
    note: 'Offline proposal only. Original RGB crop and original broad SAM pixels were used. No annotation/reference, manual profile or experiment prediction was used for targeting. Run requires registration, qualifying independent evaluation and exact inference authorization through the existing workflow service.',
  });
  const image = store.getSnapshot(plan.samSnapshotRef.samSnapshotId).snapshot
    .image;
  for (const v of plan.variants)
    writeFileSync(
      join(directory, v.name + '.jpg'),
      await prepareSceneCrop(image, v.crop),
      { flag: 'wx', mode: 0o600 },
    );
  console.log(
    JSON.stringify({
      directory,
      plannedRequests: plan.variants.length,
      plannedPixels: plan.totalPixels,
      additionalInferenceRequests: 0,
      pointStatus: plan.automaticTargeting?.pointStatus,
      body:
        plan.automaticTargeting?.version === 'automatic-targeting-v2'
          ? plan.automaticTargeting.diagnostics.bodyProposal
          : undefined,
    }),
  );
} finally {
  store.close();
}
