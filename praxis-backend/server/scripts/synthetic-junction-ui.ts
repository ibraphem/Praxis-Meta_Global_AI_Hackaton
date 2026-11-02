/** Regenerate only synthetic UI fixtures. All provider transports are mocked. */
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  acceptedJunctionFixture,
  junctionApproval,
  syntheticJunctionResponse,
} from '../test/fixtures/connector-junctions.js';
import { publicJob } from '../src/jobs/store.js';
import { runTerminalStage } from '../src/jobs/terminal-worker.js';
import { createMetaClient } from '../src/lib/meta-client.js';
import { AnalysisTrace } from '../src/lib/diagnostics.js';
import { analysisSchema } from '../src/schemas/vision.js';
const cleanup: Array<() => void | Promise<void>> = [];
try {
  const f = await acceptedJunctionFixture({ after: (fn) => cleanup.push(fn) }),
    r = await f.service.prepare(f.job.analysisId, f.prepareBody);
  f.service.admit(f.job.analysisId, junctionApproval(r.plan));
  const owner = randomUUID(),
    claim = f.store.claim(owner)!;
  await runTerminalStage(
    f.store,
    claim.job,
    owner,
    claim.attemptId,
    f.config,
    createMetaClient(f.config, async () =>
      Response.json(syntheticJunctionResponse(r.plan)),
    ),
    new AbortController().signal,
    new AnalysisTrace(claim.attemptId),
  );
  const job = {
    ...publicJob(f.store.get(f.job.analysisId)),
    status: 'completed',
    result: analysisSchema.parse({
      image: f.job.image,
      objects: [],
      provenance: {
        mode: 'combined',
        reasoningModel: 'synthetic',
        segmentationModel: 'synthetic',
      },
    }),
    automaticTargeting: f.workflows.publicForAnalysis(f.job.analysisId),
    connectorValidation: f.validation.summary(f.job.analysisId),
    connectorJunctions: f.service.forAnalysis(f.job.analysisId),
  };
  writeFileSync(
    new URL(
      '../../../praxis-frontend/test/fixtures/connector-junctions.json',
      import.meta.url,
    ),
    JSON.stringify(
      {
        fixtureScope:
          'Synthetic protocol fixture with simulated prerequisite reviewer metadata. No real photograph, reviewer, inference, or photographic accuracy evidence.',
        job,
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    new URL(
      '../../../praxis-frontend/test/fixtures/connector-junctions.jpg',
      import.meta.url,
    ),
    f.store.image(f.job.analysisId),
  );
  console.log(
    'Generated validated synthetic junction UI fixtures. No real provider calls.',
  );
} finally {
  for (const fn of cleanup.reverse()) await fn();
}
