import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
/** Hash only executable application files at process startup; never environment files or evidence. */
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = createHash('sha256');
function visit(path: string) {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(ts|js)$/.test(entry.name))
      hash.update(relative(root, file)).update(readFileSync(file));
  }
}
visit(root);
hash.update(readFileSync(new URL('../../package-lock.json', import.meta.url)));
export const RUNTIME = Object.freeze({
  buildId: hash.digest('hex'),
  representation: import.meta.url.endsWith('.ts')
    ? ('source' as const)
    : ('compiled' as const),
  algorithms: {
    candidateLayer: 'sam-candidate-layer-v1' as const,
    wireSelection: 'preserve-wire-evidence-v1' as const,
    interpretation: 'incremental-experiments-v2' as const,
  },
});
