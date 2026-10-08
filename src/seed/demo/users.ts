// The people of the demo: the platform actor (the super admin from the
// flag), one ACO_ADMIN per operator (made by the organisations service), a
// second ACO_USER at the two Delhi operators and an ACFI analyst. Every
// account is INVITED with a fictional @example.in address; the super admin
// is the one record the seed does not tag, exactly like the core seed.
import type { RequestContext } from '../../core/auth/session.js';
import { idString } from '../../core/ids.js';
import { listActiveUserIdsInOrg, listMembershipsForUsers } from '../../modules/identity/memberships.service.js';
import type { RoleDoc } from '../../modules/identity/roles.model.js';
import { findRoleByCode } from '../../modules/identity/roles.service.js';
import { UserModel, type UserDoc } from '../../modules/identity/users.model.js';
import { createUser, findUserById, listUsers } from '../../modules/identity/users.service.js';
import type { OrganisationDoc } from '../../modules/organisations/organisations.model.js';
import { ensureAcfiOrganisation } from '../../modules/organisations/organisations.service.js';
import { ensureSuperAdmin, type SuperAdminInput } from '../super-admin.js';

import type { DemoOperator } from './operators.js';
import { contextFor, demoKey, findDemoId, tagDemo } from './runtime.js';

export const DEMO_SUPER_ADMIN: SuperAdminInput = { email: 'acfi.admin@example.in', name: 'ACFI Demo Admin' };

export interface PlatformActor {
  ctx: RequestContext;
  user: UserDoc;
  acfi: OrganisationDoc;
  role: RoleDoc;
}

export async function requireRole(code: string): Promise<RoleDoc> {
  const role = await findRoleByCode(code);
  if (!role) throw new Error(`Role ${code} is not seeded; run npm run seed first`);
  return role;
}

/** The first active SUPER_ADMIN member of ACFI, when there is one. */
async function existingSuperAdmin(acfi: OrganisationDoc): Promise<UserDoc | null> {
  const userIds = await listActiveUserIdsInOrg(acfi._id);
  const memberships = await listMembershipsForUsers(userIds);
  for (const userId of userIds) {
    const views = memberships.get(idString(userId)) ?? [];
    if (!views.some((view) => view.orgId === idString(acfi._id) && view.roleCode === 'SUPER_ADMIN' && view.status === 'ACTIVE')) continue;
    const user = await findUserById(userId);
    if (user && user.status !== 'SUSPENDED') return user;
  }
  return null;
}

/**
 * Who the seed acts as: `--super-admin` creates or keeps that account (never
 * tagged); without the flag an existing super admin is used; failing that a
 * tagged demo super admin is created so the seed runs on an empty database.
 */
export async function resolvePlatformActor(superAdmin: SuperAdminInput | null): Promise<PlatformActor> {
  const acfi = await ensureAcfiOrganisation();
  const role = await requireRole('SUPER_ADMIN');
  let user: UserDoc | null = null;
  if (superAdmin) {
    user = (await ensureSuperAdmin(superAdmin)).user;
  } else {
    user = await existingSuperAdmin(acfi);
    if (!user) {
      user = (await ensureSuperAdmin(DEMO_SUPER_ADMIN)).user;
      await tagDemo(UserModel, idString(user._id), demoKey('user', DEMO_SUPER_ADMIN.email));
    }
  }
  return { ctx: await contextFor(user, acfi, role), user, acfi, role };
}

interface DemoUserSpec {
  name: string;
  email: string;
  phone: string;
  orgId: string;
  roleCode: string;
}

async function findByEmail(ctx: RequestContext, email: string): Promise<string | null> {
  const page = await listUsers(ctx, { page: 1, pageSize: 50, q: email });
  return page.data.find((user) => user.email === email)?.id ?? null;
}

async function ensureUser(ctx: RequestContext, spec: DemoUserSpec): Promise<{ id: string; created: boolean }> {
  const key = demoKey('user', spec.email);
  const tagged = await findDemoId(UserModel, key);
  if (tagged !== null) return { id: tagged, created: false };
  const existing = await findByEmail(ctx, spec.email);
  if (existing !== null) {
    await tagDemo(UserModel, existing, key);
    return { id: existing, created: false };
  }
  const dto = await createUser(ctx, { name: spec.name, email: spec.email, phone: spec.phone, orgId: spec.orgId, roleCode: spec.roleCode });
  await tagDemo(UserModel, dto.id, key);
  return { id: dto.id, created: true };
}

export interface DemoUsersResult {
  created: number;
  kept: number;
}

/** Tags every operator admin, then adds the extra users; returns how many were created this run. */
export async function ensureDemoUsers(actor: PlatformActor, operators: readonly DemoOperator[]): Promise<DemoUsersResult> {
  const result: DemoUsersResult = { created: 0, kept: 0 };
  for (const operator of operators) {
    await tagDemo(UserModel, idString(operator.admin._id), demoKey('user', operator.admin.email));
    if (operator.created) result.created += 1;
    else result.kept += 1;
  }
  const extra: DemoUserSpec[] = [];
  const delhi = operators.filter((operator) => operator.spec.iata === 'DEL');
  const [first, second] = delhi;
  if (first) extra.push({ name: 'Sameer Khan', email: 'sameer.khan@delcts.example.in', phone: '+91 98100 00001', orgId: idString(first.org._id), roleCode: 'ACO_USER' });
  if (second) extra.push({ name: 'Neha Verma', email: 'neha.verma@northerncargohub.example.in', phone: '+91 98100 00002', orgId: idString(second.org._id), roleCode: 'ACO_USER' });
  extra.push({ name: 'Ananya Krishnan', email: 'ananya.krishnan@example.in', phone: '+91 98100 00003', orgId: idString(actor.acfi._id), roleCode: 'ACFI_ANALYST' });
  for (const spec of extra) {
    const { created } = await ensureUser(actor.ctx, spec);
    if (created) result.created += 1;
    else result.kept += 1;
  }
  return result;
}

/** The context the operator's admin acts under (selection, lock, self-assessment). */
export async function operatorContext(operator: DemoOperator): Promise<RequestContext> {
  return contextFor(operator.admin, operator.org, await requireRole('ACO_ADMIN'));
}
