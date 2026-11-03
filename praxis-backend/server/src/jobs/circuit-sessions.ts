import { sceneSnapshots } from './scene-snapshots.js';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { canonicalHash } from '../lib/canonical-json.js';
import { AppError } from '../lib/errors.js';
import {
  capturePlanSchema,
  circuitProfileSchema,
  profilePartsSchema,
  demoPartIds,
  digestSchema,
  type CircuitProfile,
  type CircuitSessionView,
  type CircuitSession,
  type CaptureRecord,
  type RepairInstruction,
  type VerificationResult,
} from '../schemas/circuit-session.js';
import {
  type CircuitInput,
  type CircuitProof,
} from '../schemas/connectivity.js';
import type { PreparedImage } from '../schemas/vision.js';
import type { Job, JobStore } from './store.js';
import { newAttempt } from './store.js';
import {
  ConnectivityService,
  connectivityPerceptionHash,
} from './connectivity.js';
import {
  buildConnectivity,
  validateCircuitInput,
} from '../services/connectivity.js';
import {
  twoLedReference,
  validateProfileWiring,
  mappedTerminal,
  profileComparison,
  connectionProjection,
  planCircuitRepair,
  verifyCircuitRepair,
} from '../services/circuit-demo.js';
import { checkFixedCamera } from '../shared/fixed-camera.js';
import {
  allHoles,
  project,
  type Calibration,
  type Rail,
} from '../shared/calibration.js';
import { createEndpointProposalService } from '../services/endpoint-proposals.js';
import { captureRecord, saveCapture } from './circuit-capture-client.js';
import { sceneRequestEvidence } from './scene-request-evidence.js';
import type {
  ConnectivitySource,
  ConnectivityEvent,
} from '../schemas/connectivity-view.js';
const meta = {
  reviewer: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(8).max(1500),
};
const hole = z
  .object({
    boardId: z.string().min(1).max(160),
    holeId: z.string().min(1).max(160),
  })
  .strict();
export class CircuitSessionService {
  constructor(readonly store: JobStore) {}
  private rows<T>(table: string, analysisId?: string): T[] {
    return this.store.db
      .prepare(
        `SELECT data FROM ${table}${analysisId ? ' WHERE analysis_id=?' : ''} ORDER BY rowid`,
      )
      .all(...(analysisId ? [analysisId] : []))
      .map((r) => JSON.parse(r.data as string));
  }
  private get<T>(table: string, id: string): T {
    const row = this.store.db
      .prepare(`SELECT data FROM ${table} WHERE id=?`)
      .get(id);
    if (!row)
      throw new AppError(
        404,
        'CIRCUIT_RECORD_NOT_FOUND',
        'This circuit session or evidence record is unavailable.',
      );
    return JSON.parse(row.data as string);
  }
  private insert(
    table: string,
    id: string,
    analysisId: string | null,
    data: unknown,
  ) {
    this.store.db
      .prepare(`INSERT INTO ${table} VALUES (?,?,?)`)
      .run(id, analysisId, JSON.stringify(data));
  }
  private save(s: CircuitSession) {
    s.revision++;
    s.updatedAt = Date.now();
    this.store.db
      .prepare('UPDATE circuit_sessions SET analysis_id=?,data=? WHERE id=?')
      .run(s.setupAnalysisId, JSON.stringify(s), s.sessionId);
  }
  session(id: string) {
    return this.get<CircuitSession>('circuit_sessions', z.uuid().parse(id));
  }
  profile(hash: string) {
    const value = circuitProfileSchema.parse(
      this.get('circuit_profiles', digestSchema.parse(hash)),
    );
    const { profileHash, ...core } = value;
    if (canonicalHash(core) !== profileHash)
      throw Error('The physical profile failed its integrity check.');
    return value;
  }
  create() {
    const now = Date.now(),
      s: CircuitSession = {
        sessionId: randomUUID(),
        revision: 0,
        createdAt: now,
        updatedAt: now,
        setupAnalysisId: null,
        profileHash: null,
        activeCaptureId: null,
        activeRepairId: null,
        state: 'setup',
      };
    this.insert('circuit_sessions', s.sessionId, null, s);
    return this.view(s.sessionId);
  }
  private currentInput(analysisId: string) {
    const v = new ConnectivityService(this.store).view(analysisId),
      job = this.store.get(analysisId);
    if (
      !v.source ||
      v.source.sourcePerceptionHash !== connectivityPerceptionHash(job) ||
      v.source.sourceAnalysisRevision !== job.revision ||
      v.source.sourceSceneHash !==
        (job.scene?.snapshotRef?.snapshotHash ?? null)
    )
      throw Error('Save and review the current connectivity workspace first.');
    return v.source.input;
  }
  view(id: string): CircuitSessionView {
    const s = this.session(id),
      profile = s.profileHash ? this.profile(s.profileHash) : null,
      captures = this.rows<CaptureRecord>('circuit_captures').filter(
        (c) => c.plan.sessionId === id,
      );
    const active = captures.find((c) => c.plan.captureId === s.activeCaptureId);
    let graph = null,
      comparison = null,
      input: CircuitInput | null = null;
    if (active?.analysisId) {
      try {
        input = this.currentInput(active.analysisId);
        const g = buildConnectivity(input);
        graph = connectionProjection(g);
        if (profile) comparison = profileComparison(profile, input);
      } catch {
        /* No accepted current workspace yet. */
      }
    }
    const requests = captures.flatMap((c) =>
      c.analysisId
        ? sceneRequestEvidence(this.store, c.analysisId)
            .filter((r) => r.experimentId === c.plan.planId)
            .map((r) => ({
              captureId: c.plan.captureId,
              requestId: r.requestId,
              stage: r.prompt,
              dimensions: r.inputImageDimensions ?? [],
              pixels: (r.inputImageDimensions ?? []).reduce(
                (n, d) => n + d.width * d.height,
                0,
              ),
              status: r.response
                ? 'response_received'
                : r.dispatchStartedAt
                  ? 'unknown'
                  : 'not_sent',
              latencyMs:
                r.response && r.dispatchStartedAt
                  ? r.response.receivedAt - r.dispatchStartedAt
                  : null,
              failureCode: r.failureCode ?? null,
            }))
        : [],
    );
    const repairs = this.rows<RepairInstruction>('circuit_repairs').filter(
        (r) => r.sessionId === id,
      ),
      verifications = this.rows<VerificationResult>(
        'circuit_verifications',
      ).filter((v) => repairs.some((r) => r.repairId === v.repairId));
    return {
      schemaVersion: 'praxis-circuit-session-view-v1' as const,
      session: s,
      profile,
      captures,
      graph,
      comparison,
      input,
      repairs,
      verifications,
      requests,
      guidanceCurrent:
        !!input &&
        !!active &&
        repairs.some(
          (r) =>
            r.repairId === s.activeRepairId &&
            r.sourceCaptureId === active.plan.captureId &&
            r.profileHash === s.profileHash &&
            r.sourceInputHash === canonicalHash(input),
        ),
      physicalValidation: 'pending_real_rig_rehearsal' as const,
      additionalInferenceRequests: 0 as const,
    };
  }
  saveProfile(id: string, raw: unknown) {
    const body = z
      .object({
        expectedRevision: z.number().int(),
        analysisId: z.uuid(),
        qualification: z.enum(['draft', 'verified_human']),
        parts: profilePartsSchema,
        mapping: z.record(z.enum(demoPartIds), z.string().min(1).max(160)),
        poseAnchors: z
          .array(
            z
              .object({
                x: z.number().nonnegative(),
                y: z.number().nonnegative(),
              })
              .strict(),
          )
          .length(4),
        physicalDetailsVerified: z.boolean(),
        ...meta,
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const s = this.session(id);
      if (s.revision !== body.expectedRevision)
        throw Error('Session changed. Reload before freezing the profile.');
      const input = this.currentInput(body.analysisId),
        job = this.store.get(body.analysisId);
      if (job.owner) throw Error('Wait for setup analysis to finish.');
      if (new Set(Object.values(body.mapping)).size !== 7)
        throw Error('Map seven distinct physical objects.');
      for (const key of demoPartIds)
        if (!input.components.some((c) => c.id === body.mapping[key]))
          throw Error(
            `Map ${key} to an observed or manually reviewed component.`,
          );
      const reference = twoLedReference(
        body.parts,
        body.qualification,
        body.reviewer,
      );
      let graph = buildConnectivity(input);
      if (body.qualification === 'verified_human') {
        if (
          input.validationScope !== 'photograph' ||
          !body.physicalDetailsVerified ||
          [
            body.parts.ledSource,
            body.parts.switchPart,
            body.parts.switchContacts,
            body.parts.schematicSource,
          ].some((v) => v.trim().length < 8)
        )
          throw Error(
            'Verify the real photograph, part details, schematic and switch contact mapping before qualification.',
          );
        graph = validateProfileWiring(input, body.mapping, reference);
      }
      const p = {
        schemaVersion: 'praxis-circuit-profile-v1' as const,
        sessionId: id,
        createdAt: Date.now(),
        name: 'Two-LED button indicator',
        qualification: body.qualification,
        validationScope: input.validationScope,
        sourceAnalysisId: job.analysisId,
        sourceInputHash: canonicalHash(input),
        sourcePerceptionHash: connectivityPerceptionHash(job),
        sourceGraphHash: graph.graphHash,
        reviewer: body.reviewer,
        reason: body.reason,
        parts: body.parts,
        mapping: body.mapping,
        reference,
        input,
        anchoredTerminalId:
          mappedTerminal(input, body.mapping, 'J1', 'a')?.id ?? null,
        movingTerminalId:
          mappedTerminal(input, body.mapping, 'J1', 'b')?.id ?? null,
        requiredFromTerminalId:
          mappedTerminal(input, body.mapping, 'R2', 'terminal2')?.id ?? null,
        requiredToTerminalId:
          mappedTerminal(input, body.mapping, 'D2', 'anode')?.id ?? null,
        poseAnchors: body.poseAnchors,
        posePolicy: 'fixed-camera-patches-v1' as const,
      };
      const profile = circuitProfileSchema.parse({
        ...p,
        profileHash: canonicalHash(p),
      });
      this.insert(
        'circuit_profiles',
        profile.profileHash,
        job.analysisId,
        profile,
      );
      s.profileHash = profile.profileHash;
      s.setupAnalysisId = job.analysisId;
      s.activeRepairId = null;
      s.activeCaptureId = null;
      s.state = body.qualification === 'draft' ? 'setup' : 'ready';
      this.save(s);
      return this.view(id);
    });
  }
  prepare(id: string, raw: unknown) {
    const body = z
      .object({
        expectedRevision: z.number().int(),
        frameHash: digestSchema,
        width: z.number().int().min(64),
        height: z.number().int().min(64),
        capturedAt: z.number().int().positive(),
        cameraFrame: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict()
          .optional(),
        purpose: z.enum(['setup', 'assessment', 'verification']),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const s = this.session(id);
      if (s.revision !== body.expectedRevision)
        throw Error('Session changed. Reload before preparing this frame.');
      if (
        this.rows<CaptureRecord>('circuit_captures').filter(
          (c) => c.plan.sessionId === id,
        ).length >= 30
      )
        throw Error(
          'Session capture limit reached. Export this rehearsal and start a new session.',
        );
      if (body.width * body.height > 1500000)
        throw Error(
          'Resize the frame to at most 1.5 million pixels for the four-request SAM pass.',
        );
      if (
        Date.now() - body.capturedAt > 120000 ||
        body.capturedAt > Date.now() + 5000
      )
        throw Error('Capture a fresh frame.');
      if (s.activeCaptureId) {
        const c = captureRecord(this.store, s.activeCaptureId);
        if (c.analysisId) {
          const j = this.store.get(c.analysisId);
          if (
            j.owner ||
            j.sam.status === 'queued' ||
            j.scene?.status === 'queued'
          )
            throw Error('Wait for the active capture.');
        }
      }
      if (
        body.purpose !== 'setup' &&
        (!s.profileHash ||
          this.profile(s.profileHash).qualification !== 'verified_human')
      )
        throw Error(
          'Freeze a verified physical setup before assessment or repair verification.',
        );
      if (body.purpose === 'verification' && !s.activeRepairId)
        throw Error('Prepare a supported repair before verification.');
      const core = {
        sessionId: id,
        sessionRevision: s.revision + 1,
        captureId: randomUUID(),
        frameHash: body.frameHash,
        width: body.width,
        height: body.height,
        capturedAt: body.capturedAt,
        purpose: body.purpose,
        profileHash: s.profileHash,
        preparedAt: Date.now(),
        displayTransform: {
          sourceWidth: body.cameraFrame?.width ?? body.width,
          sourceHeight: body.cameraFrame?.height ?? body.height,
          scaleX: body.width / (body.cameraFrame?.width ?? body.width),
          scaleY: body.height / (body.cameraFrame?.height ?? body.height),
          mirrored: false,
          cropped: false,
          coordinateSpace: 'source_pixels',
        },
        providerBaseUrl: this.store.config.META_BASE_URL,
        samModel: this.store.config.META_SAM_MODEL,
        museModel: this.store.config.META_REASONING_MODEL,
        budget: {
          samRequests: 4 as const,
          samPixels: body.width * body.height * 4,
          endpointMuseRequests: 1 as const,
          maxMusePixels: 4000000 as const,
          maxRetries: 0 as const,
        },
        repairId: body.purpose === 'verification' ? s.activeRepairId : null,
      };
      const plan = capturePlanSchema.parse({
          ...core,
          planId: canonicalHash(core),
        }),
        c: CaptureRecord = {
          plan,
          analysisId: null,
          uploadedAt: null,
          endpointPlan: null,
          endpointRequestedAt: null,
          endpointResult: null,
          endpointError: null,
          poseEvidence: null,
          freshReview: null,
        };
      this.insert('circuit_captures', plan.captureId, null, c);
      s.activeCaptureId = plan.captureId;
      this.save(s);
      return this.view(id);
    });
  }
  upload(planId: string, bytes: Buffer, image: PreparedImage) {
    const records = this.rows<CaptureRecord>('circuit_captures'),
      c = records.find((c) => c.plan.planId === digestSchema.parse(planId));
    if (!c) throw Error('Capture plan unavailable.');
    const p = c.plan;
    return this.store.create(
      bytes,
      image,
      { planId: p.planId, captureId: p.captureId, sessionId: p.sessionId },
      (job) => {
        const current = captureRecord(this.store, p.captureId),
          s = this.session(p.sessionId);
        if (
          current.analysisId ||
          s.revision !== p.sessionRevision ||
          s.activeCaptureId !== p.captureId ||
          s.profileHash !== p.profileHash ||
          Date.now() - p.preparedAt > 120000 ||
          job.imageHash !== p.frameHash ||
          image.width !== p.width ||
          image.height !== p.height ||
          p.providerBaseUrl !== this.store.config.META_BASE_URL ||
          p.samModel !== job.settings.samModel ||
          p.museModel !== job.settings.museModel
        )
          throw Error(
            'The capture manifest is stale, spent or does not match the uploaded pixels. Prepare again.',
          );
        current.analysisId = job.analysisId;
        current.uploadedAt = Date.now();
        saveCapture(this.store, current);
        s.state = p.purpose === 'verification' ? 'verifying' : 'analyzing';
        this.save(s);
      },
    );
  }
  private active(id: string, captureId: string) {
    const s = this.session(id),
      c = captureRecord(this.store, captureId);
    if (
      c.plan.sessionId !== id ||
      s.activeCaptureId !== captureId ||
      !c.analysisId
    )
      throw Error('Choose the current uploaded capture.');
    const job = this.store.get(c.analysisId);
    if (job.owner || job.sam.status !== 'succeeded')
      throw Error('Wait for the bounded SAM scan to finish.');
    return { s, c, job };
  }
  async seed(id: string, raw: unknown) {
    const body = z.object({ captureId: z.uuid() }).strict().parse(raw),
      { s, c, job } = this.active(id, body.captureId);
    if (!s.profileHash || c.plan.profileHash !== s.profileHash)
      throw Error('The frame has no matching setup profile.');
    if (new ConnectivityService(this.store).view(job.analysisId).source)
      throw Error(
        'This capture already has a workspace; do not overwrite its reviews.',
      );
    const p = this.profile(s.profileHash),
      setup = this.store.get(p.sourceAnalysisId);
    if (
      connectivityPerceptionHash(setup) !== p.sourcePerceptionHash ||
      canonicalHash(this.currentInput(setup.analysisId)) !== p.sourceInputHash
    )
      throw Error('Setup evidence changed. Freeze a new profile.');
    const rgb = async (bytes: Buffer) => {
      const { data, info } = await sharp(bytes)
        .rotate()
        .flatten({ background: '#fff' })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, data };
    };
    const pose = checkFixedCamera(
      await rgb(this.store.image(setup.analysisId)),
      await rgb(this.store.image(job.analysisId)),
      p.poseAnchors,
    );
    return this.store.transaction(() => {
      const live = this.active(id, body.captureId);
      if (
        live.s.profileHash !== p.profileHash ||
        new ConnectivityService(this.store).view(job.analysisId).source
      )
        throw Error('Capture changed during registration.');
      c.poseEvidence = {
        ...pose,
        sourceImageHash: setup.imageHash,
        targetImageHash: job.imageHash,
        profileHash: p.profileHash,
      };
      saveCapture(this.store, c);
      if (!pose.valid) {
        s.state = 'unable_to_verify';
        this.save(s);
        return this.view(id);
      }
      const input = structuredClone(p.input);
      input.analysisId = job.analysisId;
      input.imageHash = job.imageHash;
      input.revision = 0;
      input.coverage = { state: 'unresolved', evidence: [] };
      const proof: CircuitProof = {
        id: randomUUID(),
        source: 'derived',
        reviewer: null,
        note: `Transferred setup facts under fixed-camera registration ${p.profileHash}. Static contacts require fresh human confirmation.`,
        timestamp: Date.now(),
      };
      for (const component of input.components) {
        component.evidence.push(proof);
        if (component.id === p.mapping.J1) {
          component.state = 'unresolved';
          component.continuity = 'unresolved';
          component.objectRef = { kind: 'manual', id: component.id };
          component.bbox = null;
        }
      }
      // Both J1 ends are invalidated; intended destinations never seed fresh observations.
      for (const a of input.associations) {
        a.evidence.push(proof);
        if (
          input.components
            .find((v) => v.id === p.mapping.J1)
            ?.terminalIds.includes(a.terminalId)
        ) {
          a.state = 'unresolved';
          a.target = null;
          a.originalProposalRef = null;
        }
      }
      for (const t of input.terminals.filter(
        (t) => t.componentId === p.mapping.J1,
      )) {
        t.position = null;
        t.evidence.push(proof);
      }
      this.writeSource(job, input, 'registered_setup_transfer', proof, {
        profileHash: p.profileHash,
        pose: c.poseEvidence,
      });
      s.state = 'needs_confirmation';
      this.save(s);
      return this.view(id);
    });
  }
  private writeSource(
    job: Job,
    input: CircuitInput,
    action: string,
    proof: CircuitProof,
    payload: unknown,
  ) {
    validateCircuitInput(input);
    const source: ConnectivitySource = {
      input,
      workspace: null,
      sourceSceneHash: job.scene?.snapshotRef?.snapshotHash ?? null,
      sourceAnalysisRevision: job.revision,
      sourcePerceptionHash: connectivityPerceptionHash(job),
    };
    this.store.db
      .prepare(
        'INSERT INTO connectivity_sources VALUES (?,?) ON CONFLICT(analysis_id) DO UPDATE SET data=excluded.data',
      )
      .run(job.analysisId, JSON.stringify(source));
    const event: ConnectivityEvent = {
      id: proof.id,
      action,
      reviewer: proof.reviewer ?? 'derived',
      reason: proof.note,
      timestamp: proof.timestamp,
      baseRevision: Math.max(0, input.revision - 1),
      revision: input.revision,
      payload,
      inputHash: canonicalHash(input),
      previousValue: null,
      sourceBindings: {
        imageHash: job.imageHash,
        analysisRevision: job.revision,
        sceneSnapshotHash: source.sourceSceneHash,
        perceptionHash: source.sourcePerceptionHash,
        samSnapshotHash: job.sam.snapshotRef?.samSnapshotHash ?? null,
      },
    };
    this.store.db
      .prepare('INSERT INTO connectivity_events VALUES (?,?,?)')
      .run(event.id, job.analysisId, JSON.stringify(event));
  }
  review(id: string, raw: unknown) {
    const body = z
      .object({
        captureId: z.uuid(),
        expectedInputHash: digestSchema,
        wireCandidateId: z.string().regex(/^jumper_wire_[1-9]\d*$/),
        anchored: hole,
        moving: hole,
        staticContactsUnchanged: z.literal(true),
        bothInsertionsVisible: z.literal(true),
        wireIdentityConfirmed: z.literal(true),
        ...meta,
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const { s, c, job } = this.active(id, body.captureId),
        p = this.profile(s.profileHash!),
        input = structuredClone(this.currentInput(job.analysisId));
      if (
        !c.poseEvidence ||
        !(c.poseEvidence as { valid: boolean }).valid ||
        c.plan.profileHash !== p.profileHash ||
        canonicalHash(input) !== body.expectedInputHash
      )
        throw Error(
          'Registration, profile or input changed. Reload before reviewing.',
        );
      const candidate = job.sam.snapshot!.candidates.find(
        (v) => v.id === body.wireCandidateId && v.type === 'jumper_wire',
      );
      if (!candidate)
        throw Error(
          'Choose a current SAM wire observation; color alone cannot establish J1 identity.',
        );
      const proof: CircuitProof = {
          id: randomUUID(),
          source: 'human_review',
          reviewer: body.reviewer,
          note: body.reason,
          timestamp: Date.now(),
        },
        component = input.components.find((v) => v.id === p.mapping.J1)!;
      component.objectRef = { kind: 'baseline', id: candidate.id };
      component.bbox = candidate.bbox;
      component.state = 'confirmed_manual';
      component.continuity = 'confirmed_manual';
      component.evidence.push(proof);
      for (const [tid, target] of [
        [p.anchoredTerminalId, body.anchored],
        [p.movingTerminalId, body.moving],
      ] as const) {
        if (!tid) throw Error('Profile end identities unresolved.');
        const board = input.boards.find((b) => b.id === target.boardId),
          h =
            board &&
            allHoles(
              board.calibration as Calibration,
              board.rails as Rail[],
            ).find((h) => h.id === target.holeId);
        if (!board || !h) throw Error('Choose a registered breadboard hole.');
        const t = input.terminals.find((t) => t.id === tid)!;
        t.position = project(board.calibration as Calibration, h.grid);
        t.evidence.push(proof);
        input.associations = input.associations.filter(
          (a) => a.terminalId !== tid,
        );
        input.associations.push({
          id: `fresh:${tid}`,
          terminalId: tid,
          target: {
            kind: 'hole',
            ...target,
            calibrationRevision: board.revision,
          },
          type: 'insertion',
          state: 'confirmed_manual',
          evidence: [proof],
          originalProposalRef: c.endpointPlan?.hash ?? null,
        });
      }
      input.coverage = { state: 'confirmed_manual', evidence: [proof] };
      input.revision++;
      this.writeSource(job, input, 'fresh_capture_review', proof, body);
      c.freshReview = {
        inputHash: canonicalHash(input),
        reviewer: body.reviewer,
        reason: body.reason,
        reviewedAt: proof.timestamp,
        wireCandidateId: body.wireCandidateId,
        scope: 'human_review',
      };
      saveCapture(this.store, c);
      this.insert('circuit_capture_reviews', proof.id, job.analysisId, {
        ...c.freshReview,
        captureId: c.plan.captureId,
        imageHash: job.imageHash,
        payload: body,
      });
      const finding = profileComparison(p, input).findings[0];
      s.state =
        finding?.status === 'confirmed_fault'
          ? 'fault_found'
          : finding?.status === 'no_fault'
            ? 'scoped_no_fault'
            : 'needs_confirmation';
      this.save(s);
      return this.view(id);
    });
  }
  repair(id: string, raw: unknown) {
    const body = z
      .object({
        captureId: z.uuid(),
        expectedInputHash: digestSchema,
        target: hole,
        destinationVisibleAndEmpty: z.literal(true),
        ...meta,
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const { s, c, job } = this.active(id, body.captureId),
        input = this.currentInput(job.analysisId);
      if (
        c.plan.profileHash !== s.profileHash ||
        c.freshReview?.inputHash !== body.expectedInputHash ||
        canonicalHash(input) !== body.expectedInputHash
      )
        throw Error('A current fresh-capture review is required.');
      const r = planCircuitRepair({
        sessionId: id,
        captureId: body.captureId,
        profile: this.profile(s.profileHash!),
        input,
        target: body.target,
        reviewer: body.reviewer,
        note: body.reason,
        timestamp: Date.now(),
      });
      this.insert('circuit_repairs', r.repairId, job.analysisId, r);
      s.activeRepairId = r.repairId;
      s.state = 'repair_guidance';
      this.save(s);
      return this.view(id);
    });
  }
  verify(id: string, raw: unknown) {
    const body = z
      .object({ captureId: z.uuid(), repairId: digestSchema })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const { s, c, job } = this.active(id, body.captureId),
        repair = this.get<RepairInstruction>('circuit_repairs', body.repairId);
      if (
        s.activeRepairId !== repair.repairId ||
        repair.sessionId !== id ||
        c.plan.repairId !== repair.repairId ||
        c.plan.purpose !== 'verification'
      )
        throw Error(
          'This fresh capture was not prepared for the current repair.',
        );
      const input = this.currentInput(job.analysisId),
        result = verifyCircuitRepair({
          repair,
          profile: this.profile(s.profileHash!),
          captureId: c.plan.captureId,
          input,
          baselineInput: this.currentInput(repair.sourceAnalysisId),
          freshReviewed: c.freshReview?.inputHash === canonicalHash(input),
          poseValid: !!(c.poseEvidence as { valid?: boolean } | null)?.valid,
        });
      this.insert(
        'circuit_verifications',
        result.verificationId,
        job.analysisId,
        result,
      );
      s.state = result.status;
      this.save(s);
      return this.view(id);
    });
  }
  async prepareEndpoints(id: string, raw: unknown) {
    const b = z
        .object({
          captureId: z.uuid(),
          wireCandidateId: z.string().regex(/^jumper_wire_[1-9]\d*$/),
        })
        .strict()
        .parse(raw),
      { c, job } = this.active(id, b.captureId);
    if (c.endpointPlan || c.endpointRequestedAt)
      throw Error('Only one endpoint request may be prepared per capture.');
    const wires = job.candidateResult!.objects.filter(
        (v) => v.type === 'jumper_wire' && v.mask,
      ),
      wire = wires.find((v) => v.id === b.wireCandidateId);
    if (!wire) throw Error('Choose the current J1 candidate.');
    const context = {
      analysisId: job.analysisId,
      imageId: job.imageHash,
      image: job.image,
      wire: { id: wire.id, bbox: wire.bbox, mask: wire.mask },
      view: 'candidate_crop',
      coordinateSpace: 'pixels',
      otherWires: wires
        .filter((v) => v !== wire)
        .slice(0, 99)
        .map((v) => ({ id: v.id, bbox: v.bbox, mask: v.mask })),
    };
    let preview: CaptureRecord['endpointPlan'] = null;
    const sentinel = Error('OFFLINE_PREVIEW');
    try {
      await createEndpointProposalService(this.store.config, {
        async post(_path, body, _signal, operation) {
          const dimensions = (operation?.imageDimensions ?? []).map(
              ({ width, height }) => ({ width, height }),
            ),
            pixels = dimensions.reduce((n, d) => n + d.width * d.height, 0);
          if (!pixels || pixels > 4000000)
            throw Error('Endpoint images exceed the frozen pixel budget.');
          const core = {
            context,
            payloadHash: canonicalHash(body),
            dimensions,
            pixels,
            samSnapshotHash: job.sam.snapshotRef!.samSnapshotHash,
            preparedAt: Date.now(),
          };
          preview = { ...core, hash: canonicalHash(core) };
          throw sentinel;
        },
      })(
        this.store.image(job.analysisId),
        new AbortController().signal,
        undefined,
        context,
      );
    } catch (e) {
      if (e !== sentinel) throw e;
    }
    if (!preview) throw Error('Endpoint preview unavailable.');
    return this.store.transaction(() => {
      const live = this.active(id, b.captureId);
      if (
        live.c.endpointPlan ||
        live.job.sam.snapshotRef?.samSnapshotHash !==
          job.sam.snapshotRef?.samSnapshotHash
      )
        throw Error('Endpoint checkpoint changed.');
      live.c.endpointPlan = preview;
      saveCapture(this.store, live.c);
      return this.view(id);
    });
  }
  runEndpoints(id: string, raw: unknown) {
    const b = z
      .object({
        captureId: z.uuid(),
        endpointPlanHash: digestSchema,
        authorize: z.literal(true),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const { c, job } = this.active(id, b.captureId);
      if (
        c.endpointRequestedAt ||
        c.endpointPlan?.hash !== b.endpointPlanHash ||
        Date.now() - c.endpointPlan.preparedAt > 600000 ||
        job.sam.snapshotRef?.samSnapshotHash !== c.endpointPlan.samSnapshotHash
      )
        throw Error('The endpoint plan is stale or spent.');
      c.endpointRequestedAt = Date.now();
      saveCapture(this.store, c);
      job.scene = {
        status: 'queued',
        attempts: [
          {
            ...newAttempt(),
            sceneOperation: 'capture_endpoints',
            samSnapshotId: job.sam.snapshotRef.samSnapshotId,
            samSnapshotHash: job.sam.snapshotRef.samSnapshotHash,
            snapshotBinding: 'recorded',
          },
        ],
        budget: { requests: 0, pixels: 0 },
        work: [],
      };
      this.store.save(job);
      return this.view(id);
    });
  }
  evidence(id: string) {
    return this.store.transaction(() => {
      const view = this.view(id),
        analyses = view.captures
          .filter((c) => c.analysisId)
          .map((c) => {
            const analysisId = c.analysisId!;
            try {
              return {
                analysisId,
                job: this.store.get(analysisId),
                image: {
                  sha256: this.store.get(analysisId).imageHash,
                  base64: this.store.image(analysisId).toString('base64'),
                },
                snapshots: this.store.snapshots(analysisId),
                sceneSnapshots: sceneSnapshots(this.store, analysisId),
                connectivity: new ConnectivityService(this.store).evidence(
                  analysisId,
                ),
                requests: sceneRequestEvidence(this.store, analysisId),
              };
            } catch {
              return { analysisId, unavailable: true };
            }
          });
      if (
        view.profile &&
        !analyses.some((a) => a.analysisId === view.profile!.sourceAnalysisId)
      ) {
        const a = view.profile.sourceAnalysisId;
        analyses.push({
          analysisId: a,
          job: this.store.get(a),
          image: {
            sha256: this.store.get(a).imageHash,
            base64: this.store.image(a).toString('base64'),
          },
          snapshots: this.store.snapshots(a),
          sceneSnapshots: sceneSnapshots(this.store, a),
          connectivity: new ConnectivityService(this.store).evidence(a),
          requests: sceneRequestEvidence(this.store, a),
        });
      }
      return {
        ...view,
        profileHistory: this.rows<CircuitProfile>('circuit_profiles').filter(
          (p) => p.sessionId === id,
        ),
        exportedAt: Date.now(),
        captureReviews: this.rows<{ captureId: string }>(
          'circuit_capture_reviews',
        ).filter((r) =>
          view.captures.some((c) => c.plan.captureId === r.captureId),
        ),
        analyses,
      };
    });
  }
}
