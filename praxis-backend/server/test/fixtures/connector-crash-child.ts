import {
  syntheticConnectorFixture,
  workflowApproval,
} from './connector-workflow.js';
import { ConnectorWorkflowService } from '../../src/jobs/connector-workflow.js';
const f = await syntheticConnectorFixture(process.argv[2]!),
  phase = process.argv[3]!;
let workflowId = '';
const service = new ConnectorWorkflowService(f.store, {
  async post(_path, body, _signal, operation) {
    if (phase !== 'admitted')
      operation!.evidence!.request(JSON.stringify(body));
    if (phase === 'response_recorded')
      operation!.evidence!.response({
        bytes: Buffer.from('{"status":"completed","output":[]}'),
        upstreamStatus: 200,
        contentType: 'application/json',
        truncated: false,
      });
    process.stdout.write(
      JSON.stringify({ analysisId: f.job.analysisId, workflowId }) + '\n',
    );
    return new Promise(() => {});
  },
});
const w = await service.prepare(f.job.analysisId, f.prepareBody);
workflowId = w.workflowId;
await service.run(w.workflowId, workflowApproval(w));
