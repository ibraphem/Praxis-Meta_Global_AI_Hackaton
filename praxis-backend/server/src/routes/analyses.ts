import { CircuitSessionService } from '../jobs/circuit-sessions.js';
import { ConnectivityService } from '../jobs/connectivity.js';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { JobStore, publicJob } from '../jobs/store.js';
import { z } from 'zod';
import { prepareImage } from '../services/image.js';
import { ConnectorValidationService } from '../jobs/connector-validation.js';
import { ConnectorWorkflowService } from '../jobs/connector-workflow.js';
import { ConnectorJunctionService } from '../jobs/connector-junctions.js';

const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function registerAnalysisRoutes(
  app: FastifyInstance,
  config: Config,
  store: JobStore,
  kick: () => void,
  workflow: ConnectorWorkflowService = new ConnectorWorkflowService(store),
) {
  const validation = new ConnectorValidationService(store);
  const junctions = new ConnectorJunctionService(store);
  const view = (analysisId: string) => ({
    ...publicJob(store.get(analysisId)),
    automaticTargeting: workflow.publicForAnalysis(analysisId),
    connectorValidation: validation.summary(analysisId),
    connectorJunctions: junctions.forAnalysis(analysisId),
  });
  const connectivity = new ConnectivityService(store);
  app.get('/api/analyses/:id/connectivity-evidence', async (request, reply) =>
    reply
      .header(
        'Content-Disposition',
        'attachment; filename="praxis-connectivity-evidence.json"',
      )
      .send(connectivity.evidence(id(request.params))),
  );
  app.get('/api/analyses/:id/connectivity', async (request) =>
    connectivity.view(id(request.params)),
  );
  for (const action of [
    'save-connectivity-workspace',
    'review-connectivity',
    'build-connectivity',
    'register-connectivity-reference',
    'compare-connectivity',
  ] as const) {
    app.post(
      `/api/analyses/:id/${action}`,
      { bodyLimit: 2 * 1024 * 1024 },
      async (request) => {
        const analysisId = id(request.params);
        try {
          if (action === 'save-connectivity-workspace')
            return connectivity.importWorkspace(analysisId, request.body);
          if (action === 'review-connectivity')
            return connectivity.review(analysisId, request.body);
          if (action === 'build-connectivity')
            return connectivity.build(analysisId, request.body);
          if (action === 'register-connectivity-reference')
            return connectivity.registerReference(analysisId, request.body);
          return connectivity.compare(analysisId, request.body);
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(
            400,
            'INVALID_CONNECTIVITY_EVIDENCE',
            error instanceof Error
              ? error.message.slice(0, 300)
              : 'Invalid connectivity evidence.',
          );
        }
      },
    );
  }
  let uploads = 0;
  app.post('/api/analyses', async (request, reply) => {
    if (!request.isMultipart())
      throw new AppError(
        415,
        'EXPECTED_MULTIPART',
        'Send one photograph in the image field.',
      );
    if (uploads >= config.MAX_CONCURRENT_ANALYSES)
      throw new AppError(
        503,
        'SERVER_BUSY',
        'Upload capacity is busy. Try again shortly.',
      );
    uploads++;
    try {
      let bytes: Buffer | undefined;
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'image' || bytes)
          throw new AppError(
            400,
            'INVALID_UPLOAD',
            'Send exactly one photograph in the image field.',
          );
        bytes = await part.toBuffer();
        if (part.file.truncated)
          throw new AppError(
            413,
            'UPLOAD_TOO_LARGE',
            'The image exceeds the upload limit.',
          );
      }
      if (!bytes)
        throw new AppError(
          400,
          'MISSING_IMAGE',
          'The image field is required.',
        );
      const image = await prepareImage(bytes, config);
      const capturePlan = request.headers['x-praxis-capture-plan'];
      let job;
      try {
        job =
          typeof capturePlan === 'string'
            ? new CircuitSessionService(store).upload(capturePlan, bytes, image)
            : store.create(bytes, image);
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError(
          409,
          'STALE_CAPTURE',
          e instanceof Error
            ? e.message.slice(0, 300)
            : 'The capture manifest is invalid.',
        );
      }
      // The durable commit precedes 202. Polling is not required for execution.
      setImmediate(kick);
      return reply.code(202).send(view(job.analysisId));
    } finally {
      uploads--;
    }
  });
  const id = (params: unknown) => {
    const value = (params as { id: string }).id;
    if (!idPattern.test(value))
      throw new AppError(
        404,
        'ANALYSIS_NOT_FOUND',
        'The saved analysis was not found.',
      );
    return value;
  };
  // Polling is cheap and must not exhaust the provider submission rate limit.
  app.get(
    '/api/analyses/:id',
    { config: { rateLimit: { max: 240, timeWindow: 60_000 } } },
    async (request) => view(id(request.params)),
  );
  app.post('/api/analyses/:id/prepare-automatic-targeting', async (request) => {
    const analysisId = id(request.params);
    await workflow.prepare(analysisId, request.body);
    return view(analysisId);
  });
  app.post('/api/analyses/:id/prepare-connector-junctions', async (request) => {
    const analysisId = id(request.params);
    await junctions.prepare(analysisId, request.body);
    return view(analysisId);
  });
  app.post(
    '/api/analyses/:id/run-connector-junctions',
    async (request, reply) => {
      const analysisId = id(request.params);
      junctions.admit(analysisId, request.body);
      setImmediate(kick);
      return reply.code(202).send(view(analysisId));
    },
  );
  app.post('/api/analyses/:id/review-connector-junction', async (request) => {
    const analysisId = id(request.params);
    junctions.review(analysisId, request.body);
    return view(analysisId);
  });
  app.post('/api/analyses/:id/freeze-junction-reference', async (request) => {
    const analysisId = id(request.params);
    junctions.freezeReference(analysisId, request.body);
    return view(analysisId);
  });
  app.post(
    '/api/analyses/:id/evaluate-connector-junctions',
    async (request) => {
      const analysisId = id(request.params);
      junctions.evaluate(analysisId, request.body);
      return view(analysisId);
    },
  );
  app.get(
    '/api/analyses/:id/connector-junction-evidence',
    async (request, reply) => {
      const parsed = z
        .object({ planId: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .safeParse(request.query);
      if (!parsed.success)
        throw new AppError(
          400,
          'INVALID_JUNCTION_PLAN',
          'Choose a frozen junction plan.',
        );
      return reply
        .header(
          'Content-Disposition',
          'attachment; filename="praxis-connector-junction-evidence.json"',
        )
        .send(junctions.evidence(parsed.data.planId, id(request.params)));
    },
  );
  for (const action of ['run', 'release', 'evaluate'] as const)
    app.post(
      `/api/analyses/:id/${action}-automatic-targeting`,
      async (request, reply) => {
        const analysisId = id(request.params),
          body = z
            .object({ workflowId: z.string().regex(/^[a-f0-9]{64}$/) })
            .passthrough()
            .safeParse(request.body);
        if (!body.success)
          throw new AppError(
            400,
            'INVALID_WORKFLOW',
            'Choose a saved experiment workflow ID.',
          );
        if (
          workflow.get(body.data.workflowId).contract.plan.analysisId !==
          analysisId
        )
          throw new AppError(
            404,
            'WORKFLOW_NOT_FOUND',
            'This plan belongs to a different analysis.',
          );
        if (action === 'run')
          workflow.start(body.data.workflowId, request.body);
        else if (action === 'release') workflow.release(body.data.workflowId);
        else
          workflow.evaluate(
            body.data.workflowId,
            (request.body as { reviews?: unknown }).reviews ?? [],
          );
        return reply.code(action === 'run' ? 202 : 200).send(view(analysisId));
      },
    );
  app.get(
    '/api/analyses/:id/automatic-targeting-evidence',
    async (request, reply) => {
      const analysisId = id(request.params),
        query = z
          .object({ workflowId: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .safeParse(request.query);
      if (!query.success)
        throw new AppError(
          400,
          'INVALID_WORKFLOW',
          'Choose a saved experiment workflow ID.',
        );
      return reply
        .header(
          'Content-Disposition',
          'attachment; filename="praxis-automatic-targeting-evidence.json"',
        )
        .send(workflow.evidence(query.data.workflowId, analysisId));
    },
  );
  const annotationView = (workflowId: string, analysisId: string) => {
    const { w } = validation.context(workflowId, analysisId);
    return {
      schemaVersion: 'praxis-connector-annotation-view-v1',
      analysisId,
      workflowId,
      imageHash: w.contract.plan.imageHash,
      imageUrl: `/api/analyses/${analysisId}/connector-annotation-image?workflowId=${workflowId}`,
      draft: validation.draft(workflowId, analysisId),
      references: validation
        .summary(analysisId)
        .references.filter((r) => r.workflowId === workflowId),
      note: 'Original orientation-corrected photograph and your annotations only. No prediction mask is included.',
    };
  };
  app.get('/api/analyses/:id/connector-annotation', async (request) => {
    const query = z
      .object({ workflowId: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(request.query);
    return annotationView(query.workflowId, id(request.params));
  });
  app.get(
    '/api/analyses/:id/connector-annotation-image',
    async (request, reply) => {
      const analysisId = id(request.params),
        query = z
          .object({ workflowId: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(request.query),
        { w } = validation.context(query.workflowId, analysisId);
      const image = store.getSnapshot(
        w.contract.plan.samSnapshotRef.samSnapshotId,
      ).snapshot.image;
      return reply
        .type('image/jpeg')
        .send(Buffer.from(image.dataUrl.split(',')[1]!, 'base64'));
    },
  );
  for (const action of ['save', 'freeze', 'evaluate'] as const)
    app.post(
      `/api/analyses/:id/${action}-connector-reference`,
      async (request) => {
        const analysisId = id(request.params),
          input = z
            .object({
              workflowId: z.string().regex(/^[a-f0-9]{64}$/),
              revision: z.number().int().nonnegative().optional(),
              content: z.unknown().optional(),
              referenceHash: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
            })
            .strict()
            .safeParse(request.body);
        if (!input.success)
          throw new AppError(
            400,
            'INVALID_ANNOTATION',
            'Provide the workflow and annotation revision or frozen reference hash.',
          );
        const body = input.data;
        validation.context(body.workflowId, analysisId);
        if (action === 'save')
          validation.saveDraft(body.workflowId, analysisId, {
            revision: body.revision,
            content: body.content,
          });
        else if (action === 'freeze')
          validation.freeze(body.workflowId, analysisId, body.revision ?? -1);
        else
          validation.evaluate(
            body.workflowId,
            analysisId,
            body.referenceHash ?? '',
          );
        return action === 'evaluate'
          ? view(analysisId)
          : annotationView(body.workflowId, analysisId);
      },
    );
  app.get(
    '/api/analyses/:id/connector-validation-evidence',
    async (request, reply) => {
      const query = z
        .object({ workflowId: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(request.query);
      return reply
        .header(
          'Content-Disposition',
          'attachment; filename="praxis-connector-validation-evidence.json"',
        )
        .send(validation.evidence(query.workflowId, id(request.params)));
    },
  );
  app.get('/api/analyses/:id/image', async (request, reply) => {
    const bytes = store.image(id(request.params));
    const type =
      bytes[0] === 0xff
        ? 'image/jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF'
          ? 'image/webp'
          : 'image/png';
    return reply.type(type).send(bytes);
  });
  app.post('/api/analyses/:id/start-scene', async (request, reply) => {
    const job = store.requestScene(id(request.params));
    setImmediate(kick);
    return reply.code(202).send(view(job.analysisId));
  });
  for (const [path, operation] of [
    ['reconcile-scene', 'reconcile'],
    ['discover-terminals', 'terminals'],
    ['guide-scene', 'guided'],
    ['refresh-scene', 'inventory'],
  ] as const)
    app.post(`/api/analyses/:id/${path}`, async (request, reply) => {
      const job = store.requestSceneUnderstanding(
        id(request.params),
        operation,
        request.body,
      );
      if (operation !== 'reconcile') setImmediate(kick);
      return reply
        .code(operation !== 'reconcile' ? 202 : 200)
        .send(view(job.analysisId));
    });
  for (const stage of ['sam', 'muse', 'scene'] as const)
    app.post(`/api/analyses/:id/retry-${stage}`, async (request, reply) => {
      const job = store.retry(id(request.params), stage);
      setImmediate(kick);
      return reply.code(202).send(view(job.analysisId));
    });
  for (const [path, operation] of [
    ['audit-wires', 'audit'],
    ['recover-wires', 'recover'],
    ['recover-short-wires', 'recover_short'],
    ['verify-wire', 'verify'],
    ['retry-wire-crop', 'retry_crop'],
    ['verify-wire-extension', 'verify_extension'],
  ] as const)
    app.post(`/api/analyses/:id/${path}`, async (request, reply) => {
      const body =
        operation === 'verify'
          ? z
              .object({
                candidateId: z
                  .string()
                  .regex(/^(jumper_wire|cv_trace)_[1-9]\d*$/),
              })
              .strict()
              .safeParse(request.body)
          : undefined;
      if (body && !body.success)
        throw new AppError(
          400,
          'INVALID_CANDIDATES',
          'Choose one current recovery candidate.',
        );
      const job = store.requestRecovery(
        id(request.params),
        operation,
        body?.success ? body.data.candidateId : undefined,
        ['recover_short', 'retry_crop', 'verify_extension'].includes(operation)
          ? request.body
          : undefined,
      );
      setImmediate(kick);
      return reply.code(202).send(view(job.analysisId));
    });
  app.post('/api/analyses/:id/interpret-recovery', async (request, reply) => {
    const job = store.interpretRecovery(id(request.params));
    setImmediate(kick);
    return reply.code(202).send(view(job.analysisId));
  });
  app.post('/api/analyses/:id/wire-identities', async (request, reply) => {
    const analysisId = id(request.params);
    store.reviewWireIdentity(analysisId, request.body);
    return reply.send(view(analysisId));
  });
  app.delete('/api/analyses/:id', async (request, reply) => {
    store.remove(id(request.params));
    return reply.code(204).send();
  });
}
