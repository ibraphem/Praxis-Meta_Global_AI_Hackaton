import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sceneGraphSchema } from '../src/schemas/scene.js';
import {
  sceneReviewSchema,
  sceneTruthSchema,
  scoreScene,
} from '../src/services/scene-evaluation.js';
import type { Job } from '../src/jobs/store.js';
import type { SceneSnapshot } from '../src/jobs/scene-snapshots.js';

try {
  const args = process.argv.slice(2);
  const bindingsOnly = args[0] === '--bindings';
  if (
    bindingsOnly
      ? args.length < 2 || args.length > 3
      : args.length < 4 || args.length > 5
  )
    throw new Error(
      'Usage: npm run scene:score -- SCENE_SNAPSHOT.json TRUTH.json REVIEW.json NEW_OUTPUT.json [EXPORTED_JOB.json]\nOr: npm run scene:score -- --bindings SCENE_SNAPSHOT.json [EXPORTED_JOB.json]',
    );
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  const snapshot = json(args[bindingsOnly ? 1 : 0]!) as SceneSnapshot;
  const computed = createHash('sha256')
    .update(JSON.stringify({ graph: snapshot.graph, native: snapshot.native }))
    .digest('hex');
  if (
    computed !== snapshot.ref.snapshotHash ||
    snapshot.ref.imageHash !== snapshot.graph.imageHash
  )
    throw new Error('Scene snapshot integrity check failed.');
  const jobPath = args[bindingsOnly ? 2 : 4];
  const job = jobPath ? (json(jobPath) as Job) : undefined;
  if (job && job.imageHash !== snapshot.graph.imageHash)
    throw new Error('Job/image binding mismatch.');
  if (job && job.scene?.snapshotRef?.snapshotHash !== snapshot.ref.snapshotHash)
    throw new Error('Scene job/checkpoint binding mismatch.');
  const baseline = job?.candidateResult ?? job?.muse.result ?? job?.sam.result;
  const baselineHash = baseline
    ? createHash('sha256').update(JSON.stringify(baseline)).digest('hex')
    : undefined;
  if (bindingsOnly) {
    console.log(
      JSON.stringify(
        {
          imageHash: snapshot.graph.imageHash,
          sceneSnapshotHash: snapshot.ref.snapshotHash,
          ...(baselineHash ? { baselineAnalysisHash: baselineHash } : {}),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  const result = scoreScene({
    graph: sceneGraphSchema.parse(snapshot.graph),
    snapshotHash: snapshot.ref.snapshotHash,
    truth: sceneTruthSchema.parse(json(args[1]!)),
    review: sceneReviewSchema.parse(json(args[2]!)),
    ...(baseline && baselineHash
      ? { baseline: baseline.objects, baselineHash }
      : {}),
    ...(job?.scene ? { attempts: job.scene.attempts } : {}),
  });
  writeFileSync(args[3]!, JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    'Saved scene evaluation. Original evidence was unchanged; existing reports are never overwritten.',
  );
} catch (error) {
  console.error(
    error instanceof Error && /^(Usage:|Scene |Job\/image)/.test(error.message)
      ? error.message
      : 'Scene scoring failed. Check the evidence bindings, independent annotations and new output path.',
  );
  process.exitCode = 1;
}
