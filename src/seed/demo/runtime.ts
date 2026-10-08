// What the demo seed needs around the services: request contexts for the
// actors it impersonates, the runtime the services expect (notifications,
// event listeners, the demo OTP switch) and the `demoKey` / `demo` tags that
// make re-runs idempotent and `--reset` precise.
import type { Model } from 'mongoose';

import type { Env } from '../../config/env.js';
import { createLinkSessions } from '../../core/auth/link.js';
import { getTasksForRole } from '../../core/auth/rbac.js';
import { scopeForOrg, type RequestContext } from '../../core/auth/session.js';
import { idString, toId } from '../../core/ids.js';
import type { RoleDoc } from '../../modules/identity/roles.model.js';
import type { UserDoc } from '../../modules/identity/users.model.js';
import { registerModuleHandlers } from '../../modules/index.js';
import { configureInvitations } from '../../modules/invitations/invitations.config.js';
import { configureNotifications } from '../../modules/notifications/notifications.service.js';
import { createLogTransport } from '../../modules/notifications/notifications.transport.js';
import type { OrganisationDoc } from '../../modules/organisations/organisations.model.js';
import { DEFAULT_SETTINGS } from '../../modules/settings/settings.service.js';

export const DEMO_REQUEST_ID = 'seed-demo';

/** Every document the seed creates carries `demoKey: 'demo:<entity>:<name>'`; derived rows carry `demo: true`. */
export function demoKey(entity: string, name: string): string {
  return `demo:${entity}:${name}`;
}

/** The filter `--reset` deletes with, and the test counts with. */
export const DEMO_FILTER = { $or: [{ demo: true }, { demoKey: { $exists: true } }] };

/**
 * Tags are written through the native collection on purpose: the models do
 * not declare `demoKey` / `demo` (the brief forbids changing them) and
 * mongoose would strip unknown paths from a schema-bound update.
 */
export async function tagDemo<T>(model: Model<T>, id: string, key: string): Promise<void> {
  await model.collection.updateOne({ _id: toId(id) }, { $set: { demoKey: key, demo: true } });
}

/** Read through the native collection too: `strictQuery` would silently drop the unknown `demoKey` path from a model query. */
export async function findDemoId<T>(model: Model<T>, key: string): Promise<string | null> {
  const doc = await model.collection.findOne({ demoKey: key }, { projection: { _id: 1 } });
  return doc ? idString(doc._id) : null;
}

/** How many tagged documents share a key prefix (`demo:customer:DEL-CTS:`). */
export async function countDemoByPrefix<T>(model: Model<T>, prefix: string): Promise<number> {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return model.collection.countDocuments({ demoKey: { $regex: `^${escaped}` } });
}

// --- contexts --------------------------------------------------------------

/** The `req.ctx` a route would resolve for `user` acting in `org` with `role`; tasks come from the matrix. */
export async function contextFor(user: UserDoc, org: OrganisationDoc, role: RoleDoc): Promise<RequestContext> {
  const ctxOrg = {
    id: idString(org._id),
    type: org.type,
    code: org.code,
    name: org.name,
    airportId: org.airportId ? idString(org.airportId) : null,
  };
  return {
    user: { id: idString(user._id), email: user.email, name: user.name, status: user.status },
    org: ctxOrg,
    role: { id: idString(role._id), code: role.code, scope: role.scope },
    tasks: await getTasksForRole(idString(role._id)),
    scope: scopeForOrg(ctxOrg),
    requestId: DEMO_REQUEST_ID,
    ip: '',
  };
}

// --- runtime ---------------------------------------------------------------

/**
 * The services assume the app booted: notifications configured, the modules'
 * event listeners registered, the invitations module configured. The seed
 * always uses the LOG mail transport, whatever SMTP_URL says, because every
 * address in the dataset is fictional; `revealOtp` lets the seed walk the
 * participant flow (link → OTP → form → submit) the way a demo does.
 * Returns the function that puts the invitations config back.
 */
export function prepareDemoRuntime(env: Env): () => void {
  configureNotifications({
    transport: createLogTransport(),
    from: env.MAIL_FROM,
    webUrl: env.PUBLIC_WEB_URL,
    brandName: DEFAULT_SETTINGS.branding.orgName,
  });
  registerModuleHandlers();
  configureInvitations({ links: createLinkSessions(env.LINK_SESSION_SECRET), webUrl: env.PUBLIC_WEB_URL, revealOtp: true });
  return () => {
    configureInvitations(null);
  };
}
