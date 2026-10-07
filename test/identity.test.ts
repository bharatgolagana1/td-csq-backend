import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { MembershipModel } from '../src/modules/identity/memberships.model.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { createTestOperator, expectError } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let acfiId: string;
let acoId: string;

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  acfiId = idString(superAdmin.org._id);
  acoId = idString((await createTestOperator({ code: 'ID-ACO' }))._id);
});
afterAll(() => t.close());

describe('GET /me', () => {
  it('returns the user, memberships and the active organisation with its tasks', async () => {
    const res = await superAdmin.get('/api/v1/me');
    expect(res.status).toBe(200);
    const me = res.body.data;
    expect(me.user).toMatchObject({ email: superAdmin.user.email, name: 'Platform Admin', status: 'ACTIVE' });
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0]).toMatchObject({ orgCode: 'ACFI', orgType: 'ACFI', roleCode: 'SUPER_ADMIN', roleName: 'Super Admin', airportId: null });
    expect(me.active).toMatchObject({ orgId: acfiId, orgType: 'ACFI', roleCode: 'SUPER_ADMIN', scope: { kind: 'PLATFORM' } });
    expect(me.active.tasks).toEqual(expect.arrayContaining(['users.manage', 'roles.manage', 'settings.manage']));
  });
});

describe('POST /users', () => {
  let createdId: string;

  it('creates an INVITED user with a membership, sends the invitation and audits', async () => {
    const res = await superAdmin
      .post('/api/v1/users')
      .send({ name: 'Priya Nair', email: 'Priya.Nair@Test.csq', phone: '+91 98765 43210', orgId: acfiId, roleCode: 'acfi_analyst' });
    expect(res.status).toBe(201);
    const user = res.body.data;
    createdId = user.id;
    expect(user).toMatchObject({ name: 'Priya Nair', email: 'priya.nair@test.csq', phone: '+91 98765 43210', status: 'INVITED', lastLoginAt: null });
    expect(user.memberships).toHaveLength(1);
    expect(user.memberships[0]).toMatchObject({ orgId: acfiId, orgCode: 'ACFI', roleCode: 'ACFI_ANALYST', status: 'ACTIVE' });

    const mail = await NotificationModel.findOne({ to: 'priya.nair@test.csq', template: 'account-invited' }).lean();
    expect(mail?.status).toBe('SENT');
    expect(mail?.channel).toBe('LOG');
    expect(mail?.subject).toContain('invited');
    expect(mail?.body).toContain('Platform Admin has added you to Air Cargo Forum India');
    expect(mail?.body).toContain('ACFI Analyst');
    expect(idString(mail!.refs.userId!)).toBe(createdId);

    const audit = await AuditModel.findOne({ action: 'user.created', entityId: createdId }).lean();
    expect(audit?.actorEmail).toBe(superAdmin.user.email);
    expect(audit?.requestId).toBeTruthy();
  });

  it('rejects a duplicate e-mail with 409 and points at memberships', async () => {
    const res = await superAdmin.post('/api/v1/users').send({ name: 'Again', email: 'priya.nair@test.csq', orgId: acfiId, roleCode: 'ACFI_ANALYST' });
    const error = expectError(res, 409, 'CONFLICT');
    expect(error.details).toEqual({ userId: createdId });
  });

  it('validates input: bad e-mail, unknown role, role scope mismatch, unknown organisation', async () => {
    expectError(await superAdmin.post('/api/v1/users').send({ name: 'X', email: 'nope', orgId: acfiId, roleCode: 'ACFI_ANALYST' }), 400, 'VALIDATION');
    const unknownRole = await superAdmin.post('/api/v1/users').send({ name: 'X', email: 'x1@test.csq', orgId: acfiId, roleCode: 'NOPE_ROLE' });
    expect(expectError(unknownRole, 400, 'VALIDATION').message).toContain('Unknown role');
    const mismatch = await superAdmin.post('/api/v1/users').send({ name: 'X', email: 'x2@test.csq', orgId: acfiId, roleCode: 'ACO_ADMIN' });
    expect(expectError(mismatch, 400, 'VALIDATION').message).toContain('cannot be used in a ACFI organisation');
    expectError(
      await superAdmin.post('/api/v1/users').send({ name: 'X', email: 'x3@test.csq', orgId: '0123456789abcdef01234567', roleCode: 'ACO_ADMIN' }),
      404,
      'NOT_FOUND',
    );
    expectError(await superAdmin.post('/api/v1/users').send({ name: 'X', email: 'x4@test.csq', orgId: acfiId, roleCode: 'ACFI_ANALYST', extra: 1 }), 400, 'VALIDATION');
  });

  it('PATCH edits name, phone and status, and audits before/after', async () => {
    const res = await superAdmin.patch(`/api/v1/users/${createdId}`).send({ name: 'Priya N.', phone: null, status: 'SUSPENDED' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Priya N.', phone: null, status: 'SUSPENDED' });
    const audit = await AuditModel.findOne({ action: 'user.updated', entityId: createdId }).lean();
    expect(audit?.before).toMatchObject({ name: 'Priya Nair', status: 'INVITED' });
    expect(audit?.after).toMatchObject({ name: 'Priya N.', status: 'SUSPENDED' });
    expectError(await superAdmin.patch(`/api/v1/users/${createdId}`).send({ email: 'new@test.csq' }), 400, 'VALIDATION');
    expectError(await superAdmin.patch('/api/v1/users/0123456789abcdef01234567').send({ name: 'x' }), 404, 'NOT_FOUND');
  });

  it('refuses to suspend yourself', async () => {
    expectError(await superAdmin.patch(`/api/v1/users/${idString(superAdmin.user._id)}`).send({ status: 'SUSPENDED' }), 412, 'PRECONDITION_FAILED');
  });

  it('adds a membership in another organisation (one per organisation, role replaceable)', async () => {
    const added = await superAdmin.post(`/api/v1/users/${createdId}/memberships`).send({ orgId: acoId, roleCode: 'ACO_USER' });
    expect(added.status).toBe(201);
    expect(added.body.data.memberships).toHaveLength(2);
    const replaced = await superAdmin.post(`/api/v1/users/${createdId}/memberships`).send({ orgId: acoId, roleCode: 'ACO_ADMIN' });
    expect(replaced.body.data.memberships).toHaveLength(2);
    expect((replaced.body.data.memberships as { orgId: string; roleCode: string }[]).find((m) => m.orgId === acoId)?.roleCode).toBe('ACO_ADMIN');
    expect(await MembershipModel.countDocuments({ userId: createdId })).toBe(2);
    expect(await NotificationModel.countDocuments({ to: 'priya.nair@test.csq' })).toBe(3);
  });

  it('removes a membership by setting it INACTIVE and refuses removing your own', async () => {
    const user = (await superAdmin.get(`/api/v1/users?q=priya`)).body.data[0];
    const membership = (user.memberships as { id: string; orgId: string }[]).find((m) => m.orgId === acoId)!;
    const res = await superAdmin.delete(`/api/v1/users/${createdId}/memberships/${membership.id}`);
    expect(res.status).toBe(200);
    expect((res.body.data.memberships as { id: string; status: string }[]).find((m) => m.id === membership.id)?.status).toBe('INACTIVE');
    expectError(await superAdmin.delete(`/api/v1/users/${createdId}/memberships/0123456789abcdef01234567`), 404, 'NOT_FOUND');

    const own = (await superAdmin.get('/api/v1/me')).body.data.memberships[0].id as string;
    expectError(await superAdmin.delete(`/api/v1/users/${idString(superAdmin.user._id)}/memberships/${own}`), 412, 'PRECONDITION_FAILED');
  });

  it('lists with search, status filter, sort and paging', async () => {
    const page = await superAdmin.get('/api/v1/users?pageSize=1&page=2&sort=-createdAt');
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ page: 2, pageSize: 1 });
    const suspended = await superAdmin.get('/api/v1/users?status=SUSPENDED');
    expect((suspended.body.data as { id: string }[]).map((u) => u.id)).toEqual([createdId]);
    expectError(await superAdmin.get('/api/v1/users?sort=password'), 400, 'VALIDATION');
  });
});

describe('roles', () => {
  it('lists seeded roles with task counts', async () => {
    const res = await superAdmin.get('/api/v1/roles');
    expect(res.status).toBe(200);
    const roles = res.body.data as { code: string; system: boolean; taskCount: number; scope: string }[];
    expect(roles).toHaveLength(6);
    expect(roles.every((role) => role.system)).toBe(true);
    expect(roles.find((role) => role.code === 'SUPER_ADMIN')!.taskCount).toBeGreaterThan(10);
    expect(roles.find((role) => role.code === 'AIRPORT_VIEWER')!.taskCount).toBe(0);
  });

  it('creates and renames a custom role; code and scope are immutable; duplicates 409', async () => {
    const created = await superAdmin.post('/api/v1/roles').send({ code: 'aco_auditor', name: 'Operator Auditor', description: 'Read-only', scope: 'ACO' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ code: 'ACO_AUDITOR', name: 'Operator Auditor', scope: 'ACO', system: false, taskCount: 0 });
    expectError(await superAdmin.post('/api/v1/roles').send({ code: 'ACO_AUDITOR', name: 'Dup', scope: 'ACO' }), 409, 'CONFLICT');
    const patched = await superAdmin.patch(`/api/v1/roles/${created.body.data.id}`).send({ name: 'Auditor' });
    expect(patched.body.data.name).toBe('Auditor');
    expectError(await superAdmin.patch(`/api/v1/roles/${created.body.data.id}`).send({ scope: 'PLATFORM' }), 400, 'VALIDATION');
    expectError(await superAdmin.patch('/api/v1/roles/0123456789abcdef01234567').send({ name: 'x' }), 404, 'NOT_FOUND');
  });

  it('an operator admin sees only ACO roles', async () => {
    const acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: acoId });
    await superAdmin.put('/api/v1/roles/matrix').send({
      roles: [{ roleId: idString(acoAdmin.role._id), tasks: [...(await acoAdmin.get('/api/v1/me')).body.data.active.tasks, 'roles.view'] }],
    });
    const res = await acoAdmin.get('/api/v1/roles');
    expect(res.status).toBe(200);
    expect((res.body.data as { scope: string }[]).every((role) => role.scope === 'ACO')).toBe(true);
  });
});
