import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JobStore } from './store.js';
import type { MetaClient } from '../lib/meta-client.js';
import { AppError } from '../lib/errors.js';
import { prepareImage } from '../services/image.js';
import {
  buildConnectivity,
  validateCircuitInput,
} from '../services/connectivity.js';
import { connectionProjection } from '../services/connection-projection.js';
import {
  automaticBoardInputs,
  proposedHole,
  proposeAutomaticCircuit,
} from '../services/automatic-circuit.js';
import {
  inventorySchema,
  type CircuitInspection,
} from '../shared/automatic-circuit.js';
import {
  allHoles,
  calibrateBoard,
  project,
  unproject,
  type Calibration,
  type Rail,
} from '../shared/calibration.js';
import { circuitInputSchema } from '../schemas/connectivity.js';
import {
  geometryUploadSchema,
  localEndpointSchema,
} from '../shared/hybrid-geometry.js';
import { proposeHybridCircuit } from '../services/hybrid-circuit.js';

const inspectionReviewSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    reviewer: z.string().trim().min(1).max(100),
    input: circuitInputSchema,
  })
  .strict();
const recalibrationRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    observations: inventorySchema,
    input: circuitInputSchema.optional(),
  })
  .strict();

export class AutomaticCircuitService {
  private tasks = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  constructor(
    private store: JobStore,
    private client: MetaClient,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS automatic_circuit_inspections (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, image BLOB NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automatic_circuit_proposals (inspection_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automatic_circuit_reviews (inspection_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(inspection_id,revision));`);
    for (const row of store.db
      .prepare('SELECT id,data FROM automatic_circuit_inspections')
      .all()) {
      const v = JSON.parse(row.data as string) as CircuitInspection;
      if (v.status === 'running' || v.status === 'queued') {
        v.status = v.input ? 'needs_review' : 'failed';
        v.error =
          'Inspection was interrupted. Saved proposals remain available; no model request was retried.';
        this.save(v);
      }
    }
  }
  private save(v: CircuitInspection) {
    this.store.db
      .prepare('UPDATE automatic_circuit_inspections SET data=? WHERE id=?')
      .run(JSON.stringify(v), v.id);
  }
  get(id: string): CircuitInspection {
    const row = this.store.db
      .prepare('SELECT data FROM automatic_circuit_inspections WHERE id=?')
      .get(id);
    if (!row)
      throw new AppError(
        404,
        'INSPECTION_NOT_FOUND',
        'The circuit inspection was not found.',
      );
    return JSON.parse(row.data as string) as CircuitInspection;
  }
  image(id: string) {
    this.get(id);
    return this.store.db
      .prepare('SELECT image FROM automatic_circuit_inspections WHERE id=?')
      .get(id)!.image as Uint8Array;
  }
  async create(bytes: Buffer, rawGeometry?: unknown) {
    if (this.tasks.size >= this.store.config.MAX_CONCURRENT_ANALYSES)
      throw new AppError(
        503,
        'SERVER_BUSY',
        'Circuit inspection is busy. Try again shortly.',
      );
    const release = this.store.experiments.enterLegacyRequest(
      this.store.config.CIRCUIT_INSPECTION_TIMEOUT_MS,
    );
    const id = randomUUID(),
      controller = new AbortController();
    // Reserve capacity before asynchronous image decoding.
    this.tasks.set(id, { controller, promise: Promise.resolve() });
    try {
      const image = await prepareImage(bytes, this.store.config);
      const parsed =
        rawGeometry === undefined
          ? null
          : geometryUploadSchema.safeParse(rawGeometry);
      if (parsed && !parsed.success)
        throw new AppError(
          400,
          'INVALID_GEOMETRY',
          'Local grid measurements are invalid.',
        );
      const supplied = parsed?.success ? parsed.data : null;
      if (
        supplied &&
        (supplied.sourceHash !==
          createHash('sha256').update(bytes).digest('hex') ||
          supplied.geometry.image.width !== image.width ||
          supplied.geometry.image.height !== image.height)
      )
        throw new AppError(
          400,
          'GEOMETRY_IMAGE_MISMATCH',
          'Local geometry must match the uploaded photograph.',
        );
      if (supplied) {
        const fit = supplied.geometry.fit;
        if ((supplied.geometry.status === 'measured') !== !!fit)
          throw new AppError(
            400,
            'INVALID_GEOMETRY',
            'Grid measurements are incomplete.',
          );
        if (fit) {
          let c: Calibration;
          try {
            c = calibrateBoard(
              'board_1',
              fit.rows,
              { width: image.width, height: image.height },
              fit.anchors,
            );
          } catch {
            throw new AppError(
              400,
              'INVALID_GEOMETRY',
              'Grid anchors do not define a valid board within this photograph.',
            );
          }
          if (fit.observedRows > fit.rows)
            throw new AppError(
              400,
              'INVALID_GEOMETRY',
              'Observed rows exceed the supported board.',
            );
          const rms =
            Math.sqrt(
              fit.holes.reduce((sum, h) => {
                const p = project(c, {
                  x: h.column < 5 ? h.column : h.column + 2,
                  y: h.row,
                });
                return sum + (p.x - h.x) ** 2 + (p.y - h.y) ** 2;
              }, 0) / fit.holes.length,
            ) / fit.pitch;
          if (
            rms > 0.15 ||
            fit.holes.some(
              (h) =>
                h.x >= image.width || h.y >= image.height || h.row >= fit.rows,
            )
          )
            throw new AppError(
              400,
              'INVALID_GEOMETRY',
              'Measured hole centres disagree with the proposed grid.',
            );
        }
      }
      const canonical = Buffer.from(image.dataUrl.split(',')[1]!, 'base64');
      const now = Date.now();
      this.store.db
        .prepare(
          'DELETE FROM automatic_circuit_reviews WHERE inspection_id IN (SELECT id FROM automatic_circuit_inspections WHERE created_at<?)',
        )
        .run(now - this.store.config.JOB_RETENTION_HOURS * 3600000);
      // Active inspections are shorter than retention and never pruned here.
      this.store.db
        .prepare(
          'DELETE FROM automatic_circuit_proposals WHERE inspection_id IN (SELECT id FROM automatic_circuit_inspections WHERE created_at<?)',
        )
        .run(now - this.store.config.JOB_RETENTION_HOURS * 3600000);
      this.store.db
        .prepare('DELETE FROM automatic_circuit_inspections WHERE created_at<?')
        .run(now - this.store.config.JOB_RETENTION_HOURS * 3600000);
      const count = Number(
        this.store.db
          .prepare('SELECT COUNT(*) AS n FROM automatic_circuit_inspections')
          .get()!.n,
      );
      if (count >= this.store.config.MAX_STORED_JOBS)
        throw new AppError(
          503,
          'STORAGE_FULL',
          'Saved inspection capacity is full. Delete an older inspection.',
        );
      const v: CircuitInspection = {
        id,
        imageHash: createHash('sha256').update(canonical).digest('hex'),
        image: { width: image.width, height: image.height },
        createdAt: now,
        revision: 0,
        status: 'queued',
        stage: 'Finding board grid and components',
        model: this.store.config.META_REASONING_MODEL,
        requestCount: 0,
        warnings: [],
        error: null,
        observations: null,
        input: null,
        graph: null,
        reviewedAt: null,
        reviewer: null,
      };
      this.store.db
        .prepare('INSERT INTO automatic_circuit_inspections VALUES (?,?,?,?)')
        .run(id, now, canonical, JSON.stringify(v));
      const promise = (async () => {
        // Yield so POST can return the durable queued record.
        await new Promise<void>((r) => setImmediate(r));
        const timer = setTimeout(
          () => controller.abort(),
          this.store.config.CIRCUIT_INSPECTION_TIMEOUT_MS,
        );
        try {
          v.status = 'running';
          this.save(v);
          const callbacks = {
            config: this.store.config,
            client: this.client,
            image,
            id,
            imageHash: v.imageHash,
            signal: controller.signal,
            request: () => {
              v.requestCount++;
              this.save(v);
            },
            checkpoint: (p: Partial<CircuitInspection>) => {
              Object.assign(v, p);
              this.save(v);
            },
          };
          if (supplied)
            await proposeHybridCircuit({
              ...callbacks,
              geometry: supplied.geometry,
            });
          else await proposeAutomaticCircuit(callbacks);
          v.status = 'needs_review';
          v.stage = 'Confirm the grid and proposed connections';
        } catch (error) {
          v.status = v.input ? 'needs_review' : 'failed';
          v.error =
            error instanceof AppError
              ? error.message
              : controller.signal.aborted
                ? 'Inspection deadline reached. Review the saved partial proposals or take another photo.'
                : 'AI inspection could not finish. Review any saved proposals or try a new photo.';
        } finally {
          clearTimeout(timer);
          if (v.input)
            this.store.db
              .prepare(
                'INSERT OR IGNORE INTO automatic_circuit_proposals VALUES (?,?)',
              )
              .run(
                id,
                JSON.stringify({
                  input: v.input,
                  observations: v.observations,
                  ...(v.hybrid ? { hybrid: v.hybrid } : {}),
                  model: v.model,
                  requestCount: v.requestCount,
                }),
              );
          this.save(v);
          release();
          this.tasks.delete(id);
        }
      })();
      this.tasks.set(id, { controller, promise });
      return structuredClone(v);
    } catch (error) {
      release();
      this.tasks.delete(id);
      throw error;
    }
  }
  localize(id: string, raw: unknown) {
    const body = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        imageHash: z.string(),
        endpoints: z.array(localEndpointSchema).max(500),
      })
      .strict()
      .parse(raw);
    const v = this.editable(id, body.expectedRevision);
    if (v.status === 'reviewed')
      throw new AppError(
        409,
        'REVIEW_ALREADY_SAVED',
        'Local proposals cannot replace a saved human review.',
      );
    if (!v.hybrid || !v.input || body.imageHash !== v.imageHash)
      throw new AppError(
        409,
        'GEOMETRY_IMAGE_MISMATCH',
        'Endpoint measurements must belong to this inspection.',
      );
    const seen = new Set<string>();
    const numbering = v.hybrid.numbering,
      fit = v.hybrid.geometry.fit;
    const numberingKnown =
      !!fit &&
      !!numbering &&
      numbering.rowDirection !== 'unknown' &&
      numbering.columnDirection !== 'unknown' &&
      numbering.firstPrintedRow ===
        (numbering.rowDirection === 'reverse' ? fit.rows : 1) &&
      fit.observedRows === fit.rows;
    for (const e of body.endpoints) {
      if (
        seen.has(e.terminalId) ||
        !v.input.terminals.some(
          (t) => t.id === e.terminalId && t.componentId === e.componentId,
        )
      )
        throw new AppError(
          400,
          'INVALID_ENDPOINT',
          'Unknown or duplicate terminal measurement.',
        );
      seen.add(e.terminalId);
      if (
        e.position &&
        (e.position.x >= v.image.width || e.position.y >= v.image.height)
      )
        throw new AppError(
          400,
          'INVALID_ENDPOINT',
          'Endpoint lies outside the captured photograph.',
        );
      const target = proposedHole(v.input, e.position),
        association = v.input.associations.find(
          (a) => a.terminalId === e.terminalId,
        )!;
      association.state = 'unresolved';
      association.target = e.status === 'supported' && target ? target : null;
      association.type = 'insertion';
      association.originalProposalRef = `cv:${e.terminalId}`;
      association.evidence = [
        {
          id: `cv_${e.terminalId}`,
          source: 'derived',
          reviewer: null,
          timestamp: Date.now(),
          note: `OpenCV ${e.basis}: ${e.reason}. Geometric proposal only; physical contact requires human confirmation.`,
        },
      ];
      if (e.status === 'supported' && !target) {
        e.status = 'ambiguous';
        e.reason = 'Endpoint does not uniquely match a registered hole.';
      }
      const position = e.position;
      e.candidates = position
        ? v.input.boards
            .flatMap((b) => {
              const grid = unproject(b.calibration as Calibration, position);
              return allHoles(
                b.calibration as Calibration,
                b.rails as Rail[],
              ).map((h) => ({
                boardId: b.id,
                holeId: h.id,
                distancePitch: Math.hypot(grid.x - h.grid.x, grid.y - h.grid.y),
              }));
            })
            .sort((a, b) => a.distancePitch - b.distancePitch)
            .slice(0, 3)
        : [];
    }
    v.hybrid.endpoints = body.endpoints;
    v.hybrid.localStatus = body.endpoints.some((e) => e.status === 'supported')
      ? 'ready'
      : 'unresolved';
    if (
      !numberingKnown &&
      !v.warnings.includes(
        'Check the printed row and column labels before confirming local endpoint proposals.',
      )
    )
      v.warnings.push(
        'Check the printed row and column labels before confirming local endpoint proposals.',
      );
    v.revision++;
    v.input.revision = v.revision;
    v.graph = null;
    v.status = 'needs_review';
    this.save(v);
    return v;
  }
  recalibrate(id: string, raw: unknown) {
    const parsed = recalibrationRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const tooFewLandmarks = parsed.error.issues.some(
        (issue) =>
          issue.code === 'too_small' &&
          issue.path.at(-1) === 'landmarks',
      );
      throw new AppError(
        400,
        'INVALID_GRID',
        tooFewLandmarks
          ? 'Place at least six labelled hole landmarks on the breadboard before fitting the grid.'
          : 'The adjusted grid data is invalid. Check the labelled holes and try again.',
      );
    }
    const body = parsed.data;
    const v = this.editable(id, body.expectedRevision);
    if (!v.input)
      throw new AppError(
        409,
        'NO_PROPOSALS',
        'No component proposals are available. Take a new photograph.',
      );
    if (body.input) {
      if (body.input.analysisId !== id || body.input.imageHash !== v.imageHash)
        throw new AppError(
          409,
          'IMAGE_MISMATCH',
          'Grid edits must belong to this photo.',
        );
      v.input = body.input;
    }
    const warnings: string[] = [];
    const boards = automaticBoardInputs(body.observations, v.image, warnings);
    if (
      boards.length !== body.observations.boards.length ||
      !boards.length ||
      warnings.length
    )
      throw new AppError(
        400,
        'INVALID_GRID',
        warnings.join(' ').slice(0, 1000) || 'Supply supported grid landmarks.',
      );
    v.input.boards = boards;
    if (v.hybrid) {
      v.hybrid.endpoints = [];
      v.hybrid.localStatus = 'pending';
      v.hybrid.numbering = {
        firstPrintedRow: null,
        rowDirection: 'unknown',
        columnDirection: 'unknown',
        note: 'Grid was adjusted. Check the printed numbering before confirming.',
      };
    }
    for (const c of v.input.components) {
      c.state = 'unresolved';
      c.continuity = 'unresolved';
    }
    for (const t of v.input.terminals) t.roleState = 'unresolved';
    for (const a of v.input.associations) {
      const t = v.input.terminals.find((t) => t.id === a.terminalId)!;
      a.state = 'unresolved';
      a.target = t.evidence.some(
        (e) =>
          e.source === 'scene_observation' &&
          e.note.startsWith('visible_insertion'),
      )
        ? proposedHole(v.input, t.position)
        : null;
    }
    v.observations = body.observations;
    v.graph = null;
    v.status = 'needs_review';
    v.revision++;
    v.reviewedAt = null;
    v.input.revision = v.revision;
    this.save(v);
    return v;
  }
  private editable(id: string, revision: number) {
    const v = this.get(id);
    if (v.status === 'queued' || v.status === 'running')
      throw new AppError(
        409,
        'INSPECTION_RUNNING',
        'Wait for the inspection to finish.',
      );
    if (v.revision !== revision)
      throw new AppError(
        409,
        'STALE_REVIEW',
        'This inspection changed. Reload before saving your review.',
      );
    return v;
  }
  review(id: string, raw: unknown) {
    const body = inspectionReviewSchema.parse(raw),
      v = this.editable(id, body.expectedRevision),
      input = body.input;
    if (!v.input || input.analysisId !== id || input.imageHash !== v.imageHash)
      throw new AppError(
        409,
        'IMAGE_MISMATCH',
        'Review must belong to this captured image.',
      );
    if (
      input.boards.some(
        (b) =>
          b.calibration.image.width !== v.image.width ||
          b.calibration.image.height !== v.image.height,
      )
    )
      throw new AppError(
        400,
        'IMAGE_MISMATCH',
        'Grid coordinates must use the captured image dimensions.',
      );
    const proof = {
      id: `review_${v.revision + 1}`,
      source: 'human_review' as const,
      reviewer: body.reviewer,
      timestamp: Date.now(),
      note: 'Human reviewed the photograph, proposed grid, component identity and individually confirmed physical connections.',
    };
    const evidenceFor = (id: string) =>
      v
        .input!.terminals.find((t) => t.id === id)
        ?.evidence.filter((e) => e.source === 'scene_observation') ?? [];
    // Never allow client-supplied automatic confirmation or invented model provenance.
    for (const b of input.boards) {
      b.topologyState =
        b.topologyState === 'confirmed_manual'
          ? 'confirmed_manual'
          : 'unresolved';
      b.evidence = [proof];
    }
    for (const c of input.components) {
      c.state =
        c.state === 'confirmed_manual'
          ? 'confirmed_manual'
          : c.state === 'rejected'
            ? 'rejected'
            : 'unresolved';
      c.continuity =
        c.continuity === 'confirmed_manual' ? 'confirmed_manual' : 'unresolved';
      c.evidence = [proof];
    }
    for (const t of input.terminals) {
      if (
        t.position &&
        (t.position.x >= v.image.width || t.position.y >= v.image.height)
      )
        throw new AppError(
          400,
          'INVALID_TERMINAL',
          'Terminal position lies outside the image.',
        );
      t.roleState =
        t.role && t.roleState === 'confirmed_manual'
          ? 'confirmed_manual'
          : 'unresolved';
      t.evidence = [...evidenceFor(t.id), proof];
    }
    for (const a of input.associations) {
      a.state =
        a.state === 'confirmed_manual' ? 'confirmed_manual' : 'unresolved';
      a.evidence = [proof];
      if (a.state === 'confirmed_manual') {
        const t = input.terminals.find((t) => t.id === a.terminalId),
          c = input.components.find((c) => c.id === t?.componentId);
        if (c?.state !== 'confirmed_manual')
          throw new AppError(
            400,
            'COMPONENT_NOT_REVIEWED',
            'Confirm the component identity before its connection.',
          );
        if (a.target?.kind === 'hole') {
          const target = a.target,
            b = input.boards.find((b) => b.id === target.boardId);
          if (
            !b ||
            b.topologyState !== 'confirmed_manual' ||
            target.calibrationRevision !== b.revision ||
            !allHoles(b.calibration as Calibration, b.rails as Rail[]).some(
              (h) => h.id === target.holeId,
            )
          )
            throw new AppError(
              400,
              'GRID_NOT_REVIEWED',
              'Confirm the board grid and choose a registered hole before confirming a connection.',
            );
        } else if (a.target?.kind === 'terminal') {
          const targetId = a.target.terminalId,
            t = input.terminals.find((t) => t.id === targetId);
          if (
            input.components.find((c) => c.id === t?.componentId)?.state !==
            'confirmed_manual'
          )
            throw new AppError(
              400,
              'COMPONENT_NOT_REVIEWED',
              'Confirm both components before their direct contact.',
            );
        }
      }
    }
    input.coverage = { state: 'unresolved', evidence: [] }; // Partial photographic review never claims circuit operation or complete hidden wiring.
    input.validationScope = 'photograph';
    input.revision = v.revision + 1;
    validateCircuitInput(input);
    const electrical = buildConnectivity(input),
      graph = connectionProjection(electrical);
    // Unknown assemblies remain devices with separate ports; never invent their internal wiring.
    for (const c of input.components.filter(
      (c) =>
        c.state !== 'rejected' &&
        !['jumper_wire', 'conductor'].includes(c.type) &&
        !graph.devices.some((d) => d.id === c.id),
    ))
      graph.devices.push({
        id: c.id,
        label: c.label,
        kind: 'device',
        type: c.type,
        state: null,
        ports: c.terminalIds.map((id) => ({
          terminalId: id,
          nodeId: graph.nodes.find((n) => n.members.includes(`terminal:${id}`))!
            .id,
          role: input.terminals.find((t) => t.id === id)!.role,
        })),
      });
    this.store.transaction(() => {
      this.store.db
        .prepare('INSERT INTO automatic_circuit_reviews VALUES (?,?,?)')
        .run(
          id,
          input.revision,
          JSON.stringify({
            input,
            reviewer: body.reviewer,
            reviewedAt: proof.timestamp,
          }),
        );
      v.input = input;
      if (v.hybrid?.localStatus === 'pending')
        v.hybrid.localStatus = 'unresolved';
      v.graph = graph;
      v.revision = input.revision;
      v.reviewer = body.reviewer;
      v.reviewedAt = proof.timestamp;
      v.status = 'reviewed';
      v.stage = 'Reviewed connections saved';
      this.save(v);
    });
    return v;
  }
  evidence(id: string) {
    const proposal = this.store.db
      .prepare(
        'SELECT data FROM automatic_circuit_proposals WHERE inspection_id=?',
      )
      .get(id);
    return {
      ...this.get(id),
      originalProposal: proposal ? JSON.parse(proposal.data as string) : null,
      reviews: this.store.db
        .prepare(
          'SELECT data FROM automatic_circuit_reviews WHERE inspection_id=? ORDER BY revision',
        )
        .all(id)
        .map((r) => JSON.parse(r.data as string)),
    };
  }
  remove(id: string) {
    if (this.tasks.has(id))
      throw new AppError(
        409,
        'INSPECTION_RUNNING',
        'Wait for inspection to finish before deleting it.',
      );
    this.get(id);
    this.store.transaction(() => {
      this.store.db
        .prepare(
          'DELETE FROM automatic_circuit_proposals WHERE inspection_id=?',
        )
        .run(id);
      this.store.db
        .prepare('DELETE FROM automatic_circuit_reviews WHERE inspection_id=?')
        .run(id);
      this.store.db
        .prepare('DELETE FROM automatic_circuit_inspections WHERE id=?')
        .run(id);
    });
  }
  async close() {
    for (const t of this.tasks.values()) t.controller.abort();
    await Promise.all([...this.tasks.values()].map((t) => t.promise));
  }
}
