import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadRoleTaskCodes } from '../src/modules/identity/matrix.service.js';
import { MembershipModel } from '../src/modules/identity/memberships.model.js';
import { RoleTaskModel } from '../src/modules/identity/role-tasks.model.js';
import { RoleModel } from '../src/modules/identity/roles.model.js';
import { TaskModel } from '../src/modules/identity/tasks.model.js';
import { UserModel } from '../src/modules/identity/users.model.js';
import { collectTasks } from '../src/modules/index.js';
import { OrganisationModel } from '../src/modules/organisations/organisations.model.js';
import { getRbacVersion } from '../src/modules/settings/settings.service.js';
import { seedCore } from '../src/seed/core.js';
import { DEFAULT_MATRIX, matchesPattern, resolvePatterns } from '../src/seed/matrix.js';
import { ensureSuperAdmin } from '../src/seed/super-admin.js';

import { createTestApp, type TestApp } from './helpers/app.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ airports: false });
});
afterAll(() => t.close());

async function tasksOf(code: string): Promise<string[]> {
  const role = await RoleModel.findOne({ code }).lean();
  return [...((await loadRoleTaskCodes()).get(role!._id.toHexString()) ?? [])].sort();
}

describe('seedCore', () => {
  it('upserts every declared task, the six roles, the default matrix, settings and ACFI', async () => {
    const declared = collectTasks();
    expect(await TaskModel.countDocuments()).toBe(declared.length);
    expect((await TaskModel.findOne({ code: 'users.view' }).lean())?.module).toBe('identity');
    expect(await RoleModel.countDocuments({ system: true })).toBe(6);
    expect(await OrganisationModel.countDocuments({ code: 'ACFI', type: 'ACFI', status: 'ACTIVE' })).toBe(1);

    // Each role's default grant is its matrix patterns resolved against the
    // declared tasks, so the expectation grows with the modules instead of
    // pinning the task list of an earlier build.
    const codes = declared.map((task) => task.code);
    const expectedFor = (role: string): string[] => resolvePatterns(DEFAULT_MATRIX[role] ?? [], codes).sort();
    expect(await tasksOf('SUPER_ADMIN')).toEqual(codes.slice().sort());
    for (const role of ['ACO_USER', 'ACO_ADMIN', 'ACFI_ANALYST', 'AIRPORT_ADMIN', 'AIRPORT_VIEWER']) {
      expect(await tasksOf(role), role).toEqual(expectedFor(role));
    }
    expect(expectedFor('ACO_ADMIN')).toContain('sampling.lock');
    expect(expectedFor('ACO_USER')).not.toContain('sampling.lock');
  });

  it('is idempotent and preserves administrators\' edits', async () => {
    const role = await RoleModel.findOne({ code: 'ACFI_ANALYST' }).lean();
    const task = await TaskModel.findOne({ code: 'users.view' }).lean();
    await RoleTaskModel.updateOne({ roleId: role!._id, taskId: task!._id }, { $set: { enabled: false } });
    await RoleModel.updateOne({ code: 'ACFI_ANALYST' }, { $set: { name: 'Renamed Analyst' } });
    const version = await getRbacVersion();

    const result = await seedCore({ airports: false });
    expect(result.roles).toBe(6);
    expect(await RoleModel.countDocuments()).toBe(6);
    expect((await RoleModel.findOne({ code: 'ACFI_ANALYST' }).lean())?.name).toBe('Renamed Analyst');
    expect(await tasksOf('ACFI_ANALYST')).not.toContain('users.view');
    expect(await getRbacVersion()).toBe(version + 1);
  });

  it('resolves matrix patterns', () => {
    expect(matchesPattern('cycles.manage', '*')).toBe(true);
    expect(matchesPattern('cycles.manage', 'cycles.*')).toBe(true);
    expect(matchesPattern('cycles.view', '*.view')).toBe(true);
    expect(matchesPattern('cycles.view', 'cycles.manage')).toBe(false);
    expect(resolvePatterns(['*.view', 'reports.*'], ['a.view', 'reports.operator', 'b.manage'])).toEqual(['a.view', 'reports.operator']);
  });
});

describe('ensureSuperAdmin', () => {
  it('creates an INVITED user with an ACFI SUPER_ADMIN membership and keeps it on re-run', async () => {
    const first = await ensureSuperAdmin({ email: 'Boss@ACFI.in', name: 'The Boss' });
    expect(first.created).toBe(true);
    expect(first.user).toMatchObject({ email: 'boss@acfi.in', status: 'INVITED', keycloakSub: null });
    const acfi = await OrganisationModel.findOne({ code: 'ACFI' }).lean();
    const role = await RoleModel.findOne({ code: 'SUPER_ADMIN' }).lean();
    expect(await MembershipModel.countDocuments({ userId: first.user._id, orgId: acfi!._id, roleId: role!._id, status: 'ACTIVE' })).toBe(1);

    const second = await ensureSuperAdmin({ email: 'boss@acfi.in', name: 'Ignored' });
    expect(second.created).toBe(false);
    expect(await UserModel.countDocuments({ email: 'boss@acfi.in' })).toBe(1);
    expect((await UserModel.findOne({ email: 'boss@acfi.in' }).lean())?.name).toBe('The Boss');
  });
});
