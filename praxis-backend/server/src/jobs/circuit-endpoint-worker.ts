import type { Job, JobStore } from './store.js';
import type { Config } from '../config.js';
import type { MetaClient } from '../lib/meta-client.js';
import type { AnalysisTrace } from '../lib/diagnostics.js';
import { createEndpointProposalService } from '../services/endpoint-proposals.js';
import { captureRecord, saveCapture } from './circuit-capture-client.js';
export async function runCaptureEndpoints(
  store: JobStore,
  job: Job,
  owner: string,
  attemptId: string,
  config: Config,
  client: MetaClient,
  signal: AbortSignal,
  trace: AnalysisTrace,
) {
  const c = captureRecord(store, job.captureContext!.captureId);
  if (!c.endpointPlan || !c.endpointRequestedAt || c.endpointResult)
    throw Error('Endpoint plan unavailable or already consumed.');
  try {
    const result = await createEndpointProposalService(config, client)(
      store.image(job.analysisId),
      signal,
      trace,
      c.endpointPlan.context,
    );
    signal.throwIfAborted();
    if (
      !store.owned(job.analysisId, owner, 'scene', attemptId, (j, a) => {
        const current = captureRecord(store, c.plan.captureId);
        current.endpointResult = result;
        saveCapture(store, current);
        a.status = 'succeeded';
        a.upstreamOutcome = 'response_received';
        a.retryPolicy = 'not_retryable';
        a.finishedAt = Date.now();
        a.diagnostics = trace.snapshot();
        j.scene!.status = 'succeeded';
        j.status = 'completed';
        delete j.owner;
        delete j.leaseUntil;
      })
    )
      throw Error('Endpoint ownership lost.');
  } catch (error) {
    const current = captureRecord(store, c.plan.captureId);
    if (!current.endpointResult) {
      current.endpointError =
        error instanceof Error
          ? error.message.slice(0, 200)
          : 'Endpoint attempt failed. No automatic retry.';
      saveCapture(store, current);
    }
    throw error;
  }
}
