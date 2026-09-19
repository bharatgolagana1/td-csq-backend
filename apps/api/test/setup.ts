import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../src/config/env.js';

/**
 * Populates the process environment for the suite, the way a shell or a dotenv
 * loader would. It writes variables; it never reads configuration, so
 * src/config/env.ts remains the only thing that interprets the environment.
 * A real variable already set in the shell wins over the file.
 */
const candidates = ['.env.test', '.env'].map((name) => resolve(__dirname, '..', name));
const found = candidates.find(existsSync);

if (found) {
  for (const line of readFileSync(found, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

// the suite refuses to run against an environment it has not validated, for the
// same reason the process does
try {
  loadEnv();
} catch (error) {
  throw new Error(
    'The API suite talks to a real MongoDB and needs a validated environment. ' +
      'Copy apps/api/.env.example to apps/api/.env.test and point MONGO_URI at a ' +
      `throwaway database (docker compose up -d mongo).\n${String(error)}`,
  );
}
