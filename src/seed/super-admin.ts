import { AppError } from '../core/errors.js';
import { idString } from '../core/ids.js';
import { ensureMembership } from '../modules/identity/memberships.service.js';
import { findRoleByCode } from '../modules/identity/roles.service.js';
import { UserModel, type UserDoc } from '../modules/identity/users.model.js';
import { ensureAcfiOrganisation } from '../modules/organisations/organisations.service.js';

export interface SuperAdminInput {
  email: string;
  name: string;
}

/**
 * Creates (or links) the first SUPER_ADMIN: the user is INVITED with no
 * Keycloak sub, so the first sign-in with this e-mail from Keycloak links and
 * activates it (ARCHITECTURE §4). Re-running keeps the existing user.
 */
export async function ensureSuperAdmin(input: SuperAdminInput): Promise<{ user: UserDoc; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const role = await findRoleByCode('SUPER_ADMIN');
  if (!role) throw new AppError('PRECONDITION_FAILED', 'SUPER_ADMIN role missing; run the core seed first');
  const acfi = await ensureAcfiOrganisation();
  const existing = await UserModel.findOne({ email }).lean<UserDoc>();
  const user =
    existing ?? (await UserModel.create({ email, name: input.name.trim(), status: 'INVITED' })).toObject();
  await ensureMembership({ userId: user._id, orgId: acfi._id, roleId: role._id });
  return { user: { ...user, _id: user._id }, created: !existing };
}

export function describeSuperAdmin(user: UserDoc): string {
  return `${user.name} <${user.email}> (${idString(user._id)}, ${user.status})`;
}
