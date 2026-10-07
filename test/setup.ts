// vitest setup: builds the test environment without touching real variables.
// Order of precedence: real environment > .env.test > .env > test defaults.
// Safety rails: NODE_ENV is test, the scheduler is off, and the database name
// is forced to end in `_test` (csq_test by default) so a stray .env can never
// point the suite at development data.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { initLogger } from '../src/core/logger.js';

const fromFiles = new Set<string>();

function loadFile(path: string): void {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      fromFiles.add(key);
    }
  }
}

loadFile('.env.test');
loadFile('.env');

const defaults: Record<string, string> = {
  PORT: '0',
  MONGO_URI: 'mongodb://127.0.0.1:27017/csq_test?replicaSet=rs0',
  KEYCLOAK_ISSUER: 'https://auth.test/realms/csq',
  KEYCLOAK_JWKS_URI: 'https://auth.test/realms/csq/protocol/openid-connect/certs',
  KEYCLOAK_AUDIENCE: 'csq-api',
  CORS_ORIGINS: 'http://localhost:5173',
  PUBLIC_WEB_URL: 'http://localhost:5173',
  LINK_SESSION_SECRET: 'test-link-session-secret-0123456789abcdef',
  MAIL_FROM: 'CSQ Test <test@csq.local>',
  DEMO_REVEAL_OTP: 'false',
};
for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}

process.env['NODE_ENV'] = 'test';
process.env['SCHEDULER_ENABLED'] = 'false';
if (process.env['LOG_LEVEL'] === undefined || fromFiles.has('LOG_LEVEL')) process.env['LOG_LEVEL'] = 'silent';
// Tests that never build an app (unit tests) would otherwise log through the default logger.
initLogger({ level: process.env['LOG_LEVEL'], pretty: false });

const MONGO = /^(mongodb(?:\+srv)?:\/\/[^/]+)\/([^?]*)(\?.*)?$/;
const uri = process.env['MONGO_URI'] ?? '';
const match = MONGO.exec(uri);
if (match) {
  const [, host, db = '', query = ''] = match;
  if (!db.endsWith('_test')) process.env['MONGO_URI'] = `${host}/csq_test${query}`;
}
