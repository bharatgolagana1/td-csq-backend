import type { ClientSession, FilterQuery, Types } from 'mongoose';

import type { Principal } from '../../core/auth/keycloak.js';
import type { RequestContext } from '../../core/auth/session.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { and } from '../../core/filters.js';
import { idString, toId } from '../../core/ids.js';
import { logger } from '../../core/logger.js';
import { pageOf, parseSort, searchFilter, skipLimit, type Page } from '../../core/pagination.js';
import { audit } from '../audit/audit.service.js';
import { send } from '../notifications/notifications.service.js';
import type { OrganisationDoc } from '../organisations/organisations.model.js';
import { findOrganisationById } from '../organisations/organisations.service.js';

import type { AddMembershipInput, CreateUserInput, MembershipDto, PatchUserInput, UserDto, UserListQuery } from './identity.schemas.js';
import {
  ensureMembership,
  findMembershipById,
  listActiveUserIdsInOrg,
  listMembershipsForUsers,
  setMembershipStatus,
  type MembershipView,
} from './memberships.service.js';
import type { RoleDoc } from './roles.model.js';
import { assertRoleFitsOrg, requireRoleByCode } from './roles.service.js';
import { UserModel, type UserDoc } from './users.model.js';

// --- sign-in ---------------------------------------------------------------

/**
 * Finds the CSQ user for a verified token: by Keycloak sub, else by e-mail
 * when the account has never signed in (INVITED/ACTIVE, no sub) — that first
 * sign-in links the account and activates it. Anyone else is refused.
 */
export async function findUserForPrincipal(principal: Principal): Promise<UserDoc> {
  const bySub = await UserModel.findOne({ keycloakSub: principal.sub }).lean<UserDoc>();
  if (bySub) return bySub;
  if (principal.email) {
    const linked = await UserModel.findOneAndUpdate(
      { email: principal.email, keycloakSub: null, status: { $in: ['INVITED', 'ACTIVE'] } },
      { $set: { keycloakSub: principal.sub, status: 'ACTIVE', lastLoginAt: new Date() } },
      { new: true },
    ).lean<UserDoc>();
    if (linked) {
      logger.info({ userId: idString(linked._id), email: linked.email }, 'Linked CSQ account to Keycloak identity');
      return linked;
    }
  }
  throw new AppError('FORBIDDEN', 'No CSQ account for this sign-in');
}

const LAST_LOGIN_REFRESH_MS = 10 * 60 * 1000;

/** Records activity without writing on every request. */
export async function touchLastLogin(user: UserDoc): Promise<void> {
  if (user.lastLoginAt && Date.now() - user.lastLoginAt.getTime() < LAST_LOGIN_REFRESH_MS) return;
  await UserModel.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
}

// --- DTOs ------------------------------------------------------------------

function toMembershipDto(view: MembershipView): MembershipDto {
  return {
    id: view.id,
    orgId: view.orgId,
    orgCode: view.orgCode,
    orgName: view.orgName,
    orgType: view.orgType,
    orgStatus: view.orgStatus,
    airportId: view.airportId,
    roleId: view.roleId,
    roleCode: view.roleCode,
    roleName: view.roleName,
    status: view.status,
  };
}

function toUserDto(user: UserDoc, memberships: MembershipView[]): UserDto {
  return {
    id: idString(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    memberships: memberships.map(toMembershipDto),
    createdAt: user.createdAt.toISOString(),
  };
}

/** Memberships an ACO/AIRPORT administrator may see: only those in its own organisation. */
function visibleMemberships(ctx: RequestContext, memberships: MembershipView[]): MembershipView[] {
  return ctx.scope.kind === 'PLATFORM' ? memberships : memberships.filter((m) => m.orgId === ctx.org.id);
}

async function toUserDtos(ctx: RequestContext, users: UserDoc[]): Promise<UserDto[]> {
  const memberships = await listMembershipsForUsers(users.map((user) => user._id));
  return users.map((user) => toUserDto(user, visibleMemberships(ctx, memberships.get(idString(user._id)) ?? [])));
}

// --- tenancy ---------------------------------------------------------------

/** PLATFORM sees every user; other scopes only active members of their organisation. */
async function visibilityFilter(ctx: RequestContext, orgId?: string): Promise<FilterQuery<UserDoc>> {
  if (ctx.scope.kind === 'PLATFORM') {
    return orgId ? { _id: { $in: await listActiveUserIdsInOrg(orgId) } } : {};
  }
  return { _id: { $in: await listActiveUserIdsInOrg(ctx.org.id) } };
}

/** Loads a user the caller may act on, or 404 (cross-tenant reads never 403). */
async function requireVisibleUser(ctx: RequestContext, id: string): Promise<UserDoc> {
  const user = await UserModel.findOne(and<UserDoc>({ _id: toId(id) }, await visibilityFilter(ctx))).lean<UserDoc>();
  if (!user) throw new AppError('NOT_FOUND', 'User not found');
  return user;
}

/** The organisation + role a membership may be created with, under the caller's scope rules. */
async function resolveMembershipTarget(
  ctx: RequestContext,
  orgId: string,
  roleCode: string,
): Promise<{ org: OrganisationDoc; role: RoleDoc }> {
  if (ctx.scope.kind !== 'PLATFORM' && orgId !== ctx.org.id) throw new AppError('NOT_FOUND', 'Organisation not found');
  const org = await findOrganisationById(orgId);
  if (!org) throw new AppError('NOT_FOUND', 'Organisation not found');
  if (org.status === 'INACTIVE') throw new AppError('PRECONDITION_FAILED', `Organisation ${org.code} is inactive`);
  const role = await requireRoleByCode(roleCode);
  assertRoleFitsOrg(role, org.type);
  return { org, role };
}

// --- queries ---------------------------------------------------------------

const SORTABLE = ['name', 'email', 'status', 'createdAt', 'lastLoginAt'] as const;

export async function listUsers(ctx: RequestContext, query: UserListQuery): Promise<Page<UserDto>> {
  const filter = and<UserDoc>(
    await visibilityFilter(ctx, query.orgId),
    searchFilter<UserDoc>(query.q, ['name', 'email']),
    query.status ? { status: query.status } : {},
  );
  const sort = parseSort(query.sort, SORTABLE, 'name');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    UserModel.find(filter).sort(sort).skip(skip).limit(limit).lean<UserDoc[]>(),
    UserModel.countDocuments(filter),
  ]);
  return pageOf(await toUserDtos(ctx, docs), total, query);
}

export async function getUser(ctx: RequestContext, id: string): Promise<UserDto> {
  const user = await requireVisibleUser(ctx, id);
  return (await toUserDtos(ctx, [user]))[0] as UserDto;
}

// --- commands --------------------------------------------------------------

export interface InvitedUserInput {
  name: string;
  email: string;
  phone?: string | null | undefined;
}

/** Finds the user by e-mail or creates it INVITED. Used inside the operator-creation transaction. */
export async function findOrCreateInvitedUser(
  input: InvitedUserInput,
  session?: ClientSession,
): Promise<{ user: UserDoc; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const existing = await UserModel.findOne({ email }).session(session ?? null).lean<UserDoc>();
  if (existing) return { user: existing, created: false };
  const [created] = await UserModel.create(
    [{ email, name: input.name.trim(), phone: input.phone ?? null, status: 'INVITED' }],
    session ? { session } : {},
  );
  if (!created) throw new Error('User insert returned nothing');
  return { user: created.toObject(), created: true };
}

async function sendInvite(ctx: RequestContext, user: UserDoc, org: OrganisationDoc, role: RoleDoc): Promise<void> {
  await send({
    template: 'account-invited',
    to: user.email,
    vars: { name: user.name, orgName: org.name, roleName: role.name, invitedBy: ctx.user.name },
    refs: { userId: idString(user._id), acoId: org.type === 'ACO' ? idString(org._id) : null },
  });
}

/** POST /users: creates the user INVITED with one membership and sends the invitation. */
export async function createUser(ctx: RequestContext, input: CreateUserInput): Promise<UserDto> {
  const { org, role } = await resolveMembershipTarget(ctx, input.orgId, input.roleCode);
  const existing = await UserModel.findOne({ email: input.email }).lean<UserDoc>();
  if (existing) {
    throw new AppError('CONFLICT', 'A user with this e-mail already exists; add a membership instead', {
      userId: idString(existing._id),
    });
  }
  const user = await withTransaction(async (session) => {
    const { user: created } = await findOrCreateInvitedUser(input, session);
    await ensureMembership({ userId: created._id, orgId: org._id, roleId: role._id }, session);
    return created;
  });
  await sendInvite(ctx, user, org, role);
  const dto = await getUser(ctx, idString(user._id));
  await audit(ctx, { action: 'user.created', entity: 'user', entityId: dto.id, after: dto, orgId: idString(org._id) });
  return dto;
}

export async function updateUser(ctx: RequestContext, id: string, patch: PatchUserInput): Promise<UserDto> {
  const before = await requireVisibleUser(ctx, id);
  const $set: Partial<Pick<UserDoc, 'name' | 'phone' | 'status'>> = {};
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.phone !== undefined) $set.phone = patch.phone;
  if (patch.status !== undefined) {
    if (idString(before._id) === ctx.user.id && patch.status === 'SUSPENDED') {
      throw new AppError('PRECONDITION_FAILED', 'You cannot suspend your own account');
    }
    $set.status = patch.status;
  }
  if (Object.keys($set).length > 0) await UserModel.updateOne({ _id: before._id }, { $set });
  const dto = await getUser(ctx, id);
  await audit(ctx, {
    action: 'user.updated',
    entity: 'user',
    entityId: dto.id,
    before: { name: before.name, phone: before.phone, status: before.status },
    after: { name: dto.name, phone: dto.phone, status: dto.status },
  });
  return dto;
}

export async function addMembership(ctx: RequestContext, userId: string, input: AddMembershipInput): Promise<UserDto> {
  const user = await requireVisibleUserOrSelfOrg(ctx, userId, input.orgId);
  const { org, role } = await resolveMembershipTarget(ctx, input.orgId, input.roleCode);
  const membership = await ensureMembership({ userId: user._id, orgId: org._id, roleId: role._id });
  await sendInvite(ctx, user, org, role);
  const dto = await getUser(ctx, userId);
  await audit(ctx, {
    action: 'user.updated',
    entity: 'user',
    entityId: dto.id,
    after: { membershipId: idString(membership._id), orgCode: org.code, roleCode: role.code, status: 'ACTIVE' },
    orgId: idString(org._id),
  });
  return dto;
}

/**
 * PLATFORM may add any user to any organisation. An ACO/AIRPORT administrator
 * may only add to its own organisation, and the user must already be visible
 * to it (a member) — otherwise 404, so e-mail addresses cannot be probed.
 */
async function requireVisibleUserOrSelfOrg(ctx: RequestContext, userId: string, orgId: string): Promise<UserDoc> {
  if (ctx.scope.kind === 'PLATFORM') {
    const user = await UserModel.findById(toId(userId)).lean<UserDoc>();
    if (!user) throw new AppError('NOT_FOUND', 'User not found');
    return user;
  }
  if (orgId !== ctx.org.id) throw new AppError('NOT_FOUND', 'Organisation not found');
  return requireVisibleUser(ctx, userId);
}

export async function removeMembership(ctx: RequestContext, userId: string, membershipId: string): Promise<UserDto> {
  const user = await requireVisibleUser(ctx, userId);
  const membership = await findMembershipById(membershipId);
  if (!membership || idString(membership.userId) !== idString(user._id)) {
    throw new AppError('NOT_FOUND', 'Membership not found');
  }
  if (ctx.scope.kind !== 'PLATFORM' && idString(membership.orgId) !== ctx.org.id) {
    throw new AppError('NOT_FOUND', 'Membership not found');
  }
  if (idString(user._id) === ctx.user.id && idString(membership.orgId) === ctx.org.id) {
    throw new AppError('PRECONDITION_FAILED', 'You cannot remove your own active membership');
  }
  await setMembershipStatus(membership._id, 'INACTIVE');
  const dto = await getUser(ctx, userId);
  await audit(ctx, {
    action: 'user.updated',
    entity: 'user',
    entityId: dto.id,
    before: { membershipId, status: membership.status },
    after: { membershipId, status: 'INACTIVE' },
    orgId: idString(membership.orgId),
  });
  return dto;
}

export async function findUserById(id: string | Types.ObjectId): Promise<UserDoc | null> {
  return UserModel.findById(toId(idString(id))).lean<UserDoc>();
}
