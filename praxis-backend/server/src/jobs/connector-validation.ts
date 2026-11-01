import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decodeMaskToRaster } from '@meta-sam/parser';
import { canonicalHash } from '../lib/canonical-json.js';
import { AppError } from '../lib/errors.js';
import {
  annotationContentSchema,
  retrospectiveResultSchema,
  type AnnotationContent,
} from '../schemas/connector-validation.js';
import {
  validateAnnotation,
  pixelMetrics,
} from '../services/pixel-reference.js';
import { connectorThresholds } from '../services/connector-pixel-evaluation.js';
import { auditAutomaticPoint } from '../services/automatic-point-audit.js';
import { ConnectorWorkflowService } from './connector-workflow.js';
import { auditConnectorEvidence } from './connector-evidence-audit.js';
import {
  ensureConnectorValidationTables,
  connectorGates,
} from './connector-validation-gate.js';
import type { JobStore } from './store.js';

interface Draft {
  draftId: string;
  workflowId: string;
  imageHash: string;
  objectId: string;
  image: { width: number; height: number };
  revision: number;
  updatedAt: number;
  content: AnnotationContent;
}
export interface FrozenConnectorReference {
  referenceHash: string;
  schemaVersion: 'connector-reference-annotation-v1';
  analysisId: string;
  workflowId: string;
  imageHash: string;
  objectId: string;
  image: { width: number; height: number };
  annotationVersion: number;
  completedAt: number;
  independent: boolean;
  content: AnnotationContent;
  pixelCounts: {
    connector: number;
    redWire: number;
    blackWire: number;
    uncertain: number;
  };
}
export function connectorValidationEvidence(
  store: JobStore,
  analysisId: string,
) {
  ensureConnectorValidationTables(store);
  const rows = (table: string) =>
    store.db
      .prepare(`SELECT data FROM ${table} WHERE analysis_id=? ORDER BY rowid`)
      .all(analysisId)
      .map((r) => JSON.parse(r.data as string));
  return {
    drafts: rows('connector_annotation_drafts'),
    references: rows('connector_references'),
    evaluations: rows('connector_retrospective_evaluations'),
  };
}
export class ConnectorValidationService {
  readonly workflows: ConnectorWorkflowService;
  constructor(readonly store: JobStore) {
    ensureConnectorValidationTables(store);
    this.workflows = new ConnectorWorkflowService(store);
  }
  context(workflowId: string, analysisId: string) {
    const w = this.workflows.get(workflowId);
    if (w.contract.plan.analysisId !== analysisId)
      throw new AppError(
        404,
        'WORKFLOW_NOT_FOUND',
        'This workflow belongs to another analysis.',
      );
    const job = this.store.get(analysisId);
    return { w, job };
  }
  draft(workflowId: string, analysisId: string): Draft {
    const { w, job } = this.context(workflowId, analysisId);
    const row = this.store.db
      .prepare(
        'SELECT data FROM connector_annotation_drafts WHERE workflow_id=?',
      )
      .get(workflowId);
    if (row) return JSON.parse(row.data as string) as Draft;
    return {
      draftId: randomUUID(),
      workflowId,
      imageHash: job.imageHash,
      objectId: w.contract.plan.objectId,
      image: job.image,
      revision: 0,
      updatedAt: 0,
      content: {
        version: 'connector-annotation-v1',
        annotationMethod: 'manual_brush',
        regions: { connector: [], redWire: [], blackWire: [], uncertain: [] },
        reviewer: 'Unassigned',
        source: 'human_review',
        predictionExposure: 'unknown',
        originalImageOnly: false,
        independentAttestation: false,
        boundaryDefinition:
          'Visible connector body and exposed snap hardware; excludes insulated red and black wires. Hidden surfaces are not inferred.',
      },
    };
  }
  saveDraft(workflowId: string, analysisId: string, body: unknown) {
    const parsed = z
      .object({
        revision: z.number().int().nonnegative(),
        content: annotationContentSchema,
      })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new AppError(
        400,
        'INVALID_ANNOTATION',
        'Provide a valid draft revision and annotation.',
      );
    const { job } = this.context(workflowId, analysisId);
    try {
      validateAnnotation(parsed.data.content, job.image);
    } catch {
      throw new AppError(
        400,
        'INVALID_ANNOTATION',
        'Reference spans must be canonical, disjoint and inside the original image.',
      );
    }
    return this.store.transaction(() => {
      const current = this.draft(workflowId, analysisId);
      if (current.revision !== parsed.data.revision)
        throw new AppError(
          409,
          'ANNOTATION_CHANGED',
          'This draft changed. Reload before saving.',
        );
      if (
        current.content.reviewer === parsed.data.content.reviewer &&
        current.content.predictionExposure === 'seen_before' &&
        parsed.data.content.predictionExposure === 'never_seen'
      )
        throw new AppError(
          400,
          'EXPOSURE_CONFLICT',
          'A reviewer who has seen the prediction cannot later claim blinded status.',
        );
      const draft = {
        ...current,
        revision: current.revision + 1,
        content: parsed.data.content,
        updatedAt: Date.now(),
      };
      this.store.db
        .prepare(
          'INSERT INTO connector_annotation_drafts VALUES (?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET data=excluded.data',
        )
        .run(workflowId, analysisId, JSON.stringify(draft));
      return draft;
    });
  }
  freeze(workflowId: string, analysisId: string, revision: number) {
    this.context(workflowId, analysisId);
    return this.store.transaction(() => {
      const draft = this.draft(workflowId, analysisId);
      if (draft.revision !== revision || !revision)
        throw new AppError(
          409,
          'ANNOTATION_CHANGED',
          'Save and review the current draft before freezing.',
        );
      let checked: ReturnType<typeof validateAnnotation>;
      try {
        checked = validateAnnotation(draft.content, draft.image, true);
      } catch {
        throw new AppError(
          400,
          'INCOMPLETE_ANNOTATION',
          'Annotate the visible connector and both insulated wires before freezing.',
        );
      }
      const previous = this.store.db
        .prepare(
          'SELECT data FROM connector_references WHERE workflow_id=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(workflowId);
      if (previous) {
        const r = JSON.parse(
          previous.data as string,
        ) as FrozenConnectorReference;
        if (canonicalHash(r.content) === canonicalHash(draft.content)) return r;
      }
      const annotationVersion =
        Number(
          this.store.db
            .prepare(
              'SELECT COUNT(*) n FROM connector_references WHERE workflow_id=?',
            )
            .get(workflowId)!.n,
        ) + 1;
      if (
        Number(
          this.store.db
            .prepare(
              'SELECT COUNT(*) n FROM connector_references WHERE analysis_id=?',
            )
            .get(analysisId)!.n,
        ) >= 100
      )
        throw new AppError(
          409,
          'ANNOTATION_LIMIT',
          'The analysis reference limit was reached.',
        );
      if (annotationVersion > 20)
        throw new AppError(
          409,
          'ANNOTATION_LIMIT',
          'The frozen annotation version limit was reached.',
        );
      const priorExposure = this.store.db
        .prepare('SELECT data FROM connector_references WHERE analysis_id=?')
        .all(analysisId)
        .map((row) => JSON.parse(row.data as string))
        .some(
          (r) =>
            r.content.reviewer === draft.content.reviewer &&
            r.content.predictionExposure === 'seen_before',
        );
      const independent =
        !priorExposure &&
        draft.content.reviewer !== 'Unassigned' &&
        draft.content.source === 'human_review' &&
        ['manual_brush', 'manual_external'].includes(
          draft.content.annotationMethod,
        ) &&
        draft.content.predictionExposure === 'never_seen' &&
        draft.content.originalImageOnly &&
        draft.content.independentAttestation;
      const payload = {
        schemaVersion: 'connector-reference-annotation-v1' as const,
        analysisId,
        workflowId,
        imageHash: draft.imageHash,
        objectId: draft.objectId,
        image: draft.image,
        annotationVersion,
        completedAt: Date.now(),
        independent,
        content: draft.content,
        pixelCounts: checked.counts,
      };
      const reference = { referenceHash: canonicalHash(payload), ...payload };
      this.store.db
        .prepare('INSERT INTO connector_references VALUES (?,?,?,?)')
        .run(
          reference.referenceHash,
          analysisId,
          workflowId,
          JSON.stringify(reference),
        );
      return reference;
    });
  }
  reference(hash: string, workflowId: string): FrozenConnectorReference {
    const row = this.store.db
      .prepare('SELECT data FROM connector_references WHERE hash=?')
      .get(hash);
    if (!row)
      throw new AppError(
        404,
        'REFERENCE_NOT_FOUND',
        'Frozen reference not found for this workflow.',
      );
    const r = JSON.parse(row.data as string) as FrozenConnectorReference,
      { referenceHash, ...payload } = r;
    if (referenceHash !== canonicalHash(payload))
      throw new AppError(
        409,
        'REFERENCE_HASH_MISMATCH',
        'Frozen reference integrity check failed.',
      );
    const target = this.workflows.get(workflowId).contract.plan;
    if (
      r.analysisId !== target.analysisId ||
      r.imageHash !== target.imageHash ||
      r.objectId !== target.objectId
    )
      throw new AppError(
        409,
        'REFERENCE_TARGET_MISMATCH',
        'Reference and prediction must describe the same object and photograph.',
      );
    return r;
  }
  evaluate(
    workflowId: string,
    analysisId: string,
    referenceHash: string,
    strategy:
      | 'A-auto-inventory-box'
      | 'B-auto-baseline-interior' = 'A-auto-inventory-box',
  ) {
    const { w } = this.context(workflowId, analysisId),
      r = this.reference(referenceHash, workflowId),
      e = this.workflows.evidence(workflowId, analysisId);
    if (
      !e.experiment ||
      !['completed', 'failed', 'interrupted', 'released'].includes(
        e.experiment.status,
      )
    )
      throw new AppError(
        409,
        'EXPERIMENT_NOT_FINISHED',
        'Use an already recorded experiment.',
      );
    const report = e.experiment.report as {
      measurements: Array<{
        variant: string;
        status?: string;
        native?: Array<{
          observationId: string;
          encodedMask: {
            width: number;
            height: number;
            encoding: 'one_bit' | 'lossless';
            payload: string;
          };
        }>;
        observations?: Array<{
          id: string;
          bbox: [number, number, number, number];
        }>;
      }>;
    };
    const audit = auditConnectorEvidence(e),
      checked = validateAnnotation(r.content, r.image, true);
    const reviews = new Map(
      w.evaluations.flatMap((v) => v.reviews).map((v) => [v.observationId, v]),
    );
    const m = report.measurements.find((m) => m.variant === strategy);
    const metrics = (m?.native ?? []).map((n) => {
      const o = m?.observations?.find((o) => o.id === n.observationId);
      if (
        !o ||
        o.bbox[2] !== n.encodedMask.width ||
        o.bbox[3] !== n.encodedMask.height
      )
        throw new AppError(
          409,
          'NATIVE_MASK_MISMATCH',
          'Native mask coordinate binding failed.',
        );
      const raster = decodeMaskToRaster(n.encodedMask),
        prediction = new Uint8Array(r.image.width * r.image.height);
      for (let y = 0; y < n.encodedMask.height; y++)
        for (let x = 0; x < n.encodedMask.width; x++) {
          const px = o.bbox[0] + x,
            py = o.bbox[1] + y;
          if (px >= r.image.width || py >= r.image.height)
            throw new Error('Mask outside source image');
          prediction[py * r.image.width + px] = raster[
            y * n.encodedMask.width + x
          ]
            ? 1
            : 0;
        }
      const { excludedPixels: _excluded, ...scores } = pixelMetrics(
        prediction,
        checked.regions.connector,
        checked.regions.redWire,
        checked.regions.blackWire,
        checked.regions.uncertain,
      );
      const review = reviews.get(o.id),
        identityCorrectness = review?.decision ?? 'unreviewed';
      const accepted =
        (r.independent || r.content.source === 'synthetic_fixture') &&
        identityCorrectness === 'correct' &&
        (review?.source === 'human_review' ||
          r.content.source === 'synthetic_fixture') &&
        scores.iou >= connectorThresholds.minimumIoU &&
        scores.recall >= connectorThresholds.minimumRecall &&
        scores.leakage !== null &&
        scores.leakage <= connectorThresholds.maximumConductorLeakage &&
        audit.provenanceValid &&
        audit.previewAgreement;
      return { observationId: o.id, ...scores, identityCorrectness, accepted };
    });
    const qualified = r.independent || r.content.source === 'synthetic_fixture',
      pending = metrics.some((m) =>
        ['unreviewed', 'uncertain'].includes(m.identityCorrectness),
      );
    const status =
      !qualified || pending || !metrics.length || !audit.provenanceValid
        ? 'incomplete'
        : metrics.filter((m) => m.accepted).length === 1
          ? r.content.source === 'synthetic_fixture'
            ? 'synthetic_pass'
            : 'passed'
          : 'failed';
    const payload = {
      workflowId,
      experimentId: e.experiment.experimentId,
      objectId: r.objectId,
      imageHash: r.imageHash,
      sourceSnapshotHash: w.contract.plan.sceneSnapshotRef.snapshotHash,
      reportHash: audit.reportHash,
      predictionHash: audit.predictionHash,
      referenceHash: r.referenceHash,
      evaluatedAt: Date.now(),
      mode: 'retrospective_diagnostic' as const,
      strategy,
      thresholds: connectorThresholds,
      configurationHash: canonicalHash(connectorThresholds),
      originalContractPreserved: true as const,
      independentGroundTruth: r.independent,
      blinded: r.content.predictionExposure === 'never_seen',
      status,
      abComparison: ['A-auto-inventory-box', 'B-auto-baseline-interior'].every(
        (variant) =>
          report.measurements.some(
            (m) =>
              m.variant === variant &&
              ['candidates_returned', 'empty_output'].includes(m.status ?? ''),
          ),
      )
        ? 'complete'
        : 'incomplete',
      metrics,
      provenanceValid: audit.provenanceValid,
      previewAgreement: audit.previewAgreement,
      note: 'Retrospective validation of saved Strategy A pixels against a separately frozen reference. Original protocol and A/B status are unchanged. Candidate acceptance is separate from A/B completeness; synthetic or unblinded/provisional references cannot unlock the photographic gate.',
    };
    const previous = this.store.db
      .prepare(
        'SELECT data FROM connector_retrospective_evaluations WHERE workflow_id=? ORDER BY rowid DESC',
      )
      .all(workflowId)
      .map((row) => JSON.parse(row.data as string))
      .find(
        (row) =>
          row.referenceHash === r.referenceHash &&
          row.strategy === strategy &&
          row.configurationHash === canonicalHash(connectorThresholds) &&
          row.reportHash === audit.reportHash &&
          row.predictionHash === audit.predictionHash &&
          canonicalHash(row.metrics) === canonicalHash(metrics),
      );
    if (previous) return retrospectiveResultSchema.parse(previous);
    if (
      Number(
        this.store.db
          .prepare(
            'SELECT COUNT(*) n FROM connector_retrospective_evaluations WHERE analysis_id=?',
          )
          .get(analysisId)!.n,
      ) >= 200
    )
      throw new AppError(
        409,
        'EVALUATION_LIMIT',
        'The analysis retrospective evaluation limit was reached.',
      );
    const result = retrospectiveResultSchema.parse({
      evaluationId: canonicalHash(payload),
      ...payload,
    });
    this.store.db
      .prepare(
        'INSERT INTO connector_retrospective_evaluations VALUES (?,?,?,?)',
      )
      .run(result.evaluationId, analysisId, workflowId, JSON.stringify(result));
    return result;
  }
  pointAudit(workflowId: string, analysisId: string) {
    const { w } = this.context(workflowId, analysisId),
      e = this.workflows.evidence(workflowId, analysisId);
    const sam = this.store.getSnapshot(
      w.contract.plan.samSnapshotRef.samSnapshotId,
    ).snapshot;
    const nativeIds = e.sourceSnapshot.graph.observations
      .filter((o) =>
        sam.candidates.some(
          (c) => c.id === o.sourceCandidateId && c.encodedMask,
        ),
      )
      .map((o) => o.id);
    const predictionIds =
      (
        e.experiment?.report as
          | { measurements?: Array<{ observations?: Array<{ id: string }> }> }
          | undefined
      )?.measurements?.flatMap((m) => m.observations?.map((o) => o.id) ?? []) ??
      [];
    return {
      workflowId,
      sourceSnapshotHash: w.contract.plan.sceneSnapshotRef.snapshotHash,
      ...auditAutomaticPoint(
        e.sourceSnapshot.graph,
        w.contract.plan.objectId,
        nativeIds,
        predictionIds,
      ),
    };
  }
  summary(analysisId: string) {
    const all = connectorValidationEvidence(this.store, analysisId);
    return {
      evidenceLinks: this.store.db
        .prepare('SELECT id FROM connector_workflows WHERE analysis_id=?')
        .all(analysisId)
        .map((row) => ({
          workflowId: row.id as string,
          url: `/api/analyses/${analysisId}/connector-validation-evidence?workflowId=${row.id}`,
        })),
      references: all.references.map((r: FrozenConnectorReference) => ({
        referenceHash: r.referenceHash,
        workflowId: r.workflowId,
        annotationVersion: r.annotationVersion,
        objectId: r.objectId,
        frozenAt: r.completedAt,
        independent: r.independent,
        reviewer: r.content.reviewer,
        source: r.content.source,
        predictionExposure: r.content.predictionExposure,
        pixelCounts: r.pixelCounts,
      })),
      evaluations: all.evaluations,
      gates: connectorGates(this.store, this.store.get(analysisId)),
    };
  }
  evidence(workflowId: string, analysisId: string) {
    this.context(workflowId, analysisId);
    const all = connectorValidationEvidence(this.store, analysisId);
    return {
      schemaVersion: 'praxis-connector-validation-evidence-v1',
      analysisId,
      workflowId,
      source: this.workflows.evidence(workflowId, analysisId),
      references: all.references.filter(
        (r) =>
          r.workflowId === workflowId ||
          all.evaluations.some(
            (e) =>
              e.workflowId === workflowId &&
              e.referenceHash === r.referenceHash,
          ),
      ),
      evaluations: all.evaluations.filter((r) => r.workflowId === workflowId),
      draft: this.draft(workflowId, analysisId),
      audit: auditConnectorEvidence(
        this.workflows.evidence(workflowId, analysisId),
      ),
      pointAudit: this.pointAudit(workflowId, analysisId),
      gate: connectorGates(this.store, this.store.get(analysisId)),
      note: 'No inference is sent by annotation, evaluation or export. Missing independent reference means the connector gate remains blocked.',
    };
  }
}
