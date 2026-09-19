import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { runAsPrincipal, runWithoutOrg, type Principal } from '../src/kernel/requestContext.js';
import { newId } from '../src/kernel/ids.js';
import { checkModule } from '../src/kernel/router.js';
import {
  ListItemModel,
  OrgSettingsAreaModel,
  OrgSettingsAuditModel,
  PlatformSettingsAreaModel,
  UnscopedSettingsAuditModel,
  UserSettingsAreaModel,
} from '../src/modules/settings/settings.models.js';
import { settingsModule } from '../src/modules/settings/settings.module.js';
import {
  addListItem,
  archiveListItem,
  readList,
  reorderList,
} from '../src/modules/settings/settings.lists.service.js';
import {
  buildCatalogue,
  patchGlobalArea,
  patchOrgArea,
  patchSelfArea,
  readGlobalArea,
  readGlobalAreaAudit,
  readHub,
  readOrgArea,
  readOrgAreaAudit,
  readSelfArea,
} from '../src/modules/settings/settings.service.js';
import { errorHandler, notFoundHandler } from '../src/kernel/errors.js';
import { mountModules } from '../src/kernel/router.js';
import { closeDatabase, openDatabase, silentLog } from './mongo.js';

/**
 * The whole module is tested in one file on purpose. Vitest gives each test
 * file its own module graph, but a mongoose model is registered once per
 * process, so a second file importing the same models would get the first
 * file's compiled middleware and with it the first file's request context.
 *
 * Everything below talks to the real database: the unique indexes behind the
 * first save of an area, and the tenancy plugin that keeps one organisation out
 * of another's settings, only exist in the server.
 */

const ORG_A = newId();
const ORG_B = newId();

function member(orgId: string, capabilities: readonly string[]) {
  return { orgId, roles: ['ADMIN'], capabilities: [...capabilities], active: true };
}

function person(userId: string, memberships: ReadonlyArray<ReturnType<typeof member>>): Principal {
  return {
    userId,
    subject: `sub-${userId}`,
    email: null,
    displayName: userId,
    memberships: [...memberships],
  };
}

const ORG_ADMIN_CAPS = ['settings:read', 'settings:write', 'settings.lists:write'] as const;
const USER_ADMIN_CAPS = [...ORG_ADMIN_CAPS, 'settings.users:read', 'settings.users:write'] as const;
const PLATFORM_CAPS = ['settings.platform:read', 'settings.platform:write'] as const;

const orgAdmin = person('org-admin', [member(ORG_A, ORG_ADMIN_CAPS)]);
const userAdmin = person('user-admin', [member(ORG_A, USER_ADMIN_CAPS)]);
const otherOrgAdmin = person('other-admin', [member(ORG_B, ORG_ADMIN_CAPS)]);
const acfiStaff = person('acfi-staff', [member(ORG_B, [...ORG_ADMIN_CAPS, ...PLATFORM_CAPS])]);
const twoOrgUser = person('two-orgs', [member(ORG_A, ORG_ADMIN_CAPS), member(ORG_B, ORG_ADMIN_CAPS)]);

function asOrgA<T>(who: Principal, fn: () => T): T {
  return runAsPrincipal({ requestId: newId(), principal: who, orgId: ORG_A }, fn);
}

function asOrgB<T>(who: Principal, fn: () => T): T {
  return runAsPrincipal({ requestId: newId(), principal: who, orgId: ORG_B }, fn);
}

/**
 * A SELF route enters a scope with a principal and no organisation. The
 * personal areas and the platform areas are both served from one.
 */
function asSelf<T>(who: Principal, fn: () => T): T {
  return runWithoutOrg({ requestId: newId(), principal: who }, fn);
}

const MODELS = [
  OrgSettingsAreaModel,
  OrgSettingsAuditModel,
  UserSettingsAreaModel,
  PlatformSettingsAreaModel,
  UnscopedSettingsAuditModel,
  ListItemModel,
];

beforeAll(async () => {
  await openDatabase();
  for (const model of MODELS) await model.syncIndexes();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  for (const model of MODELS) {
    await mongoose.connection.collection(model.collection.name).deleteMany({});
  }
});

describe('settings areas', () => {
  it('reads an area that was never saved as its registered defaults', async () => {
    const view = await asOrgA(orgAdmin, () => readOrgArea('notifications'));

    expect(view.revision).toBe(0);
    expect(view.defaultsApplied).toBe(true);
    expect(view.updatedAt).toBeNull();
    expect(view.value['channels']).toEqual({ email: true, whatsapp: false, sms: false });
    expect(view.value['reminders']).toEqual({
      daysBeforeClose: [],
      dailyDigestHourLocal: null,
      escalationEmail: null,
    });
  });

  it('patches one section and leaves the rest of the area at its defaults', async () => {
    const saved = await asOrgA(orgAdmin, () =>
      patchOrgArea('notifications', { channels: { whatsapp: true } }),
    );

    expect(saved.revision).toBe(1);
    expect(saved.defaultsApplied).toBe(false);
    expect(saved.updatedBy).toBe('org-admin');
    expect(saved.value['channels']).toEqual({ email: true, whatsapp: true, sms: false });
    expect(saved.value['reminders']).toMatchObject({ dailyDigestHourLocal: null });

    const reread = await asOrgA(orgAdmin, () => readOrgArea('notifications'));
    expect(reread.value).toEqual(saved.value);
    expect(reread.revision).toBe(1);
  });

  it('fills a field the registry gained after a document was written', async () => {
    // a document stored before an area grew a field holds only what was saved;
    // the defaults underneath it are what make the read whole
    await asOrgA(orgAdmin, () =>
      OrgSettingsAreaModel.create({
        areaKey: 'notifications',
        value: { channels: { email: false } },
        revision: 1,
        updatedBy: null,
      }),
    );

    const view = await asOrgA(orgAdmin, () => readOrgArea('notifications'));

    expect(view.value['channels']).toEqual({ email: false, whatsapp: false, sms: false });
    expect(view.value['reminders']).toEqual({
      daysBeforeClose: [],
      dailyDigestHourLocal: null,
      escalationEmail: null,
    });
  });

  it('refuses a patch based on a revision that has moved on', async () => {
    const first = await asOrgA(orgAdmin, () => patchOrgArea('organisation', { spoc: { name: 'First' } }));

    await expect(
      asOrgA(orgAdmin, () => patchOrgArea('organisation', { spoc: { name: 'Second' } }, first.revision - 1)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const settled = await asOrgA(orgAdmin, () => readOrgArea('organisation'));
    expect(settled.value['spoc']).toMatchObject({ name: 'First' });
    expect(settled.revision).toBe(1);
  });

  it('accepts a patch that states the revision it was based on', async () => {
    const first = await asOrgA(orgAdmin, () => patchOrgArea('organisation', { spoc: { name: 'First' } }));
    const second = await asOrgA(orgAdmin, () =>
      patchOrgArea('organisation', { spoc: { email: 'spoc@example.com' } }, first.revision),
    );

    expect(second.revision).toBe(2);
    expect(second.value['spoc']).toMatchObject({ name: 'First', email: 'spoc@example.com' });
  });

  it('rejects an unknown section, an unknown field and an out of range value', async () => {
    await expect(
      asOrgA(orgAdmin, () => patchOrgArea('notifications', { nonsense: { email: true } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      asOrgA(orgAdmin, () => patchOrgArea('notifications', { channels: { telegram: true } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      asOrgA(orgAdmin, () => patchOrgArea('notifications', { reminders: { dailyDigestHourLocal: 25 } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('treats a patch that names nothing as nothing to do', async () => {
    const before = await asOrgA(orgAdmin, () => readOrgArea('notifications'));
    const after = await asOrgA(orgAdmin, () => patchOrgArea('notifications', {}));

    expect(after.revision).toBe(before.revision);
    expect(await asOrgA(orgAdmin, () => OrgSettingsAreaModel.countDocuments({}).exec())).toBe(0);
  });

  it('keeps one organisation settings out of another', async () => {
    await asOrgA(orgAdmin, () => patchOrgArea('organisation', { details: { legalName: 'Terminal One' } }));

    const theirs = await asOrgB(otherOrgAdmin, () => readOrgArea('organisation'));
    expect(theirs.revision).toBe(0);
    expect(theirs.value['details']).toMatchObject({ legalName: null });
  });

  it('gates an area on the capability the registry names for it', async () => {
    await expect(asOrgA(orgAdmin, () => readOrgArea('users-and-roles'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const allowed = await asOrgA(userAdmin, () => readOrgArea('users-and-roles'));
    expect(allowed.value['invitations']).toMatchObject({ allowSelfService: false });

    await expect(
      asOrgA(orgAdmin, () => patchOrgArea('users-and-roles', { invitations: { allowSelfService: true } })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps personal settings with the person, in every organisation they belong to', async () => {
    await asSelf(twoOrgUser, () => patchSelfArea('display', { layout: { density: 'COMPACT' } }));

    const fromA = await asOrgA(twoOrgUser, () => readSelfArea('display'));
    const fromB = await asOrgB(twoOrgUser, () => readSelfArea('display'));
    const someoneElse = await asSelf(orgAdmin, () => readSelfArea('display'));

    expect(fromA.value['layout']).toMatchObject({ density: 'COMPACT' });
    expect(fromB.value['layout']).toMatchObject({ density: 'COMPACT' });
    expect(someoneElse.value['layout']).toMatchObject({ density: 'COMFORTABLE' });
    expect(someoneElse.revision).toBe(0);
  });

  it('records every change with its actor, and what the value was before it', async () => {
    await asOrgA(orgAdmin, () => patchOrgArea('notifications', { channels: { sms: true } }));
    await asOrgA(orgAdmin, () => patchOrgArea('notifications', { channels: { sms: false } }));

    const history = await asOrgA(orgAdmin, () => readOrgAreaAudit('notifications', 20));

    expect(history).toHaveLength(2);
    const [latest, first] = history;
    expect(latest?.actorUserId).toBe('org-admin');
    expect(latest?.before['channels']).toMatchObject({ sms: true });
    expect(latest?.after['channels']).toMatchObject({ sms: false });
    // the first change is audited against the defaults it replaced
    expect(first?.before['channels']).toMatchObject({ sms: false, email: true });
  });

  it('keeps one organisation audit trail out of another', async () => {
    await asOrgA(orgAdmin, () => patchOrgArea('notifications', { channels: { sms: true } }));

    expect(await asOrgB(otherOrgAdmin, () => readOrgAreaAudit('notifications', 20))).toHaveLength(0);
  });

  it('refuses a platform area to a caller who does not hold the platform capability', async () => {
    await expect(asSelf(orgAdmin, () => readGlobalArea('weightage'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    await expect(
      asSelf(orgAdmin, () => patchGlobalArea('weightage', { publication: { applyMarketShare: true } })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reads platform thresholds from the contract until somebody changes them', async () => {
    const view = await asSelf(acfiStaff, () => readGlobalArea('weightage'));

    expect(view.scope).toBe('GLOBAL');
    expect(view.value['publication']).toEqual({
      minResponsesToPublish: 5,
      minCoverageBp: 6000,
      applyMarketShare: false,
    });
  });

  it('writes a platform area once for the whole platform, audited to the person', async () => {
    const saved = await asSelf(acfiStaff, () =>
      patchGlobalArea('approval-mode', { assessment: { mode: 'TWO_PERSON' } }),
    );
    expect(saved.revision).toBe(1);
    expect(saved.value['assessment']).toMatchObject({ mode: 'TWO_PERSON', escalationHours: 72 });

    const history = await asSelf(acfiStaff, () => readGlobalAreaAudit('approval-mode', 20));
    expect(history).toHaveLength(1);
    expect(history[0]?.actorUserId).toBe('acfi-staff');
    expect(history[0]?.before['assessment']).toMatchObject({ mode: 'ACFI_REVIEW' });
  });

  it('refuses to reach platform settings from inside an organisation scope', async () => {
    await expect(asOrgB(acfiStaff, () => readGlobalArea('weightage'))).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('answers the catalogue with the areas this caller may open, and no others', async () => {
    const forOrgAdmin = asOrgA(orgAdmin, () => buildCatalogue());
    const keys = forOrgAdmin.map((entry) => entry.key);

    expect(keys).toContain('organisation');
    expect(keys).toContain('notifications');
    expect(keys).toContain('my-account');
    expect(keys).toContain('display');
    expect(keys).toContain('lists');
    expect(keys).not.toContain('users-and-roles');
    expect(keys).not.toContain('weightage');

    const organisation = forOrgAdmin.find((entry) => entry.key === 'organisation');
    expect(organisation?.api).toBe('/v1/settings/org/organisation');
    expect(organisation?.route).toBe('/settings/organisation');
    expect(organisation?.writable).toBe(true);
  });

  it('shows an area a caller may read but not write as read only', async () => {
    const readOnly = person('read-only', [member(ORG_A, ['settings:read', 'settings.users:read'])]);
    const entries = asOrgA(readOnly, () => buildCatalogue());

    const users = entries.find((entry) => entry.key === 'users-and-roles');
    expect(users?.writable).toBe(false);

    const organisation = entries.find((entry) => entry.key === 'organisation');
    expect(organisation?.writable).toBe(false);
    // personal areas are always the caller's own, so they are always writable
    expect(entries.find((entry) => entry.key === 'display')?.writable).toBe(true);
  });

  it('shows the platform areas only to staff who hold the platform capability', async () => {
    const staffKeys = asOrgB(acfiStaff, () => buildCatalogue()).map((entry) => entry.key);

    expect(staffKeys).toContain('question-bank');
    expect(staffKeys).toContain('weightage');
    expect(staffKeys).toContain('approval-mode');
    expect(asOrgB(otherOrgAdmin, () => buildCatalogue()).map((e) => e.key)).not.toContain('weightage');
  });
});

describe('curated lists', () => {
  it('refuses a second list entry with the same label', async () => {
    await asOrgA(orgAdmin, () => addListItem('CONTACT_TAG', { label: 'Perishable', colour: null }));

    await expect(
      asOrgA(orgAdmin, () => addListItem('CONTACT_TAG', { label: ' perishable ', colour: null })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('lets two organisations use the same label', async () => {
    await asOrgA(orgAdmin, () => addListItem('CONTACT_TAG', { label: 'Perishable', colour: null }));
    const theirs = await asOrgB(otherOrgAdmin, () =>
      addListItem('CONTACT_TAG', { label: 'Perishable', colour: null }),
    );

    expect(theirs.label).toBe('Perishable');
    expect(await asOrgB(otherOrgAdmin, () => readList('CONTACT_TAG', false))).toHaveLength(1);
  });

  it('refuses an order that does not name every live entry exactly once', async () => {
    const first = await asOrgA(orgAdmin, () =>
      addListItem('DECLINE_REASON', { label: 'No longer a customer', colour: null }),
    );
    await asOrgA(orgAdmin, () => addListItem('DECLINE_REASON', { label: 'Wrong contact', colour: null }));

    await expect(asOrgA(orgAdmin, () => reorderList('DECLINE_REASON', [first.id]))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      asOrgA(orgAdmin, () => reorderList('DECLINE_REASON', [first.id, first.id])),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('applies a complete reorder', async () => {
    const one = await asOrgA(orgAdmin, () => addListItem('TERMINAL_AREA', { label: 'Export dock', colour: null }));
    const two = await asOrgA(orgAdmin, () => addListItem('TERMINAL_AREA', { label: 'Import dock', colour: null }));
    const three = await asOrgA(orgAdmin, () => addListItem('TERMINAL_AREA', { label: 'Cold room', colour: null }));

    const reordered = await asOrgA(orgAdmin, () => reorderList('TERMINAL_AREA', [three.id, one.id, two.id]));

    expect(reordered.map((item) => item.id)).toEqual([three.id, one.id, two.id]);
    expect(reordered.map((item) => item.position)).toEqual([0, 1, 2]);
  });

  it('archives rather than destroys, and frees the label for reuse', async () => {
    const item = await asOrgA(orgAdmin, () => addListItem('CUSTOMER_SEGMENT', { label: 'Forwarder', colour: null }));
    await asOrgA(orgAdmin, () => archiveListItem('CUSTOMER_SEGMENT', item.id));

    expect(await asOrgA(orgAdmin, () => readList('CUSTOMER_SEGMENT', false))).toHaveLength(0);
    expect(await asOrgA(orgAdmin, () => readList('CUSTOMER_SEGMENT', true))).toHaveLength(1);

    const reused = await asOrgA(orgAdmin, () => addListItem('CUSTOMER_SEGMENT', { label: 'Forwarder', colour: null }));
    expect(reused.id).not.toBe(item.id);
  });

  it('refuses to archive an entry belonging to another organisation', async () => {
    const item = await asOrgA(orgAdmin, () => addListItem('CONTACT_TAG', { label: 'Perishable', colour: null }));

    await expect(asOrgB(otherOrgAdmin, () => archiveListItem('CONTACT_TAG', item.id))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('settings module', () => {
  it('passes the route policy check the router applies at boot', () => {
    expect(() => checkModule(settingsModule)).not.toThrow();
  });

  it('answers the hub with the catalogue and the list counts in one round trip', async () => {
    await asOrgA(orgAdmin, () => addListItem('CONTACT_TAG', { label: 'Perishable', colour: '#2f855a' }));
    const hub = await asOrgA(orgAdmin, () => readHub());

    expect(hub.scopedTo).toBe(ORG_A);
    expect(hub.lists.find((l) => l.kind === 'CONTACT_TAG')?.liveCount).toBe(1);
    expect(hub.catalogue.map((entry) => entry.key)).toContain('organisation');
    expect(hub.catalogue.every((entry) => entry.api.startsWith('/v1/settings'))).toBe(true);
  });
});

/**
 * The same routes the process mounts, with the authenticator replaced by a
 * stand-in that enters the scope the real one would. Everything the route table
 * decides, the policy floor, the parameter validation and the error envelope,
 * is exercised here rather than asserted about.
 */
function appFor(who: Principal, orgId: string) {
  const authenticate: RequestHandler = (_req, _res, next) => next();
  const enterOrgScope: RequestHandler = (_req, _res, next) => {
    runAsPrincipal({ requestId: newId(), principal: who, orgId }, () => next());
  };
  const enterSelfScope: RequestHandler = (_req, _res, next) => {
    runWithoutOrg({ requestId: newId(), principal: who }, () => next());
  };

  const app = express();
  app.use(express.json());
  app.use(mountModules([settingsModule], { authenticate, enterSelfScope, enterOrgScope, log: silentLog }));
  app.use(notFoundHandler);
  app.use(errorHandler(silentLog));
  return app;
}

describe('settings endpoints', () => {
  it('serves the catalogue this caller may open', async () => {
    const response = await request(appFor(orgAdmin, ORG_A)).get('/v1/settings/catalogue');

    expect(response.status).toBe(200);
    const keys = (response.body as Array<{ key: string }>).map((entry) => entry.key);
    expect(keys).toContain('organisation');
    expect(keys).not.toContain('users-and-roles');
  });

  it('reads and writes an organisation area over HTTP', async () => {
    const app = appFor(orgAdmin, ORG_A);

    const first = await request(app).get('/v1/settings/org/notifications');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ revision: 0, value: { channels: { email: true } } });

    const saved = await request(app)
      .patch('/v1/settings/org/notifications')
      .send({ value: { channels: { whatsapp: true } } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ revision: 1, value: { channels: { whatsapp: true } } });

    const stale = await request(app)
      .patch('/v1/settings/org/notifications')
      .send({ expectedRevision: 0, value: { channels: { sms: true } } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('answers an area asked for at the wrong scope as a validation failure', async () => {
    const response = await request(appFor(orgAdmin, ORG_A)).get('/v1/settings/org/display');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('refuses an area the caller holds no capability for', async () => {
    const response = await request(appFor(orgAdmin, ORG_A)).get('/v1/settings/org/users-and-roles');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('serves a personal area to anyone signed in', async () => {
    const response = await request(appFor(orgAdmin, ORG_A)).get('/v1/settings/me/navigation');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ scope: 'SELF', value: { landing: { path: '/' } } });
  });

  it('serves a platform area to staff and refuses it to everybody else', async () => {
    const staff = await request(appFor(acfiStaff, ORG_B)).get('/v1/settings/platform/question-bank');
    expect(staff.status).toBe(200);
    expect(staff.body).toMatchObject({ value: { authoring: { codePrefix: 'ACFI' } } });

    const refused = await request(appFor(orgAdmin, ORG_A)).get('/v1/settings/platform/question-bank');
    expect(refused.status).toBe(403);
  });
});
