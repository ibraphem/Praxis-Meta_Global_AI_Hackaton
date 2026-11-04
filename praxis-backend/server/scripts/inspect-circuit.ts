import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs/store.js';
import { AutomaticCircuitService } from '../src/jobs/automatic-circuits.js';
import { admittedClient } from '../src/jobs/model-admission.js';

const [imagePath, outputPath] = process.argv.slice(2);
if (!imagePath || !outputPath)
  throw Error(
    'Usage: node --env-file-if-exists=.env --import tsx scripts/inspect-circuit.ts IMAGE OUTPUT.json',
  );
const store = new JobStore(loadConfig(), ':memory:');
const service = new AutomaticCircuitService(store, admittedClient(store));
try {
  const initial = await service.create(await readFile(imagePath));
  let v = service.get(initial.id),
    last = '';
  while (v.status === 'queued' || v.status === 'running') {
    if (v.stage !== last) {
      console.log(v.stage);
      last = v.stage;
    }
    await new Promise((r) => setTimeout(r, 1000));
    v = service.get(initial.id);
  }
  await writeFile(outputPath, JSON.stringify(service.evidence(v.id), null, 2), {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      status: v.status,
      elapsedSeconds: Math.round((Date.now() - v.createdAt) / 1000),
      requests: v.requestCount,
      boards: v.input?.boards.length,
      components: v.input?.components.length,
      terminals: v.input?.terminals.length,
      proposedInsertions: v.input?.associations.filter((a) => a.target).length,
      error: v.error,
      output: outputPath,
    }),
  );
  if (v.status === 'failed') process.exitCode = 1;
} finally {
  await service.close();
  store.close();
}
