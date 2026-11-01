import { ensureConnectorValidationTables } from './connector-validation-gate.js';
import {
  connectorProtocolV2,
  qualifiedHumanReferenceV2,
} from '../services/connector-protocol-v2.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalHash } from '../lib/canonical-json.js';
import { AppError } from '../lib/errors.js';
import type { MetaClient } from '../lib/meta-client.js';
import {
  automaticTargetingRecordSchema,
  type AutomaticTargetingRecord,
} from '../schemas/connector-workflow.js';
import {
  connectorReferenceSchema,
  connectorIdentityReviewSchema,
  connectorThresholds,
  evaluateConnectorPixels,
  evaluateConnectorPixelsV2,
  validateConnectorReference,
  type ConnectorReference,
} from '../services/connector-pixel-evaluation.js';
import { getSceneSnapshot } from './scene-snapshots.js';
import { sha256, sceneRequestEvidence } from './scene-request-evidence.js';
import { connectorAccounting } from './connector-lifecycle.js';
import {
  prepareAutomaticConnectorExperiment,
  runConnectorExperiment,
  type ConnectorExperimentPlan,
} from './scene-connector-experiment.js';
import type { JobStore } from './store.js';

interface Workflow {
  revision?: number;
  evaluationFailures?: Array<{ at: number; code: string; inputHash: string }>;
  workflowId: string;
  preparedAt: number;
  startingAt: number | null;
  experimentId: string | null;
  startError?: string;
  evaluationFailure?: { at: number; code: string; inputHash: string };
  contract: {
    version:
      'automatic-connector-workflow-v1' | 'automatic-connector-workflow-v2';
    plan: ConnectorExperimentPlan;
    protocol: {
      thresholds:
        typeof connectorThresholds | typeof connectorProtocolV2.thresholds;
      referenceHash: string | null;
    };
    replacementOf: string | null;
    authorizationId: string | null;
  };
  reference?: ConnectorReference;
  evaluations: Array<{
    evaluatedAt: number;
    inputHash: string;
    reviews: z.infer<typeof connectorIdentityReviewSchema>[];
    result: ReturnType<typeof evaluateConnectorPixels>;
  }>;
}
function ensure(store: JobStore) {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS connector_workflows (id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,data TEXT NOT NULL)',
  );
}
export function savedConnectorWorkflows(
  store: JobStore,
  analysisId: string,
): Workflow[] {
  ensure(store);
  return store.db
    .prepare(
      'SELECT data FROM connector_workflows WHERE analysis_id=? ORDER BY rowid',
    )
    .all(analysisId)
    .map((r) => JSON.parse(r.data as string) as Workflow);
}
export class ConnectorWorkflowService {
  private tasks = new Set<Promise<unknown>>();
  private stopping = new AbortController();
  constructor(
    readonly store: JobStore,
    private readonly client?: MetaClient,
  ) {
    ensure(store);
  }
  get(id: string): Workflow {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new AppError(
        404,
        'WORKFLOW_NOT_FOUND',
        'Prepared connector experiment was not found.',
      );
    const row = this.store.db
      .prepare('SELECT data FROM connector_workflows WHERE id=?')
      .get(id);
    if (!row)
      throw new AppError(
        404,
        'WORKFLOW_NOT_FOUND',
        'Prepared connector experiment was not found.',
      );
    const data = JSON.parse(row.data as string) as Workflow;
    if (
      canonicalHash(data.contract) !== id ||
      (data.reference ? canonicalHash(data.reference) : null) !==
        data.contract.protocol.referenceHash
    )
      throw new AppError(
        409,
        'WORKFLOW_HASH_MISMATCH',
        'Frozen experiment contract failed its integrity check.',
      );
    return data;
  }
  private save(w: Workflow) {
    const revision = w.revision ?? 0;
    const next = { ...w, revision: revision + 1 };
    const changed = this.store.db
      .prepare(
        "UPDATE connector_workflows SET data=? WHERE id=? AND COALESCE(json_extract(data,'$.revision'),0)=?",
      )
      .run(JSON.stringify(next), w.workflowId, revision).changes;
    if (changed !== 1)
      throw new AppError(
        409,
        'WORKFLOW_CHANGED',
        'Experiment evidence changed concurrently. Reload before recording another action.',
      );
    w.revision = next.revision;
  }
  async prepare(analysisId: string, body: unknown) {
    const parsed = z
      .object({
        objectId: z.uuid(),
        snapshotId: z.uuid(),
        snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
        reference: connectorReferenceSchema.optional(),
        targetingVersion: z.enum(['v1', 'v2']).optional(),
        replacementOf: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        authorizeReplacement: z.literal(true).optional(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new AppError(
        400,
        'INVALID_WORKFLOW',
        'Choose a current connector, checkpoint and valid optional reference.',
      );
    const input = parsed.data;
    if (input.reference) {
      try {
        validateConnectorReference(input.reference);
      } catch {
        throw new AppError(
          400,
          'INVALID_REFERENCE',
          'Provide valid reviewed pixel masks within the photograph and evaluation quota.',
        );
      }
    }
    const job = this.store.get(analysisId);
    if (
      job.scene?.snapshotRef?.snapshotId !== input.snapshotId ||
      job.scene.snapshotRef.snapshotHash !== input.snapshotHash
    )
      throw new AppError(
        409,
        'STALE_SCENE',
        'Reload the scene before preparing automatic targeting.',
      );
    const plan = await prepareAutomaticConnectorExperiment(
      this.store,
      analysisId,
      input.objectId,
      input.targetingVersion ?? 'v1',
    );
    if (
      plan.sceneSnapshotRef.snapshotId !== input.snapshotId ||
      plan.sceneSnapshotRef.snapshotHash !== input.snapshotHash
    )
      throw new AppError(
        409,
        'STALE_SCENE',
        'Source evidence changed during preparation.',
      );
    const preparedAt = Date.now();
    if (
      input.reference &&
      (input.reference.imageHash !== plan.imageHash ||
        input.reference.objectId !== plan.objectId ||
        input.reference.frozenAt > preparedAt ||
        input.reference.image.width !== job.image.width ||
        input.reference.image.height !== job.image.height)
    )
      throw new AppError(
        400,
        'INVALID_REFERENCE',
        'Freeze a reference for this exact target and photograph before preparation.',
      );
    if (!!input.replacementOf !== !!input.authorizeReplacement)
      throw new AppError(
        400,
        'REPLACEMENT_AUTHORIZATION_REQUIRED',
        'Replacement plans require an explicit authorization and original plan reference.',
      );
    if (input.replacementOf) {
      const prior = this.get(input.replacementOf);
      if (!input.reference && prior.reference)
        input.reference = structuredClone(prior.reference);
      const record = prior.experimentId
        ? this.store.experiments.get(prior.experimentId)
        : undefined;
      if (
        prior.contract.plan.analysisId !== analysisId ||
        prior.contract.plan.objectId !== plan.objectId ||
        !prior.startingAt ||
        record?.status === 'running' ||
        record?.status === 'interrupted'
      )
        throw new AppError(
          409,
          'REPLACEMENT_BLOCKED',
          'Release interrupted ownership first; retain and link the original spent plan.',
        );
    } else {
      const uncertain = savedConnectorWorkflows(this.store, analysisId).find(
        (w) =>
          w.contract.plan.objectId === plan.objectId &&
          w.experimentId &&
          ((
            this.store.experiments.get(w.experimentId).report as {
              accounting?: { unknownUsageRequests: number };
            }
          )?.accounting?.unknownUsageRequests ?? 0) > 0,
      );
      if (uncertain)
        throw new AppError(
          409,
          'REPLACEMENT_AUTHORIZATION_REQUIRED',
          'An earlier target request has unknown usage. Explicitly link and authorize a replacement; its charges remain retained.',
        );
    }
    const contract: Workflow['contract'] = {
      version:
        input.targetingVersion === 'v2'
          ? 'automatic-connector-workflow-v2'
          : 'automatic-connector-workflow-v1',
      plan,
      protocol: {
        thresholds:
          input.targetingVersion === 'v2'
            ? connectorProtocolV2.thresholds
            : connectorThresholds,
        referenceHash: input.reference ? canonicalHash(input.reference) : null,
      },
      replacementOf: input.replacementOf ?? null,
      authorizationId: input.replacementOf ? randomUUID() : null,
    };
    const workflowId = canonicalHash(contract);
    const existing = this.store.db
      .prepare('SELECT id FROM connector_workflows WHERE id=?')
      .get(workflowId);
    if (existing) return this.get(workflowId);
    if (savedConnectorWorkflows(this.store, analysisId).length >= 20)
      throw new AppError(
        409,
        'WORKFLOW_LIMIT',
        'The retained connector plan limit was reached.',
      );
    const workflow: Workflow = {
      workflowId,
      preparedAt,
      contract,
      startingAt: null,
      experimentId: null,
      evaluations: [],
      ...(input.reference ? { reference: input.reference } : {}),
    };
    this.store.db
      .prepare('INSERT INTO connector_workflows VALUES (?,?,?)')
      .run(workflowId, analysisId, JSON.stringify(workflow));
    return workflow;
  }
  approve(id: string, body: unknown) {
    const w = this.get(id),
      p = w.contract.plan;
    const approval = z
      .object({
        workflowId: z.literal(id),
        authorizeInference: z.literal(true),
        providerBaseUrl: z.literal(p.providerBaseUrl),
        requests: z.literal(p.variants.length),
        pixels: z.literal(p.totalPixels),
      })
      .strict()
      .safeParse(body);
    if (!approval.success)
      throw new AppError(
        400,
        'INVALID_EXPERIMENT_AUTHORIZATION',
        'Authorize the exact frozen plan, provider, requests and pixels.',
      );
    return w;
  }
  private assertCostControl(current: Workflow) {
    const id = current.workflowId;
    const prior = savedConnectorWorkflows(
      this.store,
      current.contract.plan.analysisId,
    ).some(
      (other) =>
        other.workflowId !== id &&
        other.contract.plan.objectId === current.contract.plan.objectId &&
        other.startingAt !== null,
    );
    if (prior) {
      ensureConnectorValidationTables(this.store);
      const complete = this.store.db
        .prepare(
          'SELECT data FROM connector_retrospective_evaluations WHERE analysis_id=?',
        )
        .all(current.contract.plan.analysisId)
        .map((row) => JSON.parse(row.data as string))
        .some((e) => {
          const { evaluationId, ...payload } = e;
          return (
            canonicalHash(payload) === evaluationId &&
            e.sourceSnapshotHash ===
              current.contract.plan.sceneSnapshotRef.snapshotHash &&
            e.objectId === current.contract.plan.objectId &&
            e.imageHash === current.contract.plan.imageHash &&
            e.independentGroundTruth &&
            ['passed', 'failed'].includes(e.status)
          );
        });
      if (!complete)
        throw new AppError(
          409,
          'REFERENCE_VALIDATION_REQUIRED',
          'Complete independent reference annotation and offline evaluation before spending another connector inference request.',
        );
    }
    if (
      current.contract.version === 'automatic-connector-workflow-v2' &&
      !current.contract.plan.variants.some(
        (v) => v.name === 'B-mask-interior-v2' || v.name === 'C-body-aware-v2',
      )
    )
      throw new AppError(
        409,
        'TARGETING_EVIDENCE_REQUIRED',
        'V2 has no supported improved strategy. Inspect abstention diagnostics before spending a repeated inventory-box request.',
      );
  }
  async run(id: string, approval: unknown, signal?: AbortSignal) {
    const w = this.approve(id, approval);
    this.store.transaction(() => {
      const current = this.get(id);
      if (current.startingAt !== null)
        throw new AppError(
          409,
          'WORKFLOW_ALREADY_SPENT',
          'This plan was already admitted. It cannot be replayed, including after release.',
        );
      this.assertCostControl(current);
      current.startingAt = Date.now();
      this.save(current);
    });
    try {
      return await runConnectorExperiment(
        this.store,
        w.contract.plan,
        this.store.config,
        {
          ...(this.client ? { client: this.client } : {}),
          signal: AbortSignal.any([
            this.stopping.signal,
            ...(signal ? [signal] : []),
          ]),
          onReserved: (experimentId) => {
            const current = this.get(id);
            current.experimentId = experimentId;
            this.save(current);
          },
        },
      );
    } catch (error) {
      const current = this.get(id);
      current.startError =
        error instanceof AppError ? error.code : 'EXPERIMENT_FAILED';
      this.save(current);
      throw error;
    }
  }
  start(id: string, approval: unknown) {
    this.assertCostControl(this.approve(id, approval));
    if (this.get(id).startingAt !== null)
      throw new AppError(
        409,
        'WORKFLOW_ALREADY_SPENT',
        'This plan was already admitted.',
      );
    const task = this.run(id, approval);
    this.tasks.add(task);
    void task.catch(() => {}).finally(() => this.tasks.delete(task));
  }
  release(id: string) {
    const w = this.get(id);
    if (!w.experimentId)
      throw new AppError(
        409,
        'EXPERIMENT_NOT_INTERRUPTED',
        'This plan has no interrupted provider reservation.',
      );
    this.store.experiments.releaseInterrupted(w.experimentId);
  }
  evaluate(id: string, reviews: unknown = []) {
    const w = this.get(id);
    const parsed = z
      .array(connectorIdentityReviewSchema)
      .max(96)
      .safeParse(reviews);
    if (!parsed.success)
      throw new AppError(
        400,
        'INVALID_MASK_REVIEW',
        'Provide valid identity reviews for this experiment.',
      );
    const retained = new Map(
      (w.evaluations.at(-1)?.reviews ?? []).map((r) => [r.observationId, r]),
    );
    for (const review of parsed.data)
      retained.set(review.observationId, review);
    const input = [...retained.values()];
    if (!w.experimentId)
      throw new AppError(
        409,
        'EXPERIMENT_NOT_FINISHED',
        'Run the prepared experiment before evaluating it.',
      );
    const record = this.store.experiments.get(w.experimentId);
    if (record.status === 'running')
      throw new AppError(
        409,
        'EXPERIMENT_NOT_FINISHED',
        'Wait for request execution to finish.',
      );
    const report = record.report as Awaited<
      ReturnType<typeof runConnectorExperiment>
    >;
    if (
      !report ||
      canonicalHash(report.plan) !== canonicalHash(w.contract.plan)
    )
      throw new AppError(
        409,
        'EXPERIMENT_BINDING_MISMATCH',
        'The report is not bound to this frozen plan.',
      );
    let result: ReturnType<typeof evaluateConnectorPixels>;
    try {
      const evaluationInput = {
        report,
        registeredReferenceHash: w.contract.protocol.referenceHash,
        ...(w.reference ? { reference: w.reference } : {}),
        reviews: input,
      };
      result =
        w.contract.version === 'automatic-connector-workflow-v2'
          ? evaluateConnectorPixelsV2({
              ...evaluationInput,
              protocol: w.contract.plan.evaluationProtocol,
            })
          : evaluateConnectorPixels(evaluationInput);
    } catch {
      if ((w.evaluationFailures?.length ?? 0) >= 20)
        throw new AppError(
          409,
          'EVALUATION_LIMIT',
          'The retained failed evaluation limit was reached.',
        );
      w.evaluationFailure = {
        at: Date.now(),
        code: 'EVALUATION_FAILED',
        inputHash: canonicalHash({ reviews: input, report }),
      };
      (w.evaluationFailures ??= []).push(w.evaluationFailure);
      this.save(w);
      throw new AppError(
        400,
        'EVALUATION_FAILED',
        'Inspect the mask identity reviews and native evidence bindings. Execution evidence is preserved.',
      );
    }
    const requests = sceneRequestEvidence(
      this.store,
      w.contract.plan.analysisId,
    ).filter((r) => r.experimentId === w.experimentId);
    let missing = 0;
    const invalidArms = new Set<string>();
    for (const m of report.measurements) {
      const request = requests.find((r) => r.requestId === m.requestId);
      const variant = w.contract.plan.variants.find(
        (v) => v.name === m.variant,
      );
      if (
        !request ||
        !variant ||
        request.inputSnapshotHash !==
          w.contract.plan.sceneSnapshotRef.snapshotHash ||
        request.objectId !== w.contract.plan.objectId ||
        request.prompt !== variant.prompt ||
        request.cropImage.sha256 !== variant.imageSha256 ||
        sha256(Buffer.from(request.cropImage.base64, 'base64')) !==
          variant.imageSha256 ||
        (m.dispatchStartedAt !== undefined &&
          (!request.request ||
            sha256(request.request.payload) !== request.request.sha256)) ||
        (m.upstreamOutcome === 'response_received' &&
          (!request.response ||
            sha256(Buffer.from(request.response.base64, 'base64')) !==
              request.response.sha256))
      ) {
        missing++;
        invalidArms.add(m.variant);
      }
      if (request?.request && variant) {
        try {
          const body = JSON.parse(request.request.payload);
          const content = body.input[0].content;
          if (
            body.model !== w.contract.plan.model ||
            body.stream !== false ||
            content[0].text !== variant.prompt ||
            content[0].type !== 'input_text' ||
            body.metadata.mask_encoding !== 'one_bit' ||
            body.metadata.include_confidence !== 'true' ||
            sha256(
              Buffer.from(content[1].image_url.split(',')[1], 'base64'),
            ) !== variant.imageSha256
          )
            throw new Error('Request specification mismatch');
          for (const native of (m.native ?? []) as Array<{
            observationId: string;
            encodedMask: unknown;
            samObjectId?: number;
          }>) {
            const observation = (
              m.observations as Array<{ id: string; bbox: number[] }>
            ).find((o) => o.id === native.observationId);
            if (
              !observation ||
              !request.decoded?.candidates.some((candidate) => {
                const c = candidate as {
                  encodedMask?: unknown;
                  samObjectId?: number;
                  bbox: number[];
                };
                return (
                  c.encodedMask &&
                  c.samObjectId === native.samObjectId &&
                  canonicalHash(c.encodedMask) ===
                    canonicalHash(native.encodedMask) &&
                  canonicalHash(c.bbox) ===
                    canonicalHash([
                      observation.bbox[0]! - variant.crop[0],
                      observation.bbox[1]! - variant.crop[1],
                      observation.bbox[2],
                      observation.bbox[3],
                    ])
                );
              })
            )
              throw new Error('Native candidate mismatch');
          }
        } catch {
          missing++;
          invalidArms.add(m.variant);
        }
      }
    }
    if (
      requests.length !== report.measurements.length ||
      report.chargedRequests !== report.measurements.length
    ) {
      missing++;
      for (const m of report.measurements) invalidArms.add(m.variant);
    }
    for (const arm of result.armResults)
      if (invalidArms.has(arm.variant)) {
        arm.acceptedMaskCount = 0;
        arm.outcome = 'provenance_missing';
      }
    if (result.successRate !== null)
      result.successRate =
        result.armResults.filter((a) => a.acceptedMaskCount === 1).length /
        result.plannedStrategyCount;
    result.invariants = {
      requestsBeyondBudget: Math.max(
        0,
        report.chargedRequests - w.contract.plan.variants.length,
        report.chargedPixels > w.contract.plan.totalPixels ? 1 : 0,
      ),
      missingRequiredProvenance: missing,
      confirmedIdentityMerges: 0,
      sourceEvidencePreserved:
        getSceneSnapshot(
          this.store,
          w.contract.plan.sceneSnapshotRef.snapshotId,
        ).ref.snapshotHash === w.contract.plan.sceneSnapshotRef.snapshotHash,
    };
    if (
      (missing ||
        result.invariants.requestsBeyondBudget ||
        !result.invariants.sourceEvidencePreserved) &&
      ['passed', 'synthetic_pass'].includes(result.status)
    )
      result.status = 'incomplete';
    const inputHash = canonicalHash({
      referenceHash: w.contract.protocol.referenceHash,
      reviews: input,
      report,
      requestEvidenceHash: canonicalHash(requests),
    });
    if (!w.evaluations.some((e) => e.inputHash === inputHash)) {
      if (w.evaluations.length >= 20)
        throw new AppError(
          409,
          'EVALUATION_LIMIT',
          'The retained evaluation limit was reached.',
        );
      delete w.evaluationFailure;
      w.evaluations.push({
        evaluatedAt: Date.now(),
        inputHash,
        reviews: input,
        result,
      });
      this.save(w);
    }
    if (w.evaluationFailure) {
      delete w.evaluationFailure;
      this.save(w);
    }
    return result;
  }
  evidence(id: string, analysisId: string) {
    const w = this.get(id);
    if (w.contract.plan.analysisId !== analysisId)
      throw new AppError(
        404,
        'WORKFLOW_NOT_FOUND',
        'This experiment belongs to a different analysis.',
      );
    return {
      schemaVersion: 'praxis-automatic-targeting-evidence-v1',
      workflow: w,
      sourceSnapshot: getSceneSnapshot(
        this.store,
        w.contract.plan.sceneSnapshotRef.snapshotId,
      ),
      experiment: w.experimentId
        ? this.store.experiments.get(w.experimentId)
        : null,
      requests: sceneRequestEvidence(this.store, analysisId).filter(
        (r) => !!w.experimentId && r.experimentId === w.experimentId,
      ),
      note: 'Private raw crop/request/response/native evidence. A download never sends inference or verifies electrical connections.',
    };
  }
  publicForAnalysis(analysisId: string): AutomaticTargetingRecord[] {
    let previewBudget = 60000;
    return savedConnectorWorkflows(this.store, analysisId)
      .reverse()
      .map((saved) => {
        const w = this.get(saved.workflowId);
        const p = w.contract.plan,
          record = w.experimentId
            ? this.store.experiments.get(w.experimentId)
            : undefined;
        const report = record?.report as
          Awaited<ReturnType<typeof runConnectorExperiment>> | undefined;
        const measurements = (report?.measurements ?? []).map((m) => ({
          variant: m.variant,
          requestId: m.requestId,
          status: m.status,
          phase: m.phase ?? 'admitted',
          providerOutcome: m.upstreamOutcome,
          startedAt: m.startedAt,
          finishedAt: m.finishedAt,
          wallMs: m.finishedAt === null ? null : m.finishedAt - m.startedAt,
          maskCount: m.native?.length ?? 0,
          observationIds: ((m.observations as Array<{ id: string }>) ?? []).map(
            (o) => o.id,
          ),
          previews: (
            (m.observations as Array<{
              id: string;
              bbox: [number, number, number, number];
              mask?: { path: string };
            }>) ?? []
          ).map((o) => {
            const preview =
              o.mask && o.mask.path.length <= previewBudget
                ? o.mask
                : undefined;
            if (preview) previewBudget -= preview.path.length;
            return {
              id: o.id,
              bbox: o.bbox,
              ...(preview ? { mask: preview } : {}),
            };
          }),
          events: m.events ?? [],
        }));
        const automatic = w.contract.plan.automaticTargeting;
        const newer =
          automatic?.version === 'automatic-targeting-v2'
            ? automatic
            : undefined;
        const v2 = !!newer;
        const arms = (
          v2
            ? connectorProtocolV2.strategies
            : ['A-auto-inventory-box', 'B-auto-baseline-interior']
        ).map((name) => {
          const v = p.variants.find((v) => v.name === name),
            m = measurements.find((m) => m.variant === name);
          return {
            name,
            prompt: v?.prompt ?? null,
            crop: v?.crop ?? null,
            imageSha256: v?.imageSha256 ?? null,
            status: m?.status ?? (v ? 'planned' : 'abstained'),
            reason: v
              ? 'Frozen automatic targeting proposal.'
              : v2
                ? name === 'C-body-aware-v2'
                  ? newer?.diagnostics?.bodyProposal.reason
                  : 'No defensible baseline interior point; inspect versioned stage diagnostics.'
                : 'No defensible baseline interior point; no request specification was created.',
          };
        });
        return automaticTargetingRecordSchema.parse({
          ...(v2
            ? {
                algorithmVersion: 'automatic-targeting-v2',
                targetingDiagnostics: newer?.diagnostics,
                evaluationProtocol: w.contract.plan.evaluationProtocol,
              }
            : {}),
          workflowId: w.workflowId,
          analysisId,
          imageHash: p.imageHash,
          objectId: p.objectId,
          sourceSnapshotId: p.sceneSnapshotRef.snapshotId,
          sourceSnapshotHash: p.sceneSnapshotRef.snapshotHash,
          preparedAt: w.preparedAt,
          providerBaseUrl: p.providerBaseUrl,
          model: p.model,
          experimentId: w.experimentId,
          replacementOf: w.contract.replacementOf,
          status:
            record?.status ??
            (w.startingAt === null
              ? 'prepared'
              : w.startError || Date.now() - w.startingAt > 15000
                ? 'failed'
                : 'starting'),
          phase: w.evaluations.length
            ? 'evaluated'
            : (measurements.at(-1)?.phase ??
              (w.startingAt === null ? 'prepared' : 'admitted')),
          budget: {
            scope: 'isolated_experiment',
            maxRequests: 3,
            maxPixels: 6000000,
            plannedRequests: p.variants.length,
            plannedPixels: p.totalPixels,
          },
          accounting:
            report?.accounting ??
            connectorAccounting({
              chargedRequests: 0,
              chargedPixels: 0,
              measurements: [],
            }),
          arms,
          pointStatus: p.automaticTargeting!.pointStatus,
          pointCues: p.automaticTargeting!.pointCues,
          measurements,
          evaluationStatus: w.evaluationFailure
            ? 'failed'
            : w.evaluations.length
              ? 'succeeded'
              : 'not_evaluated',
          evaluationError: w.evaluationFailure?.code ?? null,
          evaluation: w.evaluations.at(-1)?.result ?? null,
          evidenceUrl: `/api/analyses/${analysisId}/automatic-targeting-evidence?workflowId=${w.workflowId}`,
          protocol: w.contract.protocol,
          referenceStatus: !w.reference
            ? 'not_registered'
            : w.reference.source === 'synthetic_fixture'
              ? 'registered_synthetic'
              : (
                    v2
                      ? qualifiedHumanReferenceV2(w.reference)
                      : w.reference.independent &&
                        w.reference.source === 'human_review'
                  )
                ? 'registered_independent'
                : 'registered_unqualified',
          executionError: w.startError ?? report?.errorCode ?? null,
          protocolHash: canonicalHash(w.contract.protocol),
          note: 'Separate bounded experiment budget. Production scene evidence is unchanged. Preview paths may be omitted within the public preview budget; private evidence retains every native mask. No billing or connectivity claim.',
        });
      })
      .reverse();
  }
  async close() {
    this.stopping.abort(new Error('Experiment service stopped'));
    await Promise.allSettled([...this.tasks]);
  }
}
