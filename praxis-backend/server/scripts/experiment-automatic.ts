import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareSceneCrop } from '../src/services/scene.js';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs/store.js';
import { ConnectorWorkflowService } from '../src/jobs/connector-workflow.js';

const [mode, id, output, reviewsPath] = process.argv.slice(2);
if (
  !mode ||
  !id ||
  !['prepare-replacement', 'evaluate', 'release', 'export'].includes(mode) ||
  (mode !== 'release' && !output)
) {
  console.error(
    'Usage: npm run experiment:automatic -- evaluate WORKFLOW_ID NEW_OUTPUT.json [IDENTITY_REVIEWS.json]\nOr: npm run experiment:automatic -- prepare-replacement ORIGINAL_WORKFLOW_ID NEW_DIRECTORY [FROZEN_REFERENCE.json]\nOr: npm run experiment:automatic -- release WORKFLOW_ID\nOr: npm run experiment:automatic -- export WORKFLOW_ID NEW_OUTPUT.json\nPreparation and execution use experiment:connector prepare-auto/run. These commands send zero inference.',
  );
  process.exitCode = 1;
} else {
  const store = new JobStore(loadConfig()),
    service = new ConnectorWorkflowService(store);
  try {
    if (mode === 'prepare-replacement') {
      const prior = service.get(id),
        source = store.get(prior.contract.plan.analysisId);
      mkdirSync(output!, { mode: 0o700 });
      const next = await service.prepare(source.analysisId, {
        objectId: prior.contract.plan.objectId,
        ...(prior.contract.version === 'automatic-connector-workflow-v2'
          ? { targetingVersion: 'v2' }
          : {}),
        snapshotId: source.scene?.snapshotRef?.snapshotId,
        snapshotHash: source.scene?.snapshotRef?.snapshotHash,
        replacementOf: id,
        authorizeReplacement: true,
        ...(reviewsPath
          ? { reference: JSON.parse(readFileSync(reviewsPath, 'utf8')) }
          : {}),
      });
      writeFileSync(
        join(output!, 'workflow.json'),
        JSON.stringify({ workflowId: next.workflowId }, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      writeFileSync(
        join(output!, 'plan.json'),
        JSON.stringify(next.contract.plan, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      const image = store.getSnapshot(
        next.contract.plan.samSnapshotRef.samSnapshotId,
      ).snapshot.image;
      for (const variant of next.contract.plan.variants)
        writeFileSync(
          join(output!, variant.name + '.jpg'),
          await prepareSceneCrop(image, variant.crop),
          { flag: 'wx', mode: 0o600 },
        );
      console.log(
        'Prepared a linked replacement with a new authorization identity. No inference sent. Review the plan before execution.',
      );
    } else if (mode === 'release') {
      service.release(id);
      console.log(
        'Released ownership. Unknown usage and charges remain retained; the original plan cannot run again.',
      );
    } else {
      const result =
        mode === 'evaluate'
          ? service.evaluate(
              id,
              reviewsPath ? JSON.parse(readFileSync(reviewsPath, 'utf8')) : [],
            )
          : service.evidence(id, service.get(id).contract.plan.analysisId);
      writeFileSync(output!, JSON.stringify(result, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      console.log('Saved offline experiment evidence. No inference sent.');
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Experiment operation failed.',
    );
    process.exitCode = 1;
  } finally {
    await service.close();
    store.close();
  }
}
