import type { AnyBulkWriteOperation, UpdateQuery } from 'mongoose';
import { fail, forbidden, unauthenticated } from '../../kernel/errors.js';
import { currentScope, type Principal } from '../../kernel/requestContext.js';
import { UserModel, type UserDoc } from '../../kernel/identity/models.js';
import {
  MembershipModel,
  OrgUserModel,
  OrganizationModel,
  RoleDefinitionModel,
  type MembershipDoc,
  type OrgUserDoc,
  type OrganizationDoc,
} from './orgs.models.js';
import { ADMINISTERING_ORG_TYPES, type OrgType, type UserStatus } from './orgs.contracts.js';

/**
 * Access projection.
 *
 * The kernel authenticates by reading one row out of its users collection and
 * trusting the capabilities embedded in it. That row is therefore a read model,
 * and this file is the only thing that writes it. The system of record is the
 * memberships collection plus the seeded role catalogue; everything here
 * recomputes the read model from those two and nothing else.
 *
 * Every write happens in the order that fails closed. Granting writes the
 * membership first and projects second, so a failure leaves access not yet
 * granted. Revoking projects first and writes the membership second, so a
 * failure leaves access already gone.
 */

export interface ProjectedEntry {
  readonly orgId: string;
  readonly roles: string[];
  readonly capabilities: string[];
  readonly active: boolean;
}

/**
 * A platform route runs in system scope, where the tenancy plugin applies no
 * filter at all. Writes made there name their organisation explicitly, and this
 * refuses to let that code path be reached from an ordinary request.
 */
export function requireSystemScope(what: string): void {
  if (currentScope().kind !== 'SYSTEM') {
    throw fail('INTERNAL', `${what} names its organisation explicitly and may only run in system scope`);
  }
}

export async function loadRoleDefinitions(
  codes: readonly string[],
): Promise<Map<string, { capabilities: string[]; orgTypes: OrgType[] }>> {
  if (codes.length === 0) return new Map();
  const rows = await RoleDefinitionModel.find({ _id: { $in: [...codes] } })
    .select('_id capabilities orgTypes')
    .lean()
    .exec();
  return new Map(rows.map((row) => [row._id, { capabilities: row.capabilities, orgTypes: row.orgTypes }]));
}

/**
 * A role class exists in the catalogue and is grantable inside this type of
 * organisation. Checked on the way in rather than at projection time, so an
 * administrator is told which role was wrong instead of quietly getting a
 * membership that grants nothing.
 */
export async function assertRoleClassesGrantable(
  roleClasses: readonly string[],
  orgType: OrgType,
): Promise<void> {
  const known = await loadRoleDefinitions(roleClasses);
  const problems: Array<{ path: string; message: string }> = [];

  roleClasses.forEach((code, index) => {
    const definition = known.get(code);
    if (!definition) {
      problems.push({ path: `roleClasses.${index}`, message: `${code} is not a role class` });
      return;
    }
    if (!definition.orgTypes.includes(orgType)) {
      problems.push({ path: `roleClasses.${index}`, message: `${code} cannot be granted in a ${orgType}` });
    }
  });

  if (problems.length > 0) throw fail('VALIDATION_FAILED', 'Unknown or ungrantable role class', problems);
}

export async function capabilitiesFor(roleClasses: readonly string[]): Promise<string[]> {
  const known = await loadRoleDefinitions(roleClasses);
  const union = new Set<string>();
  for (const code of roleClasses) {
    for (const capability of known.get(code)?.capabilities ?? []) union.add(capability);
  }
  return [...union].sort();
}

export function withinWindow(membership: Pick<MembershipDoc, 'validFrom' | 'validUntil'>, now: Date): boolean {
  if (membership.validFrom.getTime() > now.getTime()) return false;
  return membership.validUntil === null || membership.validUntil.getTime() > now.getTime();
}

/** What the projection will say. A membership is live only if all three agree. */
export function isEffective(
  membership: Pick<MembershipDoc, 'isActive' | 'validFrom' | 'validUntil'>,
  org: Pick<OrganizationDoc, 'state'>,
  now: Date,
): boolean {
  return membership.isActive && org.state === 'ACTIVE' && withinWindow(membership, now);
}

/**
 * Replaces one organisation's slice of a person's access and leaves every other
 * organisation's slice untouched. Two operations rather than one because Mongo
 * cannot pull and push the same array in a single update, ordered so the
 * removal lands first: between them the person has no access here, which is the
 * safe half second to be interrupted in.
 */
async function writeSlice(userId: string, orgId: string, entry: ProjectedEntry | null): Promise<void> {
  const pull: UpdateQuery<UserDoc> = { $pull: { memberships: { orgId } } };
  const operations: Array<AnyBulkWriteOperation<UserDoc>> = [
    { updateOne: { filter: { _id: userId }, update: pull } },
  ];
  if (entry) {
    const push: UpdateQuery<UserDoc> = {
      $push: { memberships: { orgId: entry.orgId, roles: entry.roles, capabilities: entry.capabilities, active: entry.active } },
    };
    operations.push({ updateOne: { filter: { _id: userId }, update: push } });
  }
  await UserModel.bulkWrite(operations, { ordered: true });

  await OrgUserModel.updateOne(
    { _id: userId },
    { $inc: { membershipsVersion: 1 }, $set: { lastProjectedAt: new Date() } },
  ).exec();
}

/**
 * Records what the projection now says. The filter names the membership's own
 * organisation, which is the only orgId a caller could not have chosen: the
 * document was read under the scope that owns it.
 */
async function markProjected(membership: Pick<MembershipDoc, '_id'> & { orgId: string }, active: boolean): Promise<void> {
  await MembershipModel.updateOne(
    { _id: membership._id, orgId: membership.orgId },
    { $set: { projectedActive: active, projectedAt: new Date() } },
  ).exec();
}

export type ProjectableMembership = Pick<
  MembershipDoc,
  '_id' | 'userId' | 'roleClasses' | 'isActive' | 'validFrom' | 'validUntil'
> & { orgId: string };

/** Recomputes one membership's access from the record and writes the read model. */
export async function projectMembership(
  membership: ProjectableMembership,
  org: Pick<OrganizationDoc, 'state'>,
  now: Date = new Date(),
): Promise<boolean> {
  const effective = isEffective(membership, org, now);
  const capabilities = effective ? await capabilitiesFor(membership.roleClasses) : [];

  await writeSlice(membership.userId, membership.orgId, {
    orgId: membership.orgId,
    roles: [...membership.roleClasses],
    capabilities,
    active: effective,
  });
  await markProjected(membership, effective);
  return effective;
}

/** Takes access away first and asks questions afterwards. Used before every revocation. */
export async function revokeAccess(membership: ProjectableMembership): Promise<void> {
  await writeSlice(membership.userId, membership.orgId, {
    orgId: membership.orgId,
    roles: [...membership.roleClasses],
    capabilities: [],
    active: false,
  });
  await markProjected(membership, false);
}

/**
 * The kernel needs a row of its own to authenticate against. It is created
 * beside the record rather than derived from it at sign in, because a sign in
 * that has to build an account is a sign in that can fail halfway.
 */
export async function ensureAuthAccount(user: OrgUserDoc): Promise<void> {
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        subject: user.subject,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
      },
      $setOnInsert: { memberships: [], lastSeenAt: null },
    },
    { upsert: true },
  ).exec();
}

/** Suspension has to reach the kernel's row first, because that is what auth reads. */
export async function setAuthAccountStatus(userId: string, status: UserStatus): Promise<void> {
  await UserModel.updateOne({ _id: userId }, { $set: { status } }).exec();
}

export async function linkAuthSubject(userId: string, subject: string): Promise<void> {
  await UserModel.updateOne({ _id: userId }, { $set: { subject } }).exec();
}

/**
 * Capability check for a platform route.
 *
 * The kernel enters system scope before its own capability guard runs, and in
 * system scope hasCapability answers true for everything, so a platform route's
 * declared capability is not actually enforced by the router. This is that
 * check, and it is stricter: the capability counts only when it was granted
 * inside an active organisation whose whole purpose is administering others.
 */
export async function assertPlatformCapability(
  principal: Principal | undefined,
  capability: string,
): Promise<Principal> {
  if (!principal) throw unauthenticated('Authentication required');

  const granting = principal.memberships
    .filter((m) => m.active && m.capabilities.includes(capability))
    .map((m) => m.orgId);
  if (granting.length === 0) throw forbidden(`Requires ${capability}`);

  const administering = await OrganizationModel.countDocuments({
    _id: { $in: granting },
    state: 'ACTIVE',
    type: { $in: [...ADMINISTERING_ORG_TYPES] },
  }).exec();
  if (administering === 0) {
    throw forbidden(`Requires ${capability} granted in an organisation that administers others`);
  }
  return principal;
}
