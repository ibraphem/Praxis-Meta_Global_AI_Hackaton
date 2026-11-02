import { ConnectorJunctionService } from './connector-junctions.js';
import type {
  ConnectivityEvent,
  ConnectivitySource,
  ConnectivityView,
  ConnectivityEvidence,
} from '../schemas/connectivity-view.js';
export type { ConnectivityView } from '../schemas/connectivity-view.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Job, JobStore } from './store.js';
import { AppError } from '../lib/errors.js';
import { canonicalHash } from '../lib/canonical-json.js';
import {
  circuitBoardSchema,
  circuitTargetSchema,
  circuitPointSchema,
  type CircuitComponent,
  type CircuitProof,
} from '../schemas/connectivity.js';
import {
  buildConnectivity,
  compareConnectivity,
  validateCircuitInput,
  validateCircuitReference,
  conductiveTypes,
} from '../services/connectivity.js';
import {
  allHoles,
  pickHole,
  type Calibration,
  type Rail,
} from '../shared/calibration.js';

export const connectivityTables = [
  'connectivity_sources',
  'connectivity_events',
  'connectivity_graphs',
  'connectivity_references',
  'connectivity_comparisons',
] as const;
export function ensureConnectivityTables(store: JobStore) {
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS connectivity_sources (analysis_id TEXT PRIMARY KEY,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS connectivity_events (id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS connectivity_graphs (id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS connectivity_references (id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS connectivity_comparisons (id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,data TEXT NOT NULL);`);
  for (const table of connectivityTables.slice(1))
    store.db.exec(
      `CREATE INDEX IF NOT EXISTS ${table}_analysis ON ${table}(analysis_id); CREATE TRIGGER IF NOT EXISTS immutable_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Connectivity evidence is immutable'); END;`,
    );
}
const reviewMeta = {
  expectedRevision: z.number().int().nonnegative(),
  reviewer: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(8).max(2000),
};
const identity = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export function connectivityPerceptionHash(job: Job) {
  return canonicalHash({
    samSnapshot: job.sam.snapshotRef ?? null,
    result: job.candidateResult ?? job.muse.result ?? job.sam.result ?? null,
  });
}
export class ConnectivityService {
  constructor(readonly store: JobStore) {
    ensureConnectivityTables(store);
  }
  private rows<T>(table: string, id: string): T[] {
    return this.store.db
      .prepare(`SELECT data FROM ${table} WHERE analysis_id=? ORDER BY rowid`)
      .all(id)
      .map((r) => JSON.parse(r.data as string) as T);
  }
  private source(id: string): ConnectivitySource | null {
    const r = this.store.db
      .prepare('SELECT data FROM connectivity_sources WHERE analysis_id=?')
      .get(id);
    return r ? JSON.parse(r.data as string) : null;
  }
  view(id: string): ConnectivityView {
    const job = this.store.get(id),
      source = this.source(id),
      graphs = this.rows<NonNullable<ConnectivityView['graph']>>(
        'connectivity_graphs',
        id,
      );
    const inputHash = source ? canonicalHash(source.input) : null;
    const graph =
      [...graphs].reverse().find((g) => g.inputHash === inputHash) ??
      graphs.at(-1) ??
      null;
    const sourceChanged =
      !!source &&
      (source.sourceSceneHash !==
        (job.scene?.snapshotRef?.snapshotHash ?? null) ||
        source.sourceAnalysisRevision !== job.revision ||
        source.sourcePerceptionHash !== connectivityPerceptionHash(job));
    return {
      schemaVersion: 'praxis-connectivity-view-v1',
      analysisId: id,
      imageHash: job.imageHash,
      source,
      history: this.rows('connectivity_events', id),
      graph,
      graphStale:
        !source || !graph || graph.inputHash !== inputHash || sourceChanged,
      references: this.rows('connectivity_references', id),
      comparisons: this.rows('connectivity_comparisons', id),
      additionalInferenceRequests: 0,
      evidenceUrl: `/api/analyses/${id}/connectivity-evidence`,
    };
  }
  evidence(id: string): ConnectivityEvidence {
    const work = () => ({
      ...this.view(id),
      graphHistory: this.rows<NonNullable<ConnectivityView['graph']>>(
        'connectivity_graphs',
        id,
      ),
    });
    return this.store.inTransaction ? work() : this.store.transaction(work);
  }
  private change(
    id: string,
    meta: z.infer<z.ZodObject<typeof reviewMeta>>,
    action: string,
    payload: unknown,
    fn: (source: ConnectivitySource, proof: CircuitProof) => void,
  ) {
    return this.store.transaction(() => {
      const job = this.store.get(id),
        source = this.source(id) ?? {
          input: {
            schemaVersion: 'praxis-connectivity-input-v1' as const,
            analysisId: id,
            imageHash: job.imageHash,
            revision: 0,
            validationScope: 'photograph',
            coverage: { state: 'unresolved', evidence: [] },
            boards: [],
            components: [],
            terminals: [],
            associations: [],
          },
          workspace: null,
          sourceSceneHash: job.scene?.snapshotRef?.snapshotHash ?? null,
          sourceAnalysisRevision: job.revision,
          sourcePerceptionHash: connectivityPerceptionHash(job),
        };
      if (source.input.revision !== meta.expectedRevision)
        throw new AppError(
          409,
          'STALE_CONNECTIVITY',
          'Reload the current connectivity revision before saving.',
        );
      if (this.rows('connectivity_events', id).length >= 500)
        throw new AppError(
          409,
          'CONNECTIVITY_LIMIT',
          'The retained review limit was reached.',
        );
      const eventId = randomUUID(),
        timestamp = Date.now(),
        proof: CircuitProof = {
          id: eventId,
          source:
            action === 'workspace_import' ? 'workspace_import' : 'human_review',
          reviewer: meta.reviewer,
          note: meta.reason,
          timestamp,
        };
      const targetId =
        typeof payload === 'object' && payload !== null && 'targetId' in payload
          ? String(payload.targetId)
          : null;
      const previousValue = JSON.parse(
        JSON.stringify(
          action === 'workspace_import'
            ? source.workspace
            : (source.input.boards.find((v) => v.id === targetId) ??
                source.input.components.find((v) => v.id === targetId) ??
                source.input.terminals.find((v) => v.id === targetId) ??
                source.input.associations.find((v) => v.id === targetId) ??
                null),
        ),
      );
      if (action !== 'coverage')
        source.input.coverage = { state: 'unresolved', evidence: [] };
      fn(source, proof);
      source.input.revision++;
      validateCircuitInput(source.input);
      const event: ConnectivityEvent = {
        id: eventId,
        action,
        reviewer: meta.reviewer,
        reason: meta.reason,
        timestamp,
        baseRevision: meta.expectedRevision,
        revision: source.input.revision,
        payload,
        inputHash: canonicalHash(source.input),
        previousValue,
        sourceBindings: {
          imageHash: job.imageHash,
          analysisRevision: job.revision,
          sceneSnapshotHash: job.scene?.snapshotRef?.snapshotHash ?? null,
          perceptionHash: connectivityPerceptionHash(job),
          samSnapshotHash: job.sam.snapshotRef?.samSnapshotHash ?? null,
        },
      };
      this.store.db
        .prepare('INSERT INTO connectivity_events VALUES (?,?,?)')
        .run(eventId, id, JSON.stringify(event));
      this.store.db
        .prepare(
          'INSERT INTO connectivity_sources VALUES (?,?) ON CONFLICT(analysis_id) DO UPDATE SET data=excluded.data',
        )
        .run(id, JSON.stringify(source));
      return this.view(id);
    });
  }
  importWorkspace(id: string, raw: unknown) {
    const body = z
      .object({
        ...reviewMeta,
        imageHash: z.string().regex(/^[a-f0-9]{64}$/),
        workspace: z
          .object({
            boards: z
              .array(
                z
                  .object({
                    calibration: circuitBoardSchema.shape.calibration,
                    rails: circuitBoardSchema.shape.rails,
                    revision: z.number().int().positive(),
                  })
                  .strict(),
              )
              .max(10),
            assignments: z.array(z.record(z.string(), z.unknown())).max(100),
            reviews: z.array(z.unknown()).max(100),
            analysisRunId: z.string().nullable(),
            photoId: z.string().min(1),
          })
          .strict(),
      })
      .strict()
      .parse(raw);
    const job = this.store.get(id);
    if (body.imageHash !== job.imageHash)
      throw new AppError(
        409,
        'CONNECTIVITY_IMAGE_MISMATCH',
        'Workspace belongs to another photograph.',
      );
    return this.change(
      id,
      body,
      'workspace_import',
      body.workspace,
      (s, proof) => {
        const analysisChanged =
          s.sourcePerceptionHash !== connectivityPerceptionHash(job) ||
          s.sourceAnalysisRevision !== job.revision ||
          s.sourceSceneHash !== (job.scene?.snapshotRef?.snapshotHash ?? null);
        if (analysisChanged) {
          for (const c of s.input.components)
            if (c.objectRef.kind !== 'manual') {
              c.state = 'unresolved';
              c.continuity = 'unresolved';
              for (const a of s.input.associations)
                if (c.terminalIds.includes(a.terminalId))
                  a.state = 'unresolved';
            }
        }
        s.sourceSceneHash = job.scene?.snapshotRef?.snapshotHash ?? null;
        s.sourceAnalysisRevision = job.revision;
        s.sourcePerceptionHash = connectivityPerceptionHash(job);
        s.workspace = body.workspace;
        s.physicalHints = {
          sceneSnapshot: job.scene?.snapshotRef ?? null,
          terminals: job.scene?.graph?.terminals ?? [],
          attachments: job.scene?.graph?.attachments ?? [],
          connectorJunctions: new ConnectorJunctionService(
            this.store,
          ).forAnalysis(id),
          note: 'Physical observations and housing-entry reviews are retained as hints only. No electrical promotion.',
        };
        s.input.boards = body.workspace.boards.map((b) => {
          if (
            b.calibration.image.width !== job.image.width ||
            b.calibration.image.height !== job.image.height
          )
            throw new AppError(
              409,
              'CONNECTIVITY_IMAGE_MISMATCH',
              'Calibration image dimensions differ.',
            );
          const old = s.input.boards.find(
            (o) => o.id === b.calibration.breadboardId,
          );
          const same =
            old &&
            canonicalHash([old.calibration, old.rails, old.revision]) ===
              canonicalHash([b.calibration, b.rails, b.revision]);
          return {
            id: b.calibration.breadboardId,
            ...b,
            topologyState: same ? old.topologyState : 'unresolved',
            evidence: same ? old.evidence : [proof],
          };
        });
        const detected = job.scene?.graph?.objects ?? [];
        const baseline =
          (job.candidateResult ?? job.muse.result ?? job.sam.result)?.objects ??
          [];
        const existing = new Map(s.input.components.map((c) => [c.id, c]));
        const add = (
          objectId: string,
          type: string,
          label: string,
          bbox: CircuitComponent['bbox'],
          kind: 'scene' | 'baseline',
        ) => {
          const cid = `${kind}:${objectId}`;
          if (existing.has(cid)) return;
          const count =
            type === 'npn_transistor' ? 3 : type === 'breadboard' ? 0 : 2;
          const c: CircuitComponent = {
            id: cid,
            label,
            type,
            objectRef: { kind, id: objectId },
            bbox,
            terminalIds: Array.from(
              { length: count },
              (_, i) => `${cid}:t${i + 1}`,
            ),
            state: 'unresolved',
            continuity: 'unresolved',
            evidence: [proof],
          };
          s.input.components.push(c);
          for (const [i, tid] of c.terminalIds.entries())
            s.input.terminals.push({
              id: tid,
              componentId: cid,
              label: `Lead ${i + 1}`,
              role: null,
              roleState: 'unresolved',
              position: null,
              evidence: [proof],
            });
        };
        for (const c of baseline) add(c.id, c.type, c.id, c.bbox, 'baseline');
        for (const o of detected) {
          // Scene hypotheses stay separate until explicitly mapped. No label/overlap identity merge.
          if (o.category !== 'board')
            add(
              o.id,
              o.category === 'conductor' ? 'conductor' : 'unknown',
              o.proposedType,
              o.bbox,
              'scene',
            );
        }
        for (const raw of body.workspace.assignments) {
          const a = z
              .object({
                id: identity,
                photoId: z.string(),
                analysisRunId: z.string(),
                wireCandidateId: identity,
                endpoints: z.tuple([
                  z.unknown().nullable(),
                  z.unknown().nullable(),
                ]),
              })
              .passthrough()
              .parse(raw),
            cid = `baseline:${a.wireCandidateId}`;
          if (
            a.photoId !== body.workspace.photoId ||
            a.analysisRunId !== body.workspace.analysisRunId
          )
            continue;
          const c = s.input.components.find(
            (c) => c.id === cid && c.type === 'jumper_wire',
          );
          if (!c) continue;
          for (const [i, endpoint] of a.endpoints.entries()) {
            const tid = c.terminalIds[i]!,
              aid = `import:${a.id}:${i}`,
              old = s.input.associations.find((v) => v.id === aid),
              proposalRef = canonicalHash(endpoint);
            if (old?.originalProposalRef === proposalRef) continue;
            let target: z.infer<typeof circuitTargetSchema> | null = null,
              position = null;
            const e = z
              .object({
                boardId: identity,
                calibrationRevision: z.number().int(),
                selectedImagePosition: circuitPointSchema,
                resolution: z
                  .object({ status: z.string(), holeId: z.string().optional() })
                  .passthrough(),
              })
              .passthrough()
              .safeParse(endpoint);
            if (e.success) {
              position =
                e.data.selectedImagePosition.x < job.image.width &&
                e.data.selectedImagePosition.y < job.image.height
                  ? e.data.selectedImagePosition
                  : null;
              const b = s.input.boards.find(
                (b) =>
                  b.id === e.data.boardId &&
                  b.revision === e.data.calibrationRevision,
              );
              const picked =
                b &&
                pickHole(
                  b.calibration as Calibration,
                  b.rails as Rail[],
                  e.data.selectedImagePosition,
                  'image_click',
                );
              if (
                picked &&
                e.data.resolution.status === 'resolved' &&
                picked.hole === e.data.resolution.holeId
              )
                target = {
                  kind: 'hole',
                  boardId: b!.id,
                  holeId: picked.hole,
                  calibrationRevision: b!.revision,
                };
            }
            s.input.associations = s.input.associations.filter(
              (v) => v.id !== aid,
            );
            s.input.associations.push({
              id: aid,
              terminalId: tid,
              target,
              type: 'insertion',
              state: 'unresolved',
              evidence: [proof],
              originalProposalRef: proposalRef,
            });
            const terminal = s.input.terminals.find((t) => t.id === tid)!;
            terminal.position = position;
          }
        }
      },
    );
  }
  review(id: string, raw: unknown) {
    const body = z
      .object({
        ...reviewMeta,
        action: z.enum([
          'topology',
          'component',
          'terminal',
          'association',
          'add_component',
          'coverage',
        ]),
        targetId: identity,
        value: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(raw);
    return this.change(id, body, body.action, body, (s, p) => {
      if (
        s.sourceAnalysisRevision !== this.store.get(id).revision ||
        s.sourcePerceptionHash !==
          connectivityPerceptionHash(this.store.get(id)) ||
        s.sourceSceneHash !==
          (this.store.get(id).scene?.snapshotRef?.snapshotHash ?? null)
      )
        throw new AppError(
          409,
          'STALE_CONNECTIVITY',
          'Import the current scene before reviewing.',
        );
      if (body.action === 'coverage') {
        const v = z
          .object({ confirmed: z.boolean() })
          .strict()
          .parse(body.value);
        s.input.coverage = {
          state: v.confirmed ? 'confirmed_manual' : 'unresolved',
          evidence: [p],
        };
      }
      if (body.action === 'add_component') {
        const v = z
          .object({
            label: z.string().trim().min(1).max(160),
            type: z.enum([
              'led',
              'resistor',
              'ldr',
              'npn_transistor',
              'power_source',
              'jumper_wire',
              'conductor',
              'unknown',
            ]),
          })
          .strict()
          .parse(body.value);
        if (s.input.components.some((c) => c.id === body.targetId))
          throw Error('Component identity already exists.');
        const terminalIds = Array.from(
          { length: v.type === 'npn_transistor' ? 3 : 2 },
          (_, i) => `${body.targetId}:t${i + 1}`,
        );
        s.input.components.push({
          id: body.targetId,
          label: v.label,
          type: v.type,
          objectRef: { kind: 'manual', id: body.targetId },
          bbox: null,
          terminalIds,
          state: 'unresolved',
          continuity: 'unresolved',
          evidence: [p],
        });
        for (const [i, tid] of terminalIds.entries())
          s.input.terminals.push({
            id: tid,
            componentId: body.targetId,
            label: `Lead ${i + 1}`,
            role: null,
            roleState: 'unresolved',
            position: null,
            evidence: [p],
          });
      }
      if (body.action === 'topology') {
        const v = z
            .object({ confirmed: z.boolean() })
            .strict()
            .parse(body.value),
          b = s.input.boards.find((b) => b.id === body.targetId);
        if (!b) throw Error('Unknown board.');
        b.topologyState = v.confirmed ? 'confirmed_manual' : 'unresolved';
        b.evidence = [p];
      }
      if (body.action === 'component') {
        const v = z
            .object({
              type: z.enum([
                'breadboard',
                'jumper_wire',
                'conductor',
                'led',
                'resistor',
                'ldr',
                'npn_transistor',
                'battery',
                'power_source',
                'dc_power_source',
                'unknown',
              ]),
              confirmed: z.boolean(),
              intactConductor: z.boolean(),
              excluded: z.boolean().default(false),
            })
            .strict()
            .parse(body.value),
          c = s.input.components.find((c) => c.id === body.targetId);
        if (!c) throw Error('Unknown component.');
        const needed =
          v.type === 'npn_transistor' ? 3 : v.type === 'breadboard' ? 0 : 2;
        if (c.terminalIds.length !== needed) {
          if (c.terminalIds.length > needed)
            throw Error(
              'Resolve existing extra terminals before reducing a component model.',
            );
          while (c.terminalIds.length < needed) {
            const tid = `${c.id}:t${c.terminalIds.length + 1}`;
            c.terminalIds.push(tid);
            s.input.terminals.push({
              id: tid,
              componentId: c.id,
              label: `Lead ${c.terminalIds.length}`,
              role: null,
              roleState: 'unresolved',
              position: null,
              evidence: [p],
            });
          }
        }
        c.type = v.type;
        c.state = v.excluded
          ? 'rejected'
          : v.confirmed
            ? 'confirmed_manual'
            : 'unresolved';
        c.continuity =
          !v.excluded &&
          v.confirmed &&
          v.intactConductor &&
          conductiveTypes.has(v.type)
            ? 'confirmed_manual'
            : 'unresolved';
        c.evidence = [...c.evidence, p];
      }
      if (body.action === 'terminal') {
        const v = z
            .object({
              role: z.string().trim().min(1).max(80).nullable(),
              roleSource: z.string().trim().min(8).max(2000),
              position: circuitPointSchema.nullable(),
            })
            .strict()
            .parse(body.value),
          t = s.input.terminals.find((t) => t.id === body.targetId);
        if (!t) throw Error('Unknown terminal.');
        if (
          v.position &&
          (v.position.x >= this.store.get(id).image.width ||
            v.position.y >= this.store.get(id).image.height)
        )
          throw Error(
            'Terminal position must lie inside the original photograph.',
          );
        t.role = v.role;
        t.roleState = v.role ? 'confirmed_manual' : 'unresolved';
        t.position = v.position;
        t.evidence = [
          ...t.evidence,
          { ...p, note: `${p.note} Role source: ${v.roleSource}` },
        ];
      }
      if (body.action === 'association') {
        const v = z
          .object({
            terminalId: identity,
            target: circuitTargetSchema.nullable(),
            type: z.enum([
              'insertion',
              'conductive_contact',
              'housing_entry',
              'proximity',
            ]),
            decision: z.enum(['confirmed_manual', 'unresolved', 'rejected']),
          })
          .strict()
          .parse(body.value);
        if (
          v.decision === 'confirmed_manual' &&
          (!v.target || !['insertion', 'conductive_contact'].includes(v.type))
        )
          throw Error(
            'Only explicitly supported insertion/contact can confirm electrical association.',
          );
        if (v.target?.kind === 'hole') {
          const b = s.input.boards.find(
            (b) =>
              b.id === (v.target?.kind === 'hole' ? v.target.boardId : null),
          );
          if (
            !b ||
            b.revision !== v.target.calibrationRevision ||
            !allHoles(b.calibration as Calibration, b.rails as Rail[]).some(
              (h) =>
                h.id === (v.target?.kind === 'hole' ? v.target.holeId : null),
            )
          )
            throw new AppError(
              409,
              'STALE_CALIBRATION',
              'Choose the current board revision.',
            );
        }
        const old = s.input.associations.find((a) => a.id === body.targetId);
        if (old && old.terminalId !== v.terminalId)
          throw Error('Association terminal identity cannot change.');
        s.input.associations = s.input.associations.filter(
          (a) => a.id !== body.targetId,
        );
        s.input.associations.push({
          id: body.targetId,
          terminalId: v.terminalId,
          target: v.target,
          type: v.type,
          state: v.decision,
          evidence: [...(old?.evidence ?? []), p],
          originalProposalRef: old?.originalProposalRef ?? null,
        });
      }
    });
  }
  build(id: string, raw: unknown) {
    const b = z
      .object({ expectedRevision: z.number().int().nonnegative() })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const s = this.source(id);
      if (
        !s ||
        s.input.revision !== b.expectedRevision ||
        s.sourceAnalysisRevision !== this.store.get(id).revision ||
        s.sourcePerceptionHash !==
          connectivityPerceptionHash(this.store.get(id)) ||
        s.sourceSceneHash !==
          (this.store.get(id).scene?.snapshotRef?.snapshotHash ?? null)
      )
        throw new AppError(
          409,
          'STALE_CONNECTIVITY',
          'Save current workspace evidence before graph construction.',
        );
      const graph = buildConnectivity(s.input),
        inputHash = canonicalHash(s.input),
        record = {
          graph,
          inputHash,
          sourceRevision: s.input.revision,
          builtAt: Date.now(),
        };
      const key = canonicalHash([id, inputHash]);
      this.store.db
        .prepare('INSERT OR IGNORE INTO connectivity_graphs VALUES (?,?,?)')
        .run(key, id, JSON.stringify(record));
      return this.view(id);
    });
  }
  registerReference(id: string, raw: unknown) {
    const b = z
        .object({
          ...reviewMeta,
          reference: z.unknown(),
          mapping: z.record(identity, identity),
        })
        .strict()
        .parse(raw),
      reference = validateCircuitReference(b.reference);
    return this.store.transaction(() => {
      const s = this.source(id);
      if (!s || s.input.revision !== b.expectedRevision)
        throw new AppError(
          409,
          'STALE_CONNECTIVITY',
          'Reload the current evidence.',
        );
      for (const [ref, object] of Object.entries(b.mapping))
        if (
          !reference.components.some((c) => c.id === ref) ||
          !s.input.components.some((c) => c.id === object)
        )
          throw Error('Unknown reference mapping.');
      if (
        new Set(Object.values(b.mapping)).size !==
        Object.values(b.mapping).length
      )
        throw Error('Reference mapping must be one-to-one.');
      const key = canonicalHash([id, reference, b.mapping]);
      const record = {
        id: key,
        reference,
        mapping: b.mapping,
        reviewer: b.reviewer,
        reason: b.reason,
        timestamp: Date.now(),
      };
      this.store.db
        .prepare('INSERT OR IGNORE INTO connectivity_references VALUES (?,?,?)')
        .run(key, id, JSON.stringify(record));
      return this.view(id);
    });
  }
  compare(id: string, raw: unknown) {
    const b = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        referenceId: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const v = this.view(id);
      if (
        v.graphStale ||
        !v.graph ||
        v.source?.input.revision !== b.expectedRevision
      )
        throw new AppError(
          409,
          'STALE_CONNECTIVITY',
          'Rebuild the graph from current evidence before diagnosis.',
        );
      const r = v.references.find((r) => r.id === b.referenceId);
      if (!r) throw Error('Unknown reference circuit.');
      const comparison = compareConnectivity(
          v.graph.graph,
          r.reference,
          r.mapping,
        ),
        record = {
          id: canonicalHash([
            id,
            comparison.comparisonHash,
            b.expectedRevision,
          ]),
          comparison,
          sourceRevision: b.expectedRevision,
          timestamp: Date.now(),
        };
      this.store.db
        .prepare(
          'INSERT OR IGNORE INTO connectivity_comparisons VALUES (?,?,?)',
        )
        .run(record.id, id, JSON.stringify(record));
      return this.view(id);
    });
  }
}
