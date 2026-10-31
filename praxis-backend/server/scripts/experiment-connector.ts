import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs/store.js';
import {
  prepareConnectorExperiment,
  prepareAutomaticConnectorExperiment,
  runConnectorExperiment,
  type ConnectorExperimentPlan,
} from '../src/jobs/scene-connector-experiment.js';
import { prepareSceneCrop } from '../src/services/scene.js';
import { sceneRequestEvidence } from '../src/jobs/scene-request-evidence.js';
import { boundaryProfileSchema } from '../src/services/connector-boundary.js';
import { AppError } from '../src/lib/errors.js';
async function main() {
  const args = process.argv.slice(2);
  const [mode, a, b, c, d, e] = args;
  if (
    !['prepare', 'prepare-boundary', 'prepare-auto', 'run'].includes(
      mode ?? '',
    ) ||
    (mode === 'prepare'
      ? args.length !== 6
      : mode === 'prepare-boundary'
        ? args.length !== 5
        : mode === 'prepare-auto'
          ? args.length !== 4
          : args.length !== 3) ||
    !a ||
    !b ||
    (mode === 'prepare' && (!c || !d || !e))
  )
    throw Error(
      'Usage: npm run experiment:connector -- prepare ANALYSIS_ID OBJECT_ID X,Y NEG_X,NEG_Y NEW_DIRECTORY\nOr: npm run experiment:connector -- prepare-boundary ANALYSIS_ID OBJECT_ID PROFILE.json NEW_DIRECTORY\nOr: npm run experiment:connector -- prepare-auto ANALYSIS_ID OBJECT_ID NEW_DIRECTORY\nOr: npm run experiment:connector -- run PLAN.json NEW_DIRECTORY\nPrepare is offline. Run makes at most three SAM requests, zero Muse, no retries; requires approval to send image crops to configured Meta service.',
    );
  const store = new JobStore(loadConfig());
  try {
    const directory =
      mode === 'prepare'
        ? e!
        : mode === 'prepare-boundary'
          ? d!
          : mode === 'prepare-auto'
            ? c!
            : b;
    // Refuse to overwrite previous evidence before reserving or dispatching.
    mkdirSync(directory, { mode: 0o700 });
    if (
      mode === 'prepare' ||
      mode === 'prepare-boundary' ||
      mode === 'prepare-auto'
    ) {
      const point = (s: string) => {
        const p = s.split(',').map(Number);
        if (p.length !== 2 || p.some((n) => !Number.isInteger(n)))
          throw Error('Invalid point');
        return p as [number, number];
      };
      const profile =
        mode === 'prepare-boundary'
          ? boundaryProfileSchema.parse(JSON.parse(readFileSync(c!, 'utf8')))
          : undefined;
      const plan =
        mode === 'prepare-auto'
          ? await prepareAutomaticConnectorExperiment(store, a, b)
          : await prepareConnectorExperiment(
              store,
              a,
              b,
              profile ? profile.positivePoints[0] : point(c!),
              profile ? profile.exclusion.battery : point(d!),
              profile ? { profile } : undefined,
            );
      const image = store.getSnapshot(plan.samSnapshotRef.samSnapshotId)
        .snapshot.image;
      for (const v of plan.variants)
        writeFileSync(
          join(directory, `${v.name}.jpg`),
          await prepareSceneCrop(image, v.crop),
          { flag: 'wx', mode: 0o600 },
        );
      writeFileSync(
        join(directory, 'plan.json'),
        JSON.stringify(plan, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          plan: join(directory, 'plan.json'),
          requests: plan.variants.length,
          museRequests: 0,
          totalPixels: plan.totalPixels,
          model: plan.model,
          variants: plan.variants.map((v) => ({
            name: v.name,
            crop: v.crop,
            prompt: v.prompt,
            imageSha256: v.imageSha256,
          })),
        }),
      );
    } else {
      const plan = JSON.parse(
        readFileSync(a, 'utf8'),
      ) as ConnectorExperimentPlan;
      const controller = new AbortController();
      const stop = () => controller.abort(new Error('Experiment stopped'));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        const report = await runConnectorExperiment(store, plan, store.config, {
          signal: controller.signal,
        });
        writeFileSync(
          join(directory, 'report.json'),
          JSON.stringify(report, null, 2) + '\n',
          { flag: 'wx', mode: 0o600 },
        );
        for (const record of sceneRequestEvidence(
          store,
          plan.analysisId,
        ).filter((r) => r.experimentId === report.experimentId)) {
          const prefix = join(directory, record.variant!);
          writeFileSync(
            `${prefix}-evidence.json`,
            JSON.stringify(record, null, 2) + '\n',
            { flag: 'wx', mode: 0o600 },
          );
          writeFileSync(
            `${prefix}-crop.jpg`,
            Buffer.from(record.cropImage.base64, 'base64'),
            { flag: 'wx', mode: 0o600 },
          );
          if (record.request)
            writeFileSync(`${prefix}-request.json`, record.request.payload, {
              flag: 'wx',
              mode: 0o600,
            });
          if (record.response)
            writeFileSync(
              `${prefix}-response.bin`,
              Buffer.from(record.response.base64, 'base64'),
              { flag: 'wx', mode: 0o600 },
            );
        }
        console.log(
          JSON.stringify({
            experimentId: report.experimentId,
            status: report.status,
            chargedRequests: report.chargedRequests,
            chargedPixels: report.chargedPixels,
            measurements: report.measurements.map((m) => ({
              variant: m.variant,
              status: m.status,
              wallMs: m.finishedAt === null ? null : m.finishedAt - m.startedAt,
              outcome: m.upstreamOutcome,
              candidates: m.observations?.length ?? null,
            })),
          }),
        );
        if (report.status !== 'completed') process.exitCode = 1;
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    }
  } finally {
    store.close();
  }
}
main().catch((e) => {
  console.error(
    e instanceof AppError
      ? e.message
      : e instanceof Error && e.message.startsWith('Usage:')
        ? e.message
        : 'Connector experiment failed. Inspect the durable experiment reservation and evidence before retrying.',
  );
  process.exitCode = 1;
});
