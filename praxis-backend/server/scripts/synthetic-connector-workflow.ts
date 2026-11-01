import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalHash } from '../src/lib/canonical-json.js';
import { ConnectorWorkflowService } from '../src/jobs/connector-workflow.js';
import { JobStore, publicJob } from '../src/jobs/store.js';
import { exportJobEvidence } from '../src/jobs/evidence.js';
import {
  syntheticConnectorFixture,
  syntheticConnectorClient,
  workflowApproval,
} from '../test/fixtures/connector-workflow.js';
import { testConfig } from '../test/helpers.js';

const output = process.argv[2];
if (!output)
  throw Error('Usage: npm run experiment:synthetic -- NEW_DIRECTORY');
mkdirSync(output, { mode: 0o700 });
const results: unknown[] = [];
for (const [name, behavior] of [
  ['successful-ab', ['mask', 'mask']],
  ['point-abstention', ['mask']],
  ['missing-reference', ['mask', 'mask']],
  ['valid-empty', ['empty', 'empty']],
  ['parser-failure', ['invalid']],
  ['unknown-dispatch', ['disconnect']],
] as const) {
  const f = await syntheticConnectorFixture(
      ':memory:',
      name !== 'point-abstention',
    ),
    fake = syntheticConnectorClient(f.config, [...behavior]),
    service = new ConnectorWorkflowService(f.store, fake.client);
  try {
    const before = canonicalHash(
      f.store.db
        .prepare('SELECT data FROM jobs WHERE id=?')
        .get(f.job.analysisId)!.data,
    );
    const w = await service.prepare(f.job.analysisId, {
        ...f.prepareBody,
        ...(name === 'missing-reference' ? { reference: undefined } : {}),
      }),
      report = await service.run(w.workflowId, workflowApproval(w));
    const reviews =
      name === 'missing-reference'
        ? []
        : report.measurements.flatMap((m) =>
            ((m.observations as Array<{ id: string }>) ?? []).map((o) => ({
              observationId: o.id,
              decision: 'correct',
              source: 'synthetic_fixture',
              reviewedAt: Date.now(),
            })),
          );
    const evaluation = service.evaluate(w.workflowId, reviews);
    assert.equal(
      canonicalHash(
        f.store.db
          .prepare('SELECT data FROM jobs WHERE id=?')
          .get(f.job.analysisId)!.data,
      ),
      before,
    );
    const records = service.publicForAnalysis(f.job.analysisId);
    const bundle = {
      schemaVersion: 'praxis-synthetic-workflow-evaluation-v1',
      synthetic: true,
      transport: 'in_process_fake_provider',
      externalInferenceRequests: 0,
      analysis: {
        ...publicJob(f.store.get(f.job.analysisId)),
        automaticTargeting: records,
      },
      automaticTargeting: records,
      evaluation,
      sourceEvidencePreserved: true,
      photographicReadiness: false,
    };
    const directory = join(output, name);
    exportJobEvidence(f.store, f.job.analysisId, directory);
    writeFileSync(
      join(directory, 'evaluation-bundle.json'),
      JSON.stringify(bundle, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    results.push({
      name,
      workflowId: w.workflowId,
      status: report.status,
      evaluation: evaluation.status,
      accounting: report.accounting,
      archive: name,
    });
  } finally {
    await service.close();
    f.store.close();
  }
}
for (const phase of ['admitted', 'dispatching', 'response_recorded']) {
  const root = mkdtempSync(join(tmpdir(), 'praxis-synthetic-crash-'));
  let store: JobStore | undefined;
  try {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/connector-crash-child.ts',
        root,
        phase,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let errors = '';
    child.stderr.on('data', (c) => {
      errors += String(c);
    });
    const ready = await new Promise<{ analysisId: string; workflowId: string }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(Error('Synthetic checkpoint timed out: ' + errors));
        }, 8000);
        child.stdout.once('data', (c) => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(String(c)));
          } catch (e) {
            reject(e);
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(Error(`Synthetic child exited ${code}: ${errors}`));
        });
      },
    );
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    store = new JobStore(testConfig(), root);
    const service = new ConnectorWorkflowService(store);
    store.experiments.recover(Date.now() + 30000);
    const record = service.publicForAnalysis(ready.analysisId)[0]!;
    assert.equal(record.status, 'interrupted');
    assert.equal(record.accounting.reservedRequests, 1);
    const name = `crash-${phase}`;
    exportJobEvidence(store, ready.analysisId, join(output, name));
    writeFileSync(
      join(output, name, 'automatic-targeting-evidence.json'),
      JSON.stringify(
        service.evidence(ready.workflowId, ready.analysisId),
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    results.push({
      name,
      status: record.status,
      phase: record.phase,
      accounting: record.accounting,
      archive: name,
    });
    await service.close();
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
const summary = {
  schemaVersion: 'praxis-synthetic-workflow-suite-v1',
  externalInferenceRequests: 0,
  photographicReadiness: false,
  results,
};
writeFileSync(
  join(output, 'summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 },
);
writeFileSync(
  join(output, 'summary.md'),
  '# Synthetic automatic targeting workflow\n\nAll provider responses and source images are synthetic. External inference requests: **0**. These results validate execution, accounting, evaluation and crash recovery; they do not establish photographic segmentation accuracy.\n\nThe successful A/B fixture has perfect agreement with its synthetic masks and explicit synthetic identity reviews. Empty predictions, parser failures, unknown dispatch and SIGKILL recovery remain distinct outcomes. Each subdirectory contains a hashed source/evidence archive.\n\nSee summary.json for exact accounting and evaluation-bundle.json within the successful-ab, valid-empty, parser-failure and unknown-dispatch directories for reopenable evaluation records.\n',
  { flag: 'wx', mode: 0o600 },
);
const files: Array<{ path: string; sha256: string; bytes: number }> = [];
function inventory(directory: string, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name,
      absolute = join(directory, entry.name);
    if (entry.isDirectory()) inventory(absolute, relative + '/');
    else {
      const bytes = readFileSync(absolute);
      files.push({
        path: relative,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      });
    }
  }
}
inventory(output);
writeFileSync(
  join(output, 'suite-manifest.json'),
  JSON.stringify(
    { schemaVersion: 'praxis-synthetic-suite-manifest-v1', files },
    null,
    2,
  ) + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.log(
  JSON.stringify({
    output,
    cases: results.length,
    externalInferenceRequests: 0,
    photographicReadiness: false,
  }),
);
