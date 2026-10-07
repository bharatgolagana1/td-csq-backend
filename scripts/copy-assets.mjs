// tsc emits only TypeScript. Every other file under src/ (CSV, YAML, JSON
// templates, …) is copied to dist/ at the same relative path so runtime
// `new URL('./data/x.csv', import.meta.url)` lookups work from the build.
import { cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
const SKIP = /\.(ts|mts|cts|tsx)$/;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (!SKIP.test(entry)) cpSync(path, join(dist, relative(src, path)));
  }
}

walk(src);
