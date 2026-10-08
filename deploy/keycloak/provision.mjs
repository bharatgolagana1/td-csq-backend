#!/usr/bin/env node
// Keycloak provisioning for the CSQ realm. Node >= 22, no dependencies.
//
//   KC_URL=https://auth.tinydata.in KC_ADMIN_USER=admin KC_ADMIN_PASSWORD='…' \
//     node deploy/keycloak/provision.mjs [--web-origin <origin>]... [--users <file>] \
//       [--resend-emails] [--realm-file <path>] [--realm <name>] [--dry-run]
//
//   KC_ADMIN_TOKEN=<bearer> replaces user/password (a token you already hold).
//   KC_ADMIN_REALM (master) and KC_ADMIN_CLIENT_ID (admin-cli) override the
//   realm and client the password grant goes to.
//
// Idempotent. Every run converges on the same state:
//   realm    created from the export when missing; when present only the
//            clients in the export are reconciled (settings, URIs, mappers)
//   clients  redirect URIs / web origins are unioned with the export and the
//            --web-origin values, so nothing an admin added by hand is lost
//   users    created once (enabled, e-mail verified, username = e-mail);
//            later runs update names and flags and never touch the password
//
// Nothing secret is printed: not the token, not a password, not the body of
// the token endpoint's response. Exit status 1 on any failure.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REALM_FILE = resolve(HERE, 'realm', 'csq-realm.json');
const RESET_LINK_LIFESPAN_SECONDS = 7 * 24 * 60 * 60;
const FRONTEND_CLIENT_ID = 'csq-frontend';

// ---- CLI ---------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { webOrigins: [], usersFile: null, realmFile: DEFAULT_REALM_FILE, realm: null, dryRun: false, resendEmails: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--web-origin':
        args.webOrigins.push(normaliseOrigin(next()));
        break;
      case '--users':
        args.usersFile = next();
        break;
      case '--realm-file':
        args.realmFile = resolve(next());
        break;
      case '--realm':
        args.realm = next();
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--resend-emails':
        args.resendEmails = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new UsageError(`unknown argument ${arg}`);
    }
  }
  return args;
}

export function normaliseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`--web-origin must be an absolute URL, got ${value}`);
  }
  if (url.pathname !== '/' || url.search || url.hash) throw new UsageError(`--web-origin must be an origin without a path, got ${value}`);
  return url.origin;
}

class UsageError extends Error {}

class KeycloakError extends Error {
  constructor(status, message) {
    super(`Keycloak answered ${status}${message ? `: ${message}` : ''}`);
    this.status = status;
  }
}

// ---- HTTP --------------------------------------------------------------------

export class KeycloakAdmin {
  /** @param {string} baseUrl  @param {string} token  @param {(line: string) => void} log */
  constructor(baseUrl, token, log = console.log) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.log = log;
    this.fetch = globalThis.fetch;
  }

  /** JSON in, JSON out. Returns `{ status, body, headers }`; throws on >= 400 unless `allow` lists the status. */
  async request(method, path, { body, query, allow = [] } = {}) {
    const url = new URL(`${this.baseUrl}/admin/realms${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (response.status >= 400 && !allow.includes(response.status)) {
      if (response.status === 401) throw new KeycloakError(401, 'the admin token was rejected (expired, or not an admin of the master realm)');
      throw new KeycloakError(response.status, errorMessageOf(parsed));
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }
}

/** Keycloak's error bodies carry `errorMessage` or `error`; nothing else is echoed. */
function errorMessageOf(body) {
  if (!body || typeof body !== 'object') return '';
  const message = body.errorMessage ?? body.error_description ?? body.error;
  return typeof message === 'string' ? message : '';
}

export async function obtainToken({ url, user, password, realm = 'master', clientId = 'admin-cli' }, fetchImpl = globalThis.fetch) {
  const endpoint = `${url.replace(/\/+$/, '')}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;
  const form = new URLSearchParams({ grant_type: 'password', client_id: clientId, username: user, password });
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body || typeof body.access_token !== 'string') {
    const reason = errorMessageOf(body) || 'no access token in the response';
    throw new Error(`could not obtain an admin token from ${endpoint} (${response.status}): ${reason}`);
  }
  return body.access_token;
}

// ---- realm and clients -------------------------------------------------------

function idOf(created, fallbackPath) {
  const location = created.headers?.get?.('location') ?? '';
  const id = location.split('/').filter(Boolean).pop();
  if (!id) throw new Error(`Keycloak did not return a Location for the created ${fallbackPath}`);
  return id;
}

export function union(...lists) {
  const seen = new Set();
  for (const list of lists) for (const item of list ?? []) if (typeof item === 'string' && item) seen.add(item);
  return [...seen];
}

/**
 * The client representation from the export, with `--web-origin` values folded
 * in. The first origin also becomes the Root URL (used only when the client is
 * created; see CLIENT_FIELDS for what later runs reconcile).
 */
export function desiredClient(exported, webOrigins) {
  const client = structuredClone(exported);
  if (client.clientId !== FRONTEND_CLIENT_ID || webOrigins.length === 0) return client;
  client.rootUrl = webOrigins[0];
  client.redirectUris = union(client.redirectUris, webOrigins.map((origin) => `${origin}/*`));
  client.webOrigins = union(client.webOrigins, webOrigins);
  client.attributes = { ...(client.attributes ?? {}) };
  const logout = client.attributes['post.logout.redirect.uris'];
  client.attributes['post.logout.redirect.uris'] = union(logout ? logout.split('##') : [], webOrigins.map((origin) => `${origin}/*`)).join('##');
  return client;
}

/**
 * Fields of the export that are compared with (and written to) an existing
 * client. rootUrl and baseUrl are deliberately absent: they are
 * deployment-specific, so an administrator's value is never reverted.
 */
const CLIENT_FIELDS = [
  'name', 'description', 'enabled', 'publicClient', 'bearerOnly', 'standardFlowEnabled', 'implicitFlowEnabled',
  'directAccessGrantsEnabled', 'serviceAccountsEnabled', 'protocol', 'fullScopeAllowed',
  'frontchannelLogout', 'consentRequired',
];

export function clientPatch(existing, desired) {
  const patch = {};
  for (const field of CLIENT_FIELDS) {
    if (desired[field] !== undefined && !deepEqual(existing[field], desired[field])) patch[field] = desired[field];
  }
  for (const field of ['redirectUris', 'webOrigins']) {
    if (desired[field] === undefined) continue;
    const merged = union(existing[field], desired[field]);
    if (!sameSet(merged, existing[field] ?? [])) patch[field] = merged;
  }
  if (desired.attributes) {
    const attributes = {};
    for (const [key, value] of Object.entries(desired.attributes)) {
      const current = existing.attributes?.[key];
      const next = key === 'post.logout.redirect.uris' ? union(current ? current.split('##') : [], value.split('##')).join('##') : value;
      if (current !== next) attributes[key] = next;
    }
    if (Object.keys(attributes).length > 0) patch.attributes = attributes;
  }
  return patch;
}

function sameSet(a, b) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function reconcileMappers(kc, realm, clientUuid, desiredMappers, dryRun, log) {
  if (!desiredMappers || desiredMappers.length === 0) return;
  const { body: existing } = await kc.request('GET', `/${realm}/clients/${clientUuid}/protocol-mappers/models`);
  for (const mapper of desiredMappers) {
    const current = (existing ?? []).find((m) => m.name === mapper.name);
    if (!current) {
      log(`  ${dryRun ? 'would create' : 'create'} mapper "${mapper.name}"`);
      if (!dryRun) await kc.request('POST', `/${realm}/clients/${clientUuid}/protocol-mappers/models`, { body: mapper });
      continue;
    }
    const same = current.protocolMapper === mapper.protocolMapper && deepEqual({ ...(current.config ?? {}), ...(mapper.config ?? {}) }, current.config ?? {});
    if (same) {
      log(`  mapper "${mapper.name}" up to date`);
      continue;
    }
    log(`  ${dryRun ? 'would update' : 'update'} mapper "${mapper.name}"`);
    if (!dryRun) {
      await kc.request('PUT', `/${realm}/clients/${clientUuid}/protocol-mappers/models/${current.id}`, {
        body: { ...current, ...mapper, id: current.id, config: { ...(current.config ?? {}), ...(mapper.config ?? {}) } },
      });
    }
  }
}

export async function ensureClient(kc, realm, exported, webOrigins, { dryRun, log }) {
  const desired = desiredClient(exported, webOrigins);
  const { body: found } = await kc.request('GET', `/${realm}/clients`, { query: { clientId: desired.clientId } });
  const existing = (found ?? [])[0];
  if (!existing) {
    log(`client ${desired.clientId}: ${dryRun ? 'would create' : 'create'}`);
    if (dryRun) return { clientId: desired.clientId, action: 'create' };
    const created = await kc.request('POST', `/${realm}/clients`, { body: desired });
    return { clientId: desired.clientId, action: 'created', id: idOf(created, 'client') };
  }
  const patch = clientPatch(existing, desired);
  const changed = Object.keys(patch);
  if (changed.length === 0) {
    log(`client ${desired.clientId}: up to date`);
  } else {
    log(`client ${desired.clientId}: ${dryRun ? 'would update' : 'update'} ${changed.join(', ')}`);
    if (!dryRun) await kc.request('PUT', `/${realm}/clients/${existing.id}`, { body: { id: existing.id, clientId: existing.clientId, ...patch } });
  }
  await reconcileMappers(kc, realm, existing.id, desired.protocolMappers, dryRun, log);
  return { clientId: desired.clientId, action: changed.length === 0 ? 'unchanged' : dryRun ? 'update' : 'updated', id: existing.id };
}

export async function ensureRealm(kc, exported, realmName, webOrigins, { dryRun, log }) {
  const realm = realmName ?? exported.realm;
  if (!realm) throw new Error('the realm export has no "realm" name and --realm was not given');
  const { status } = await kc.request('GET', `/${realm}`, { allow: [404, 403] });
  if (status === 200) {
    log(`realm ${realm}: exists; reconciling ${exported.clients?.length ?? 0} client(s)`);
    const results = [];
    for (const client of exported.clients ?? []) results.push(await ensureClient(kc, realm, client, webOrigins, { dryRun, log }));
    return { realm, action: 'reconciled', clients: results };
  }
  const representation = structuredClone(exported);
  representation.realm = realm;
  representation.clients = (representation.clients ?? []).map((client) => desiredClient(client, webOrigins));
  const clientIds = representation.clients.map((client) => client.clientId).join(', ');
  log(`realm ${realm}: missing; ${dryRun ? 'would create' : 'create'} from export with clients ${clientIds}`);
  if (!dryRun) await kc.request('POST', '', { body: representation });
  return { realm, action: dryRun ? 'create' : 'created', clients: representation.clients.map((client) => ({ clientId: client.clientId, action: dryRun ? 'create' : 'created' })) };
}

// ---- users -------------------------------------------------------------------

export function validateUsers(input, fileName) {
  const list = Array.isArray(input) ? input : Array.isArray(input?.users) ? input.users : null;
  if (!list) throw new UsageError(`${fileName} must be a JSON array of users (or { "users": [...] })`);
  return list.map((entry, index) => {
    const where = `${fileName}[${index}]`;
    if (!entry || typeof entry !== 'object') throw new UsageError(`${where} is not an object`);
    const email = typeof entry.email === 'string' ? entry.email.trim().toLowerCase() : '';
    if (!email.includes('@')) throw new UsageError(`${where}: "email" is required`);
    const firstName = stringOr(entry.firstName, '');
    const lastName = stringOr(entry.lastName, '');
    const temporaryPassword = entry.temporaryPassword;
    if (temporaryPassword !== undefined && (typeof temporaryPassword !== 'string' || temporaryPassword.length < 8)) {
      throw new UsageError(`${where}: "temporaryPassword" must be a string of at least 8 characters`);
    }
    const sendResetEmail = entry.sendResetEmail === true;
    return { email, firstName, lastName, temporaryPassword, sendResetEmail };
  });
}

function stringOr(value, fallback) {
  return typeof value === 'string' ? value.trim() : fallback;
}

async function sendResetEmail(kc, realm, userId, webOrigins, { dryRun, log }) {
  const query = { lifespan: RESET_LINK_LIFESPAN_SECONDS };
  if (webOrigins.length > 0) {
    query.client_id = FRONTEND_CLIENT_ID;
    query.redirect_uri = `${webOrigins[0]}/`;
  }
  log(`  ${dryRun ? 'would send' : 'send'} UPDATE_PASSWORD e-mail (valid ${RESET_LINK_LIFESPAN_SECONDS / 86400} days)`);
  if (dryRun) return true;
  try {
    await kc.request('PUT', `/${realm}/users/${userId}/execute-actions-email`, { body: ['UPDATE_PASSWORD'], query });
    return true;
  } catch (error) {
    log(`  ERROR e-mail not sent: ${error.message} (is SMTP configured for the realm?)`);
    return false;
  }
}

export async function ensureUsers(kc, realm, users, webOrigins, { dryRun, log, resendEmails = false }) {
  const results = [];
  let failures = 0;
  for (const spec of users) {
    const { body: found } = await kc.request('GET', `/${realm}/users`, { query: { email: spec.email, exact: true } });
    const existing = (found ?? []).find((user) => (user.email ?? '').toLowerCase() === spec.email);
    if (existing) {
      const patch = {};
      if (spec.firstName && existing.firstName !== spec.firstName) patch.firstName = spec.firstName;
      if (spec.lastName && existing.lastName !== spec.lastName) patch.lastName = spec.lastName;
      if (existing.enabled !== true) patch.enabled = true;
      if (existing.emailVerified !== true) patch.emailVerified = true;
      const changed = Object.keys(patch);
      log(`kept     ${existing.id}  ${spec.email}${changed.length ? `  (${dryRun ? 'would update' : 'update'} ${changed.join(', ')})` : ''}`);
      if (changed.length > 0 && !dryRun) await kc.request('PUT', `/${realm}/users/${existing.id}`, { body: patch });
      if (spec.temporaryPassword) log('  password unchanged (temporaryPassword applies at creation only)');
      // Existing users are not mailed again unless asked, and then only
      // while they still have the UPDATE_PASSWORD action pending.
      if (spec.sendResetEmail && (existing.requiredActions ?? []).includes('UPDATE_PASSWORD')) {
        if (!resendEmails) log('  UPDATE_PASSWORD still pending; add --resend-emails to send the e-mail again');
        else if (!(await sendResetEmail(kc, realm, existing.id, webOrigins, { dryRun, log }))) failures += 1;
      }
      results.push({ email: spec.email, id: existing.id, action: 'kept' });
      continue;
    }
    const representation = {
      username: spec.email,
      email: spec.email,
      firstName: spec.firstName,
      lastName: spec.lastName,
      enabled: true,
      emailVerified: true,
      requiredActions: spec.sendResetEmail ? ['UPDATE_PASSWORD'] : [],
      ...(spec.temporaryPassword ? { credentials: [{ type: 'password', value: spec.temporaryPassword, temporary: true }] } : {}),
    };
    if (dryRun) {
      log(`create   (dry run)  ${spec.email}  ${describeCredential(spec)}`);
      if (spec.sendResetEmail) await sendResetEmail(kc, realm, null, webOrigins, { dryRun, log });
      results.push({ email: spec.email, id: null, action: 'create' });
      continue;
    }
    const created = await kc.request('POST', `/${realm}/users`, { body: representation });
    const id = idOf(created, 'user');
    log(`created  ${id}  ${spec.email}  ${describeCredential(spec)}`);
    if (spec.sendResetEmail && !(await sendResetEmail(kc, realm, id, webOrigins, { dryRun, log }))) failures += 1;
    results.push({ email: spec.email, id, action: 'created' });
  }
  return { results, failures };
}

function describeCredential(spec) {
  if (spec.temporaryPassword) return 'temporary password, change at first sign-in';
  if (spec.sendResetEmail) return 'password via e-mail';
  return 'NO CREDENTIAL: set a password in the console';
}

// ---- main --------------------------------------------------------------------

const USAGE = `usage: KC_URL=… (KC_ADMIN_USER=… KC_ADMIN_PASSWORD=… | KC_ADMIN_TOKEN=…) \\
         node provision.mjs [--web-origin <origin>]... [--users <file>] [--resend-emails] \\
                            [--realm-file <path>] [--realm <name>] [--dry-run]`;

export async function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const args = parseArgs(argv);
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const url = (env.KC_URL ?? '').trim();
  if (!url) throw new UsageError('KC_URL is required (e.g. https://auth.tinydata.in)');
  new URL(url); // throws on garbage

  const exported = JSON.parse(await readFile(args.realmFile, 'utf8'));
  const users = args.usersFile ? validateUsers(JSON.parse(await readFile(args.usersFile, 'utf8')), args.usersFile) : [];

  const token = env.KC_ADMIN_TOKEN?.trim()
    ? env.KC_ADMIN_TOKEN.trim()
    : await obtainToken({
        url,
        user: requireEnv(env, 'KC_ADMIN_USER'),
        password: requireEnv(env, 'KC_ADMIN_PASSWORD'),
        realm: env.KC_ADMIN_REALM?.trim() || 'master',
        clientId: env.KC_ADMIN_CLIENT_ID?.trim() || 'admin-cli',
      });
  const kc = new KeycloakAdmin(url, token, log);
  const options = { dryRun: args.dryRun, resendEmails: args.resendEmails, log };

  if (args.dryRun) log('dry run: nothing is written');
  const realmResult = await ensureRealm(kc, exported, args.realm, args.webOrigins, options);
  if (args.webOrigins.length > 0) log(`web origins ensured on ${FRONTEND_CLIENT_ID}: ${args.webOrigins.join(', ')}`);

  let failures = 0;
  if (users.length > 0) {
    if (realmResult.action === 'create') {
      log(`users: ${users.length} would be created once the realm exists`);
    } else {
      log(`users (${users.length}):`);
      const outcome = await ensureUsers(kc, realmResult.realm, users, args.webOrigins, options);
      failures += outcome.failures;
    }
  }
  if (failures > 0) {
    log(`${failures} user action(s) failed`);
    return 1;
  }
  log(args.dryRun ? 'dry run complete' : 'done');
  return 0;
}

function requireEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new UsageError(`${name} is required when KC_ADMIN_TOKEN is not set`);
  return value;
}

/** Belt and braces: no secret ever reaches stderr, whatever an error message contains. */
function redact(message, env) {
  let out = message;
  for (const name of ['KC_ADMIN_PASSWORD', 'KC_ADMIN_TOKEN']) {
    const secret = env[name];
    if (secret && secret.length >= 4) out = out.split(secret).join('***');
  }
  return out;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`error: ${redact(message, process.env)}`);
      if (error instanceof UsageError) console.error(USAGE);
      process.exit(1);
    },
  );
}
