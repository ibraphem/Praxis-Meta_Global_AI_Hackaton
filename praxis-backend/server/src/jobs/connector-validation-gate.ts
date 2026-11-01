import { connectorThresholds } from '../services/connector-pixel-evaluation.js';
import { connectorProtocolV2 } from '../services/connector-protocol-v2.js';
import { canonicalHash } from '../lib/canonical-json.js';
import { AppError } from '../lib/errors.js';
import type { JobStore, Job } from './store.js';
export function ensureConnectorValidationTables(store: JobStore) {
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS connector_annotation_drafts (workflow_id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS connector_references (hash TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,workflow_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS connector_retrospective_evaluations (hash TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,workflow_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS immutable_connector_references BEFORE UPDATE ON connector_references BEGIN SELECT RAISE(ABORT,'Frozen references are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_connector_retrospectives BEFORE UPDATE ON connector_retrospective_evaluations BEGIN SELECT RAISE(ABORT,'Retrospective evaluations are immutable'); END;`);
}
export function connectorGates(
  store: JobStore,
  job: Job,
  snapshotHash = job.scene?.snapshotRef?.snapshotHash,
) {
  ensureConnectorValidationTables(store);
  const workflows = store.db
    .prepare('SELECT data FROM connector_workflows WHERE analysis_id=?')
    .all(job.analysisId)
    .map((r) => JSON.parse(r.data as string));
  return [
    ...new Set(workflows.map((w) => w.contract.plan.objectId as string)),
  ].map((objectId) => {
    const rows = store.db
      .prepare(
        'SELECT data FROM connector_retrospective_evaluations WHERE analysis_id=? ORDER BY rowid DESC',
      )
      .all(job.analysisId);
    const latestReference = store.db
      .prepare(
        'SELECT data FROM connector_references WHERE analysis_id=? ORDER BY rowid DESC',
      )
      .all(job.analysisId)
      .map((r) => JSON.parse(r.data as string))
      .find((r) => r.objectId === objectId);
    for (const row of rows) {
      const e = JSON.parse(row.data as string),
        { evaluationId, ...payload } = e;
      if (e.objectId !== objectId) continue;
      const workflow = workflows.find((w) => w.workflowId === e.workflowId);
      const v2 =
        workflow?.contract.plan.automaticTargeting?.version ===
        'automatic-targeting-v2';
      const thresholds = v2
        ? connectorProtocolV2.thresholds
        : connectorThresholds;
      if (
        canonicalHash(payload) !== evaluationId ||
        e.configurationHash !== canonicalHash(thresholds) ||
        (v2 &&
          (e.protocolHash !== connectorProtocolV2.protocolHash ||
            e.abComparison !== 'complete' ||
            !connectorProtocolV2.requiredAcceptedStrategies.includes(
              e.strategy,
            ))) ||
        e.status !== 'passed' ||
        !e.independentGroundTruth ||
        e.imageHash !== job.imageHash ||
        e.sourceSnapshotHash !== snapshotHash ||
        e.referenceHash !== latestReference?.referenceHash
      )
        break;
      const reference = store.db
        .prepare('SELECT data FROM connector_references WHERE hash=?')
        .get(e.referenceHash);
      if (!reference) continue;
      const r = JSON.parse(reference.data as string),
        { referenceHash, ...body } = r;
      if (
        canonicalHash(body) !== referenceHash ||
        !r.independent ||
        !r.completedAt ||
        r.content.source !== 'human_review'
      )
        continue;
      if (
        !workflow ||
        canonicalHash(workflow.contract) !== workflow.workflowId ||
        e.metrics
          .filter((m: { accepted: boolean }) => m.accepted)
          .some((m: { observationId: string }) => {
            const review = workflow.evaluations
              .at(-1)
              ?.reviews.find(
                (r: { observationId: string }) =>
                  r.observationId === m.observationId,
              );
            return (
              review?.source !== 'human_review' || review.decision !== 'correct'
            );
          })
      )
        continue;
      const experiment = store.experiments.get(e.experimentId);
      if (canonicalHash(experiment.report) !== e.reportHash) continue;
      return {
        objectId,
        status: 'passed' as const,
        evaluationId: e.evaluationId as string,
        reason:
          'Independent pixel reference, identity review and recorded mask meet the connector thresholds.',
      };
    }
    return {
      objectId,
      status: 'blocked' as const,
      evaluationId: null,
      reason:
        'Independent connector boundary validation is missing, failed, or bound to an older scene checkpoint.',
    };
  });
}
/** Analyses participating in automatic connector validation cannot advance while a target is blocked. */
export function assertConnectorTerminalGate(
  store: JobStore,
  job: Job,
  snapshotHash = job.scene?.snapshotRef?.snapshotHash,
) {
  if (
    connectorGates(store, job, snapshotHash).some((g) => g.status === 'blocked')
  )
    throw new AppError(
      409,
      'CONNECTOR_SEGMENTATION_UNVALIDATED',
      'Complete independent connector pixel validation before terminal discovery.',
    );
}
