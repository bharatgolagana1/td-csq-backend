// Reference data every environment needs: tasks (from the module registry),
// roles, the default matrix, settings, the ACFI organisation and airports.
// Idempotent and edit-preserving; the test harness runs it after each reset.
import { idString } from '../core/ids.js';
import { seedAirports } from '../modules/airports/airports.service.js';
import { grantTasksIfAbsent, listTasks } from '../modules/identity/matrix.service.js';
import { upsertSeedRoles } from '../modules/identity/roles.service.js';
import { syncModuleTasks } from '../modules/index.js';
import { ensureAcfiOrganisation } from '../modules/organisations/organisations.service.js';
import { bumpRbacVersion, ensureSettings } from '../modules/settings/settings.service.js';

import { DEFAULT_MATRIX, resolvePatterns } from './matrix.js';
import { SEED_ROLES } from './roles.js';

export interface SeedCoreOptions {
  /** Load the vendored airport list (default true). */
  airports?: boolean;
}

export interface SeedCoreResult {
  tasks: number;
  roles: number;
  grants: number;
  airports: { rows: number; inserted: number } | null;
  acfiOrgId: string;
}

export async function seedCore(options: SeedCoreOptions = {}): Promise<SeedCoreResult> {
  await syncModuleTasks();
  const tasks = await listTasks();
  const roles = await upsertSeedRoles(SEED_ROLES);

  let grants = 0;
  const codes = tasks.map((task) => task.code);
  for (const [roleCode, patterns] of Object.entries(DEFAULT_MATRIX)) {
    const role = roles.get(roleCode);
    if (!role) continue;
    const wanted = new Set(resolvePatterns(patterns, codes));
    const taskIds = tasks.filter((task) => wanted.has(task.code)).map((task) => task._id);
    await grantTasksIfAbsent(role._id, taskIds);
    grants += taskIds.length;
  }
  await ensureSettings();
  await bumpRbacVersion();

  const acfi = await ensureAcfiOrganisation();
  const airports = options.airports === false ? null : await seedAirports();

  return { tasks: tasks.length, roles: roles.size, grants, airports, acfiOrgId: idString(acfi._id) };
}
