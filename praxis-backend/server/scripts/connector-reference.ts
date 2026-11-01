import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs/store.js';
import { ConnectorValidationService } from '../src/jobs/connector-validation.js';
const [mode, analysisId, workflowId, argument, output] = process.argv.slice(2);
if (
  !mode ||
  !analysisId ||
  !workflowId ||
  !argument ||
  !['draft', 'save', 'freeze', 'evaluate', 'audit', 'export'].includes(mode)
)
  throw Error(
    'Usage: npm run connector:reference -- draft|audit|export ANALYSIS_ID WORKFLOW_ID NEW_OUTPUT.json\nOr: save ANALYSIS_ID WORKFLOW_ID DRAFT.json NEW_OUTPUT.json\nOr: freeze ANALYSIS_ID WORKFLOW_ID REVISION NEW_OUTPUT.json\nOr: evaluate ANALYSIS_ID WORKFLOW_ID REFERENCE_HASH NEW_OUTPUT.json\nEvery command is offline: zero SAM/Muse requests.',
  );
const store = new JobStore(loadConfig()),
  service = new ConnectorValidationService(store);
try {
  const result =
    mode === 'draft'
      ? service.draft(workflowId, analysisId)
      : mode === 'save'
        ? service.saveDraft(
            workflowId,
            analysisId,
            JSON.parse(readFileSync(argument, 'utf8')),
          )
        : mode === 'freeze'
          ? service.freeze(workflowId, analysisId, Number(argument))
          : mode === 'evaluate'
            ? service.evaluate(workflowId, analysisId, argument)
            : mode === 'audit'
              ? service.pointAudit(workflowId, analysisId)
              : service.evidence(workflowId, analysisId);
  const path = ['draft', 'audit', 'export'].includes(mode) ? argument : output;
  if (!path) throw Error('A new output path is required.');
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    'Saved offline connector validation evidence. No inference sent.',
  );
} finally {
  store.close();
}
