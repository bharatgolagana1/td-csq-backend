import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';
import { getRbacVersion } from '../src/modules/settings/settings.service.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { expectError } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let acoUser: TestUser;
let acoAdmin: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  acoUser = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_USER' });
  acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN' });
});
afterAll(() => t.close());

describe('requireTask', () => {
  it('403s a role without the task and names it', async () => {
    const error = expectError(await acoUser.get('/api/v1/users'), 403, 'FORBIDDEN');
    expect(error.details).toEqual({ task: 'users.view' });
    expect(error.message).toContain('ACO_USER');
  });

  it('lets a role with the task through', async () => {
    expect((await acoAdmin.get('/api/v1/users')).status).toBe(200);
    expect((await superAdmin.get('/api/v1/users')).status).toBe(200);
  });

  it('ACO_ADMIN cannot save the matrix (roles.manage is a platform task)', async () => {
    expectError(await acoAdmin.put('/api/v1/roles/matrix').send({ roles: [] }), 403, 'FORBIDDEN');
    expectError(await acoAdmin.get('/api/v1/roles/matrix'), 403, 'FORBIDDEN');
  });
});

describe('PUT /roles/matrix', () => {
  it('returns the matrix with every task and seeded role', async () => {
    const res = await superAdmin.get('/api/v1/roles/matrix');
    expect(res.status).toBe(200);
    const { tasks, roles } = res.body.data as {
      tasks: { code: string; module: string }[];
      roles: { code: string; tasks: string[]; system: boolean }[];
    };
    expect(tasks.map((task) => task.code)).toContain('users.manage');
    expect(tasks.find((task) => task.code === 'operators.view')?.module).toBe('organisations');
    expect(roles.map((role) => role.code).sort()).toEqual(
      ['ACFI_ANALYST', 'ACO_ADMIN', 'ACO_USER', 'AIRPORT_ADMIN', 'AIRPORT_VIEWER', 'SUPER_ADMIN'].sort(),
    );
    const sa = roles.find((role) => role.code === 'SUPER_ADMIN')!;
    expect(sa.tasks.length).toBe(tasks.length);
    expect(sa.system).toBe(true);
    expect(roles.find((role) => role.code === 'ACO_USER')?.tasks).toEqual(['assessments.self', 'customers.view', 'reports.operator', 'sampling.view'].filter((c) => tasks.some((task) => task.code === c)));
  });

  it('saves the whole matrix, bumps rbacVersion and takes effect on the next request', async () => {
    const before = await getRbacVersion();
    const matrix = await superAdmin.get('/api/v1/roles/matrix');
    const roles = matrix.body.data.roles as { id: string; code: string; tasks: string[] }[];
    const target = roles.find((role) => role.code === 'ACO_USER')!;

    const res = await superAdmin.put('/api/v1/roles/matrix').send({ roles: [{ roleId: target.id, tasks: [...target.tasks, 'users.view'] }] });
    expect(res.status).toBe(200);
    expect((res.body.data.roles as typeof roles).find((role) => role.code === 'ACO_USER')?.tasks).toContain('users.view');
    expect(await getRbacVersion()).toBe(before + 1);

    const list = await acoUser.get('/api/v1/users');
    expect(list.status).toBe(200);
    const me = await acoUser.get('/api/v1/me');
    expect(me.body.data.active.tasks).toContain('users.view');

    // Roles not in the payload are untouched.
    expect((res.body.data.roles as typeof roles).find((role) => role.code === 'SUPER_ADMIN')?.tasks.length).toBe(
      roles.find((role) => role.code === 'SUPER_ADMIN')!.tasks.length,
    );
  });

  it('revoking removes access on the next request', async () => {
    const roles = (await superAdmin.get('/api/v1/roles/matrix')).body.data.roles as { id: string; code: string; tasks: string[] }[];
    const target = roles.find((role) => role.code === 'ACO_USER')!;
    await superAdmin.put('/api/v1/roles/matrix').send({ roles: [{ roleId: target.id, tasks: target.tasks.filter((task) => task !== 'users.view') }] });
    expectError(await acoUser.get('/api/v1/users'), 403, 'FORBIDDEN');
  });

  it('rejects unknown roles and tasks with every problem listed', async () => {
    const roles = (await superAdmin.get('/api/v1/roles/matrix')).body.data.roles as { id: string; code: string }[];
    const res = await superAdmin.put('/api/v1/roles/matrix').send({
      roles: [
        { roleId: roles[0]!.id, tasks: ['nope.view', 'users.view'] },
        { roleId: '0123456789abcdef01234567', tasks: [] },
      ],
    });
    const error = expectError(res, 400, 'VALIDATION');
    const issues = (error.details as { issues: { path: string; message: string }[] }).issues;
    expect(issues.map((issue) => issue.path).sort()).toEqual(['roles.0.tasks.0', 'roles.1.roleId']);
  });

  it('refuses to strip roles.manage from the caller\'s own role', async () => {
    const res = await superAdmin.put('/api/v1/roles/matrix').send({ roles: [{ roleId: idString(superAdmin.role._id), tasks: ['users.view'] }] });
    expectError(res, 412, 'PRECONDITION_FAILED');
    expect((await superAdmin.get('/api/v1/roles/matrix')).status).toBe(200);
  });

  it('validates the body shape', async () => {
    expectError(await superAdmin.put('/api/v1/roles/matrix').send({ roles: [] }), 400, 'VALIDATION');
    expectError(await superAdmin.put('/api/v1/roles/matrix').send({ roles: [{ roleId: 'x', tasks: [] }] }), 400, 'VALIDATION');
  });
});
