import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs/store.js';
import {
  prepareConnectorExperiment,
  runConnectorExperiment,
  type ConnectorExperimentPlan,
} from '../src/jobs/scene-connector-experiment.js';
import { prepareSceneCrop } from '../src/services/scene.js';
import { sceneRequestEvidence } from '../src/jobs/scene-request-evidence.js';
import { boundaryProfileSchema } from '../src/services/connector-boundary.js';
import { ConnectorWorkflowService } from '../src/jobs/connector-workflow.js';
import { canonicalHash } from '../src/lib/canonical-json.js';
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
          ? args.length !== 4 && args.length !== 5
          : args.length !== 3) ||
    !a ||
    !b ||
    (mode === 'prepare' && (!c || !d || !e))
  )
    throw Error(
      'Usage: npm run experiment:connector -- prepare ANALYSIS_ID OBJECT_ID X,Y NEG_X,NEG_Y NEW_DIRECTORY\nOr: npm run experiment:connector -- prepare-boundary ANALYSIS_ID OBJECT_ID PROFILE.json NEW_DIRECTORY\nOr: npm run experiment:connector -- prepare-auto ANALYSIS_ID OBJECT_ID NEW_DIRECTORY [FROZEN_REFERENCE.json]\nOr: npm run experiment:connector -- run PLAN.json NEW_DIRECTORY\nPrepare is offline. Run makes at most three SAM requests, zero Muse, no retries; requires approval to send image crops to configured Meta service.',
    );
  const store = new JobStore(loadConfig());
  const workflowService = new ConnectorWorkflowService(store);
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
      const source = store.get(a);
      const workflow =
        mode === 'prepare-auto'
          ? await workflowService.prepare(a, {
              objectId: b,
              snapshotId: source.scene?.snapshotRef?.snapshotId,
              snapshotHash: source.scene?.snapshotRef?.snapshotHash,
              ...(d ? { reference: JSON.parse(readFileSync(d, 'utf8')) } : {}),
            })
          : undefined;
      const plan =
        mode === 'prepare-auto'
          ? workflow!.contract.plan
          : await prepareConnectorExperiment(
              store,
              a,
              b,
              profile ? profile.positivePoints[0] : point(c!),
              profile ? profile.exclusion.battery : point(d!),
              profile ? { profile } : undefined,
            );
      if (workflow)
        writeFileSync(
          join(directory, 'workflow.json'),
          JSON.stringify({ workflowId: workflow.workflowId }, null, 2) + '\n',
          { flag: 'wx', mode: 0o600 },
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
        let workflowId: string | undefined;
        if (plan.automaticTargeting) {
          if (!existsSync(join(dirname(a), 'workflow.json')))
            throw new AppError(
              409,
              'WORKFLOW_REQUIRED',
              'Prepare a registered automatic workflow before running this older plan.',
            );
          workflowId = JSON.parse(
            readFileSync(join(dirname(a), 'workflow.json'), 'utf8'),
          ).workflowId;
          if (
            !workflowId ||
            canonicalHash(workflowService.get(workflowId).contract.plan) !==
              canonicalHash(plan)
          )
            throw Error('Automatic plan must match its registered workflow.');
        }
        const report = workflowId
          ? await workflowService.run(
              workflowId,
              {
                workflowId,
                authorizeInference: true,
                providerBaseUrl: plan.providerBaseUrl,
                requests: plan.variants.length,
                pixels: plan.totalPixels,
              },
              controller.signal,
            )
          : await runConnectorExperiment(store, plan, store.config, {
              signal: controller.signal,
            });
        if (workflowId) {
          workflowService.evaluate(workflowId);
          writeFileSync(
            join(directory, 'automatic-targeting-evidence.json'),
            JSON.stringify(
              workflowService.evidence(workflowId, plan.analysisId),
              null,
              2,
            ) + '\n',
            { flag: 'wx', mode: 0o600 },
          );
        }
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
    await workflowService.close();
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
