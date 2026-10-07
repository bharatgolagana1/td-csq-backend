import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';

import type { MeDto } from './identity.schemas.js';
import { listMembershipsForUser } from './memberships.service.js';
import { findUserById } from './users.service.js';

/** GET /me — the signed-in user, every active membership, and the active organisation's role/tasks/scope. */
export async function getMe(ctx: RequestContext): Promise<MeDto> {
  const user = await findUserById(ctx.user.id);
  if (!user) throw new AppError('UNAUTHENTICATED', 'User no longer exists');
  const memberships = (await listMembershipsForUser(user._id)).filter((m) => m.status === 'ACTIVE' && m.orgStatus !== 'INACTIVE');
  return {
    user: {
      id: ctx.user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      status: user.status,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    },
    memberships: memberships.map((m) => ({
      id: m.id,
      orgId: m.orgId,
      orgCode: m.orgCode,
      orgName: m.orgName,
      orgType: m.orgType,
      roleCode: m.roleCode,
      roleName: m.roleName,
      airportId: m.airportId,
    })),
    active: {
      orgId: ctx.org.id,
      orgType: ctx.org.type,
      roleCode: ctx.role.code,
      tasks: [...ctx.tasks].sort(),
      scope: ctx.scope,
    },
  };
}
