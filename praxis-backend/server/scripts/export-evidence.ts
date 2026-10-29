import { loadConfig } from '../src/config.js';
import { JobStore } from '../src/jobs/store.js';
import { exportJobEvidence } from '../src/jobs/evidence.js';
import { AppError } from '../src/lib/errors.js';

const usage =
  'Usage: npm run evidence:export -- ANALYSIS_ID NEW_DIRECTORY [--bundle EVALUATION_BUNDLE.json] [--truth GROUND_TRUTH.json]\nOffline export only; never invokes SAM or Muse. Refuses to overwrite an existing directory.';
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log(usage);
  else {
    if (
      !args[0] ||
      !args[1] ||
      args.length % 2 !== 0 ||
      args
        .slice(2)
        .some((a, i) => i % 2 === 0 && !['--bundle', '--truth'].includes(a))
    )
      throw new Error(usage);
    const attachments: { bundle?: string; truth?: string } = {};
    for (let i = 2; i < args.length; i += 2) {
      const key = args[i] === '--bundle' ? 'bundle' : 'truth';
      if (attachments[key]) throw new Error(usage);
      attachments[key] = args[i + 1]!;
    }
    const store = new JobStore(loadConfig());
    try {
      const manifest = exportJobEvidence(store, args[0], args[1], attachments);
      console.log(
        `Exported ${manifest.files.length} evidence files. Original job and predictions are unchanged.`,
      );
    } finally {
      store.close();
    }
  }
} catch (error) {
  console.error(
    error instanceof AppError
      ? error.message
      : error instanceof Error &&
          (error.message.startsWith('Usage: ') ||
            error.message.startsWith('Invalid configuration fields: '))
        ? error.message
        : 'Evidence export failed. Check the analysis ID, annotation files, and new output directory; existing files were preserved.',
  );
  process.exitCode = 1;
}
