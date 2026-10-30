import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
/** Source snapshot at Next build/dev-session startup, excluding environment and private evidence. */
export function frontendBuildId(root: string): string {
  const hash = createHash("sha256");
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(ts|tsx|css)$/.test(entry.name))
        hash.update(relative(root, file)).update(readFileSync(file));
    }
  }
  for (const dir of ["app", "components", "lib"]) visit(join(root, dir));
  for (const file of [
    "next.config.ts",
    "build-fingerprint.ts",
    "package-lock.json",
  ])
    hash.update(file).update(readFileSync(join(root, file)));
  return hash.digest("hex");
}
