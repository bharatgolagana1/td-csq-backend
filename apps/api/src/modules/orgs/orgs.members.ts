import type { PipelineStage } from 'mongoose';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { requireOrgId } from '../../kernel/requestContext.js';
import { TenantRepo } from '../../kernel/tenancy.js';
import {
  MembershipModel,
  OrgUserModel,
  OrganizationModel,
  RoleDefinitionModel,
  type MembershipDoc,
  type OrgUserDoc,
  type OrganizationDoc,
} from './orgs.models.js';
import {
  assertRoleClassesGrantable,
  capabilitiesFor,
  isEffective,
  loadRoleDefinitions,
  projectMembership,
  requireSystemScope,
  revokeAccess,
} from './orgs.access.js';
import { findOrCreateUser } from './orgs.users.js';
import { anchoredPrefix, pageOf, toMemberView } from './orgs.views.js';
import type {
  InviteMember,
  MemberListQuery,
  MemberView,
  PageOf,
  PatchMember,
  ScopeMode,
} from './orgs.contracts.js';

/**
 * Memberships. Tenant scoped, so an organisation scoped handler in here never
 * names an organisation at all: the plugin supplies it from the request. The
 * few functions that do name one are platform work, and each of them refuses to
 * run outside system scope.
 */

const members = new TenantRepo<MembershipDoc>(MembershipModel);

const DUPLICATE_KEY = 11000;

/**
 * The capability that makes a membership an administrator of its organisation.
 * Losing the last one locks everybody out of their own member list, and only a
 * platform operator could then undo it.
 */
export const MEMBERS_WRITE = 'orgs.members:write';

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY
  );
}

type MembershipRow = MembershipDoc & { orgId: string };

async function currentOrganization(): Promise<OrganizationDoc> {
  const org = await OrganizationModel.findOne({ _id: requireOrgId() }).lean().exec();
  if (!org) throw fail('INTERNAL', 'The request names an organisation that is not in the registry');
  return org;
}

/** Capabilities for a page of memberships, with one read of the catalogue. */
async function capabilitiesByMembership(rows: readonly MembershipRow[]): Promise<Map<string, string[]>> {
  const codes = new Set<string>();
  for (const row of rows) for (const code of row.roleClasses) codes.add(code);
  const definitions = await loadRoleDefinitions([...codes]);

  const result = new Map<string, string[]>();
  for (const row of rows) {
    const union = new Set<string>();
    for (const code of row.roleClasses) {
      for (const capability of definitions.get(code)?.capabilities ?? []) union.add(capability);
    }
    result.set(row._id, [...union].sort());
  }
  return result;
}

const SORT_PATHS: Readonly<Record<MemberListQuery['sort'], string>> = Object.freeze({
  displayName: 'user.displayNameLower',
  email: 'user.emailLower',
  createdAt: 'createdAt',
  validUntil: 'validUntil',
});

/**
 * One list, two callers. An organisation scoped request passes no id and the
 * tenancy plugin prepends the match; a platform request passes the id it was
 * given in the path and has to be in system scope to do it.
 */
export async function listMembers(query: MemberListQuery, orgId?: string): Promise<PageOf<MemberView>> {
  if (orgId !== undefined) requireSystemScope('Listing another organisation members');

  const membershipMatch: Record<string, unknown> = {};
  if (orgId !== undefined) membershipMatch['orgId'] = orgId;
  if (!query.includeInactive) membershipMatch['isActive'] = true;
  if (query.roleClass) membershipMatch['roleClasses'] = query.roleClass;
  if (query.scopeMode) membershipMatch['scopeMode'] = query.scopeMode;

  const userMatch: Record<string, unknown> = {};
  if (query.kind) userMatch['user.kind'] = query.kind;
  if (query.q) {
    const term = anchoredPrefix(query.q, 'lower');
    userMatch['$or'] = [{ 'user.displayNameLower': term }, { 'user.emailLower': term }];
  }

  const stages: PipelineStage[] = [
    { $match: membershipMatch },
    {
      $lookup: {
        from: OrgUserModel.collection.name,
        localField: 'userId',
        foreignField: '_id',
        as: 'user',
      },
    },
    { $unwind: '$user' },
  ];
  if (Object.keys(userMatch).length > 0) stages.push({ $match: userMatch });
  stages.push({
    $facet: {
      items: [
        { $sort: { [SORT_PATHS[query.sort]]: query.order === 'asc' ? 1 : -1, _id: 1 } },
        { $skip: query.offset },
        { $limit: query.limit },
      ],
      total: [{ $count: 'value' }],
    },
  });

  type Faceted = { items: Array<MembershipRow & { user: OrgUserDoc }>; total: Array<{ value: number }> };
  const [faceted] = await members.aggregate<Faceted>(stages).exec();
  const rows = faceted?.items ?? [];
  const total = faceted?.total[0]?.value ?? 0;

  const capabilities = await capabilitiesByMembership(rows);
  return pageOf(
    rows.map((row) => toMemberView(row, row.user, capabilities.get(row._id) ?? [])),
    total,
    query,
  );
}

async function viewOf(membership: MembershipRow): Promise<MemberView> {
  const user = await OrgUserModel.findOne({ _id: membership.userId }).lean().exec();
  if (!user) throw fail('INTERNAL', 'A membership points at a person who is not on file');
  return toMemberView(membership, user, await capabilitiesFor(membership.roleClasses));
}

export async function getMember(membershipId: string): Promise<MemberView> {
  const membership = await members.findById(membershipId).lean().exec();
  if (!membership) throw notFound('No such member');
  return viewOf(membership);
}

/**
 * Invites somebody into the calling organisation. The person may already exist,
 * in which case they gain a membership and keep the account they have.
 */
export async function addMember(input: InviteMember, invitedBy: string | null): Promise<MemberView> {
  const org = await currentOrganization();
  await assertRoleClassesGrantable(input.roleClasses, org.type);

  const user = await findOrCreateUser({
    email: input.email,
    givenName: input.givenName,
    familyName: input.familyName,
    kind: input.kind,
    phoneE164: input.phoneE164,
    whatsappOptIn: input.whatsappOptIn,
  });

  let created;
  try {
    created = await members.create({
      userId: user._id,
      roleClasses: [...input.roleClasses],
      scopeMode: input.scopeMode,
      scopeIds: [...input.scopeIds],
      validFrom: input.validFrom ?? new Date(),
      validUntil: input.validUntil,
      isActive: true,
      deactivatedAt: null,
      deactivatedReason: null,
      invitedBy,
      projectedActive: false,
      projectedAt: null,
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict(`${input.email} is already a member of this organisation`);
    throw error;
  }

  // the record first, the projection second: an interruption leaves access not
  // yet granted rather than granted to something that was never recorded
  const membership = created.toObject();
  await projectMembership(membership, org);
  return viewOf({ ...membership, projectedActive: isEffective(membership, org, new Date()) });
}

export async function patchMember(membershipId: string, patch: PatchMember): Promise<MemberView> {
  const org = await currentOrganization();
  const current = await members.findById(membershipId).lean().exec();
  if (!current) throw notFound('No such member');

  const next: Record<string, unknown> = {};
  if (patch.roleClasses !== undefined) {
    await assertRoleClassesGrantable(patch.roleClasses, org.type);
    await assertOrganizationKeepsAnAdmin(current._id, patch.roleClasses);
    next['roleClasses'] = [...patch.roleClasses];
  }
  if (patch.scopeMode !== undefined && patch.scopeIds !== undefined) {
    next['scopeMode'] = patch.scopeMode;
    next['scopeIds'] = [...patch.scopeIds];
  }
  if (patch.validFrom !== undefined) next['validFrom'] = patch.validFrom;
  if (patch.validUntil !== undefined) next['validUntil'] = patch.validUntil;

  const window = {
    validFrom: (next['validFrom'] as Date | undefined) ?? current.validFrom,
    validUntil: patch.validUntil !== undefined ? patch.validUntil : current.validUntil,
  };
  if (window.validUntil !== null && window.validUntil.getTime() <= window.validFrom.getTime()) {
    throw fail('VALIDATION_FAILED', 'The validity window has to end after it starts', [
      { path: 'validUntil', message: 'must be later than validFrom' },
    ]);
  }

  const updated = await members
    .findOneAndUpdate({ _id: membershipId }, { $set: next })
    .lean()
    .exec();
  if (!updated) throw notFound('No such member');

  await projectMembership(updated, org);
  return viewOf({ ...updated, projectedActive: isEffective(updated, org, new Date()) });
}

/**
 * Deactivation, not deletion. Assessments, approvals and audit trails point at
 * the membership that produced them, and a row that vanishes takes the history
 * of who did what with it.
 */
export async function deactivateMember(membershipId: string, reason: string | null): Promise<MemberView> {
  const current = await members.findOne({ _id: membershipId, isActive: true }).lean().exec();
  if (!current) throw notFound('No such member');
  await assertOrganizationKeepsAnAdmin(current._id, []);

  // access is taken away before the record is changed, so an interruption
  // leaves the person locked out rather than still holding capabilities
  await revokeAccess(current);

  const updated = await members
    .findOneAndUpdate(
      { _id: membershipId, isActive: true },
      { $set: { isActive: false, deactivatedAt: new Date(), deactivatedReason: reason } },
    )
    .lean()
    .exec();
  if (!updated) throw conflict('The membership was changed while this ran');
  return viewOf(updated);
}

/**
 * Refuses the change that would leave an organisation with nobody who can
 * manage its members. Which role classes count is read from the catalogue, so
 * adding a new administrator role does not need this function edited.
 */
async function assertOrganizationKeepsAnAdmin(
  membershipId: string,
  nextRoleClasses: readonly string[],
): Promise<void> {
  const rows = await RoleDefinitionModel.find({ capabilities: MEMBERS_WRITE }).select('_id').lean().exec();
  const adminRoles = rows.map((row) => row._id);
  if (nextRoleClasses.some((code) => adminRoles.includes(code))) return;

  const remaining = await members.countDocuments({
    _id: { $ne: membershipId },
    isActive: true,
    roleClasses: { $in: adminRoles },
  });
  if (remaining === 0) {
    throw conflict('An organisation has to keep at least one member who can manage members');
  }
}

/** Platform path: a membership created for an organisation named in the URL. */
export async function createMembershipForOrg(
  orgId: string,
  draft: {
    userId: string;
    roleClasses: readonly string[];
    scopeMode?: ScopeMode;
    scopeIds?: readonly string[];
    validFrom?: Date;
    invitedBy: string | null;
  },
): Promise<MembershipRow> {
  requireSystemScope('Creating a membership for another organisation');
  const created = await MembershipModel.create({
    orgId,
    userId: draft.userId,
    roleClasses: [...draft.roleClasses],
    scopeMode: draft.scopeMode ?? 'ORG_WIDE',
    scopeIds: [...(draft.scopeIds ?? [])],
    validFrom: draft.validFrom ?? new Date(),
    validUntil: null,
    isActive: true,
    deactivatedAt: null,
    deactivatedReason: null,
    invitedBy: draft.invitedBy,
    projectedActive: false,
    projectedAt: null,
  });
  return created.toObject();
}

/**
 * Rewrites every membership of one organisation against the state it is about
 * to have. Suspension calls it with SUSPENDED before the state is written, so
 * access is gone before the record says so.
 */
export async function reprojectOrganization(
  orgId: string,
  state: OrganizationDoc['state'],
): Promise<number> {
  requireSystemScope('Reprojecting another organisation memberships');
  const rows = await MembershipModel.find({ orgId }).lean().exec();
  for (const row of rows) await projectMembership(row, { state });
  return rows.length;
}

/**
 * The sweep a scheduled worker runs. A validity window opens and closes with
 * the clock, and nothing writes to the record when it does, so the projection
 * has to be revisited rather than trusted to be current.
 */
export async function refreshExpiredMemberships(
  now: Date = new Date(),
): Promise<{ scanned: number; changed: number }> {
  requireSystemScope('Sweeping validity windows across organisations');

  const candidates = await MembershipModel.find({
    isActive: true,
    $or: [
      { projectedActive: true, $or: [{ validUntil: { $ne: null, $lte: now } }, { validFrom: { $gt: now } }] },
      {
        projectedActive: false,
        validFrom: { $lte: now },
        $or: [{ validUntil: null }, { validUntil: { $gt: now } }],
      },
    ],
  })
    .lean()
    .exec();

  const orgs = await OrganizationModel.find({ _id: { $in: candidates.map((row) => row.orgId) } })
    .select('_id state')
    .lean()
    .exec();
  const byId = new Map(orgs.map((org) => [org._id, org]));

  let changed = 0;
  for (const row of candidates) {
    const org = byId.get(row.orgId);
    if (!org) continue;
    if (isEffective(row, org, now) === row.projectedActive) continue;
    await projectMembership(row, org, now);
    changed += 1;
  }
  return { scanned: candidates.length, changed };
}
