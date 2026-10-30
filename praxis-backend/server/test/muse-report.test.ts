import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeMuseExperiment } from '../src/jobs/muse-report.js';
const row = (variant: string, status = 'succeeded') => ({
  variant,
  status,
  elapsedMs: 15,
  upstreamOutcome: status === 'timed_out' ? 'unknown' : 'response_received',
});
function legacy() {
  return {
    schemaVersion: 2,
    status: 'interrupted',
    phaseBudgetMs: 45,
    variants: [{ name: 'original-current' }, { name: '1280-minimal' }],
    measurements: [row('original-current', 'timed_out')],
    phaseTimings: [{ variant: 'original-current', elapsedMs: 45 }],
  };
}
test('legacy budgets and partial sequences normalize without rewriting artifacts or inventing total duration', () => {
  const report = legacy(),
    before = JSON.stringify(report),
    summary = summarizeMuseExperiment(report);
  assert.equal(summary.variantBudgetMs, 45);
  assert.equal(summary.experimentElapsedMs, null);
  assert.equal(summary.assessmentBasis, 'inferred_from_legacy_artifact');
  assert.equal(summary.comparisonComplete, false);
  assert.deepEqual(summary.attemptedVariants, ['original-current']);
  assert.deepEqual(summary.unattemptedVariants, ['1280-minimal']);
  assert.equal(summary.observedFailures.length, 1);
  assert.equal(JSON.stringify(report), before);
});
test('v1 duration and stage deadline remain usable; unknown upstream results prevent a complete-comparison claim', () => {
  const report = {
    schemaVersion: 1,
    status: 'completed',
    stageDeadlineMs: 80,
    variants: [{ name: 'original-current' }],
    measurements: [row('original-current')],
  };
  const scored = summarizeMuseExperiment(report);
  assert.equal(scored.variantBudgetMs, 80);
  assert.equal(scored.variantRuns[0]!.elapsedMs, 15);
  assert.equal(scored.experimentElapsedMs, null);
  assert.equal(scored.comparisonComplete, true);
  report.measurements[0] = row('original-current', 'timed_out');
  assert.equal(summarizeMuseExperiment(report).comparisonComplete, false);
});
test('unfinished focused work remains explicitly unattempted and cannot be hidden by a completed runner status', () => {
  const report = {
    schemaVersion: 3,
    status: 'completed',
    comparisonComplete: true,
    variantBudgetMs: 100,
    experimentElapsedMs: 40,
    variants: [{ name: 'focused-candidates' }],
    measurements: [
      { ...row('focused-candidates', 'failed'), candidateId: 'jumper_wire_1' },
    ],
    variantRuns: [
      {
        variant: 'focused-candidates',
        status: 'failed',
        elapsedMs: 40,
        plannedCandidateIds: ['jumper_wire_1', 'jumper_wire_2'],
        attemptedCandidateIds: ['jumper_wire_1'],
      },
    ],
  };
  const summary = summarizeMuseExperiment(report);
  assert.equal(summary.comparisonComplete, false);
  assert.deepEqual(summary.unattemptedCandidates, [
    { variant: 'focused-candidates', candidateId: 'jumper_wire_2' },
  ]);
  assert.equal(summary.observedFailures.length, 1);
});
test('terminal failures can be complete observations while malformed plans cannot claim completeness', () => {
  const report = {
    schemaVersion: 3,
    status: 'completed',
    variantBudgetMs: 100,
    experimentElapsedMs: 40,
    variants: [{ name: 'original-current' }],
    measurements: [row('original-current', 'failed')],
    variantRuns: [
      {
        variant: 'original-current',
        status: 'failed',
        elapsedMs: 40,
        plannedCandidateIds: [],
        attemptedCandidateIds: [],
      },
    ],
  };
  assert.equal(summarizeMuseExperiment(report).comparisonComplete, true);
  assert.throws(
    () => summarizeMuseExperiment({ ...report, measurements: [] }),
    /require measurements/,
  );
  assert.throws(
    () => summarizeMuseExperiment({ ...report, phaseBudgetMs: 50 }),
    /Conflicting/,
  );
});
test('offline CLI summary reads v2 without provider configuration and preserves exact input bytes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'praxis-summary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'old-report.json'),
    bytes = JSON.stringify(legacy(), null, 2) + '\n';
  writeFileSync(path, bytes);
  const env = { ...process.env };
  delete env.META_API_KEY;
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/experiment-muse.ts', '--summarize', path],
    { env, encoding: 'utf8' },
  );
  assert.equal(JSON.parse(output).comparisonComplete, false);
  assert.equal(readFileSync(path, 'utf8'), bytes);
  const conflict = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/experiment-muse.ts',
      'no-job',
      '--variant-budget-ms',
      '50',
      '--budget-ms',
      '60',
    ],
    { env, encoding: 'utf8' },
  );
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /Usage:/);
  assert.doesNotMatch(conflict.stderr, /Invalid configuration/);
});
