import type { Request } from 'express';

import { listMembershipsForUser, type MembershipView } from '../../modules/identity/memberships.service.js';
import type { RoleScope } from '../../modules/identity/roles.model.js';
import type { UserStatus } from '../../modules/identity/users.model.js';
import { findUserForPrincipal, touchLastLogin } from '../../modules/identity/users.service.js';
import type { OrgType } from '../../modules/organisations/organisations.model.js';
import { AppError } from '../errors.js';
import { isIdString } from '../ids.js';
import { requestIdOf } from '../request-id.js';

import type { Principal } from './keycloak.js';
import { getTasksForRole } from './rbac.js';

export const ORG_HEADER = 'x-csq-org';

/** Tenancy scope derived from the active organisation's type (ARCHITECTURE §4). */
export type Scope = { kind: 'PLATFORM' } | { kind: 'ACO'; acoId: string } | { kind: 'AIRPORT'; airportId: string };

export interface CtxUser {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
}

export interface CtxOrg {
  id: string;
  type: OrgType;
  code: string;
  name: string;
  airportId: string | null;
}

export interface CtxRole {
  id: string;
  code: string;
  scope: RoleScope;
}

/**
 * `req.ctx` — everything a service needs to authorise and scope a call.
 * Services take `ctx` as their first argument and never read `req`.
 */
export interface RequestContext {
  user: CtxUser;
  org: CtxOrg;
  role: CtxRole;
  tasks: ReadonlySet<string>;
  scope: Scope;
  /** For audit rows. */
  requestId: string;
  ip: string;
}

export function scopeForOrg(org: { type: OrgType; id: string; airportId: string | null }): Scope {
  switch (org.type) {
    case 'ACFI':
      return { kind: 'PLATFORM' };
    case 'ACO':
      return { kind: 'ACO', acoId: org.id };
    case 'AIRPORT':
      if (org.airportId === null) {
        throw new AppError('FORBIDDEN', 'Airport organisation is not linked to an airport');
      }
      return { kind: 'AIRPORT', airportId: org.airportId };
  }
}

function requestedOrgId(req: Request): string | null {
  const value = req.headers[ORG_HEADER];
  const id = (Array.isArray(value) ? value[0] : value)?.trim();
  return id === undefined || id === '' ? null : id;
}

function chooseMembership(memberships: MembershipView[], requested: string | null): MembershipView {
  if (requested !== null) {
    const match = isIdString(requested) ? memberships.find((m) => m.orgId === requested) : undefined;
    // 404 (not 403) so the header cannot be used to probe organisation ids.
    if (!match) throw new AppError('NOT_FOUND', 'Organisation not found');
    return match;
  }
  const first = memberships[0];
  if (!first) throw new AppError('FORBIDDEN', 'No active membership for this account');
  return first;
}

/**
 * Builds the signed-in context from a verified principal:
 * user (linked by Keycloak sub, else by e-mail on first sign-in) → ACTIVE
 * memberships → active organisation (`x-csq-org` or the first) → role tasks.
 * Memoised on `req.ctx`.
 */
export async function resolveSession(req: Request, principal: Principal): Promise<RequestContext> {
  if (req.ctx) return req.ctx;

  const user = await findUserForPrincipal(principal);
  if (user.status === 'SUSPENDED') throw new AppError('FORBIDDEN', 'This account is suspended');

  const memberships = (await listMembershipsForUser(user._id)).filter(
    (m) => m.status === 'ACTIVE' && m.orgStatus !== 'INACTIVE',
  );
  const active = chooseMembership(memberships, requestedOrgId(req));
  const org: CtxOrg = {
    id: active.orgId,
    type: active.orgType,
    code: active.orgCode,
    name: active.orgName,
    airportId: active.airportId,
  };
  const ctx: RequestContext = {
    user: { id: user._id.toHexString(), email: user.email, name: user.name, status: user.status },
    org,
    role: { id: active.roleId, code: active.roleCode, scope: active.roleScope },
    tasks: await getTasksForRole(active.roleId),
    scope: scopeForOrg(org),
    requestId: requestIdOf(req),
    ip: req.ip ?? '',
  };
  await touchLastLogin(user);
  req.ctx = ctx;
  return ctx;
}
