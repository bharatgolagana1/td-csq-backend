import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies every src/modules/<name>/data directory into the build output.
 *
 * tsc emits JavaScript and nothing else, and the runtime image carries dist
 * without src, so a module that ships reviewable source data (the vendored
 * airport extract, the ACFI instrument) would otherwise find nothing to read
 * once deployed. Generic rather than refdata specific, so the next module that
 * ships data gets this for free.
 */
const here = dirname(fileURLToPath(import.meta.url));
const modules = join(here, '..', 'src', 'modules');
const output = join(here, '..', 'dist', 'modules');

if (!existsSync(modules)) process.exit(0);

let copied = 0;
for (const name of readdirSync(modules, { withFileTypes: true })) {
  if (!name.isDirectory()) continue;
  const from = join(modules, name.name, 'data');
  if (!existsSync(from)) continue;
  cpSync(from, join(output, name.name, 'data'), { recursive: true });
  copied += 1;
}
console.log(`copied data for ${copied} module(s)`);
