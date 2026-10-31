import { readFileSync, writeFileSync } from 'node:fs';
import { sceneGraphSchema } from '../src/schemas/scene.js';
import { matchInventoryRediscoveries } from '../src/services/scene-identity.js';
import { sha256 } from '../src/jobs/scene-request-evidence.js';
try {
  const [beforePath, afterPath, output, ...extra] = process.argv.slice(2);
  if (!beforePath || !afterPath || !output || extra.length)
    throw Error(
      'Usage: npm run scene:replay-identities -- BEFORE_BUNDLE.json REFRESH_BUNDLE.json NEW_REPORT.json',
    );
  const beforeBytes = readFileSync(beforePath),
    afterBytes = readFileSync(afterPath);
  const before = sceneGraphSchema.parse(
      JSON.parse(beforeBytes.toString()).sceneEvaluation.graph,
    ),
    after = sceneGraphSchema.parse(
      JSON.parse(afterBytes.toString()).sceneEvaluation.graph,
    );
  if (before.imageHash !== after.imageHash)
    throw Error('Replay image mismatch.');
  const oldObs = new Set(before.observations.map((o) => o.id));
  const proposals = after.observations
    .filter(
      (o) => !oldObs.has(o.id) && o.source === 'muse' && o.kind === 'bbox',
    )
    .flatMap((o) => {
      const link = after.associations.find(
          (a) => a.observationId === o.id && a.basis === 'inventory',
        ),
        object = after.objects.find((p) => p.id === link?.objectId);
      return object
        ? [
            {
              proposedType: o.prompt ?? object.proposedType,
              category: object.category,
              bbox: o.bbox,
              sourceObservationId: o.id,
              recordedObjectId: object.id,
            },
          ]
        : [];
    });
  const decisions = matchInventoryRediscoveries(before, proposals);
  const report = {
    version: 'scene-identity-replay-v1',
    imageHash: before.imageHash,
    beforeBundleHash: sha256(beforeBytes),
    refreshBundleHash: sha256(afterBytes),
    source: 'offline_algorithm_replay',
    modelRequests: 0,
    productionWrites: 0,
    previouslyReused: proposals.filter((p) =>
      before.objects.some((o) => o.id === p.recordedObjectId),
    ).length,
    proposedReused: decisions.filter((d) => d.matchedObjectId).length,
    proposals,
    decisions,
    note: 'Matching suggestions, not independent photographic truth. Ambiguities and changed wire descriptions remain unresolved. No live object IDs or observations are modified.',
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      proposals: proposals.length,
      recordedReused: report.previouslyReused,
      proposedReused: report.proposedReused,
      unresolved: decisions.filter((d) => !d.matchedObjectId).length,
      modelRequests: 0,
    }),
  );
} catch (e) {
  console.error(
    e instanceof Error && /^(Usage:|Replay image)/.test(e.message)
      ? e.message
      : 'Identity replay failed; check source bundles and an unused output path.',
  );
  process.exitCode = 1;
}
