import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';
import { ensureMembership } from '../src/modules/identity/memberships.service.js';
import { findRoleByCode } from '../src/modules/identity/roles.service.js';
import { UserModel } from '../src/modules/identity/users.model.js';

import { createTestApp, tokenFor, type TestApp } from './helpers/app.js';
import { createTestOperator, expectError } from './helpers/fixtures.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('bearer authentication', () => {
  it('rejects a missing or malformed token with 401', async () => {
    expectError(await t.anon.get('/api/v1/me'), 401, 'UNAUTHENTICATED');
    expectError(await t.anon.get('/api/v1/me').set('Authorization', 'Bearer garbage'), 401, 'UNAUTHENTICATED');
    expectError(await t.anon.get('/api/v1/me').set('Authorization', 'Bearer test:{not-json'), 401, 'UNAUTHENTICATED');
  });

  it('refuses a verified identity that has no CSQ account with 403', async () => {
    const token = tokenFor({ sub: 'kc-stranger', email: 'stranger@test.csq', name: 'Stranger' });
    const error = expectError(await t.anon.get('/api/v1/me').set('Authorization', `Bearer ${token}`), 403, 'FORBIDDEN');
    expect(error.message).toBe('No CSQ account for this sign-in');
  });

  it('serves /health without credentials', async () => {
    const res = await t.anon.get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data.mongo).toBe(true);
  });
});

describe('first sign-in links by e-mail', () => {
  it('links an INVITED user without a sub, activates it and records lastLoginAt', async () => {
    const invited = await t.asUser({ orgType: 'ACFI', roleCode: 'ACFI_ANALYST', email: 'New.Analyst@test.csq', linked: false, status: 'INVITED' });
    expect(invited.user.keycloakSub).toBeNull();
    const token = tokenFor({ sub: 'kc-fresh-sub', email: 'new.analyst@test.csq', name: 'New Analyst' });
    const res = await t.anon.get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.status).toBe('ACTIVE');
    const stored = await UserModel.findOne({ email: 'new.analyst@test.csq' }).lean();
    expect(stored?.keycloakSub).toBe('kc-fresh-sub');
    expect(stored?.status).toBe('ACTIVE');
    expect(stored?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('matches by e-mail case-insensitively', async () => {
    await t.asUser({ orgType: 'ACFI', roleCode: 'ACFI_ANALYST', email: 'Mixed.Case@test.csq', linked: false, status: 'INVITED' });
    const token = tokenFor({ sub: 'kc-mixed', email: 'MIXED.CASE@TEST.CSQ' });
    expect((await t.anon.get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });

  it('then resolves by sub even when the e-mail claim differs', async () => {
    const token = tokenFor({ sub: 'kc-fresh-sub', email: 'renamed@test.csq' });
    const res = await t.anon.get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('new.analyst@test.csq');
  });

  it('never re-links an account that already has a sub (no takeover by e-mail)', async () => {
    const token = tokenFor({ sub: 'kc-impostor', email: 'new.analyst@test.csq' });
    expectError(await t.anon.get('/api/v1/me').set('Authorization', `Bearer ${token}`), 403, 'FORBIDDEN');
  });

  it('refuses a suspended account', async () => {
    const suspended = await t.asUser({ orgType: 'ACFI', roleCode: 'ACFI_ANALYST', email: 'suspended@test.csq', status: 'SUSPENDED' });
    const error = expectError(await suspended.get('/api/v1/me'), 403, 'FORBIDDEN');
    expect(error.message).toMatch(/suspended/);
  });

  it('refuses a user with no active membership', async () => {
    await UserModel.create({ email: 'nomember@test.csq', name: 'No Member', status: 'ACTIVE', keycloakSub: 'kc-nomember' });
    const token = tokenFor({ sub: 'kc-nomember', email: 'nomember@test.csq' });
    const error = expectError(await t.anon.get('/api/v1/me').set('Authorization', `Bearer ${token}`), 403, 'FORBIDDEN');
    expect(error.message).toMatch(/No active membership/);
  });
});

describe('active organisation (x-csq-org)', () => {
  it('404s when the header names an organisation the user is not a member of', async () => {
    const admin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
    const other = await createTestOperator({ code: 'OTHER-ACO' });
    expectError(await admin.get('/api/v1/me').set('x-csq-org', idString(other._id)), 404, 'NOT_FOUND');
    expectError(await admin.get('/api/v1/me').set('x-csq-org', 'not-an-id'), 404, 'NOT_FOUND');
  });

  it('switches the active organisation, role, tasks and scope', async () => {
    const admin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
    const aco = await createTestOperator({ code: 'SWITCH-ACO', airportIata: 'BOM' });
    const acoUser = await findRoleByCode('ACO_USER');
    await ensureMembership({ userId: admin.user._id, orgId: aco._id, roleId: acoUser!._id });

    const asAcfi = await admin.get('/api/v1/me');
    expect(asAcfi.body.data.active).toMatchObject({ roleCode: 'SUPER_ADMIN', orgType: 'ACFI', scope: { kind: 'PLATFORM' } });
    expect(asAcfi.body.data.memberships).toHaveLength(2);

    const asAco = await admin.get('/api/v1/me').set('x-csq-org', idString(aco._id));
    expect(asAco.status).toBe(200);
    expect(asAco.body.data.active).toMatchObject({
      roleCode: 'ACO_USER',
      orgType: 'ACO',
      scope: { kind: 'ACO', acoId: idString(aco._id) },
    });
    // ACO_USER's default tasks belong to modules that are not registered yet, so the set is small but never a platform set.
    expect(Array.isArray(asAco.body.data.active.tasks)).toBe(true);
    expect(asAco.body.data.active.tasks).not.toContain('users.manage');
    expect(asAcfi.body.data.active.tasks).toContain('users.manage');
  });

  it('defaults to the first active membership without the header', async () => {
    const admin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
    const res = await t.anon.get('/api/v1/me').set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.active.orgId).toBe(idString(admin.org._id));
  });
});
