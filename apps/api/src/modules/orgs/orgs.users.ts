import { conflict, notFound } from '../../kernel/errors.js';
import {
  MembershipModel,
  OrgUserModel,
  OrganizationModel,
  UNLINKED_SUBJECT_PREFIX,
  isLinked,
  unlinkedSubject,
  type OrgUserDoc,
} from './orgs.models.js';
import {
  ensureAuthAccount,
  linkAuthSubject,
  projectMembership,
  requireSystemScope,
  setAuthAccountStatus,
} from './orgs.access.js';
import { anchoredPrefix, pageOf, toUserView } from './orgs.views.js';
import type { CreateUser, PageOf, PatchUser, UserListQuery, UserView } from './orgs.contracts.js';

/**
 * People. One row per person for the whole platform, keyed by the folded email
 * address, because the same assessor works for two firms and the same manager
 * moves between terminals. Their authority is never here; it is in the
 * memberships that point at this row.
 */

const DUPLICATE_KEY = 11000;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY
  );
}

function fullName(givenName: string, familyName: string): string {
  return `${givenName} ${familyName}`.trim();
}

export interface UserSeed {
  readonly email: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly kind: CreateUser['kind'];
  readonly phoneE164: string | null;
  readonly whatsappOptIn: boolean;
  readonly kcUserId?: string;
}

async function insertUser(input: UserSeed): Promise<OrgUserDoc> {
  const displayName = fullName(input.givenName, input.familyName);
  const created = await OrgUserModel.create({
    kind: input.kind,
    email: input.email,
    emailLower: input.email.toLowerCase(),
    subject: input.kcUserId ?? unlinkedSubject(),
    givenName: input.givenName,
    familyName: input.familyName,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    phoneE164: input.phoneE164,
    whatsappOptIn: input.whatsappOptIn,
    status: 'ACTIVE',
    membershipsVersion: 0,
    lastProjectedAt: null,
  });
  const doc = created.toObject();
  await ensureAuthAccount(doc);
  return doc;
}

export async function findUserByEmail(email: string): Promise<OrgUserDoc | null> {
  return OrgUserModel.findOne({ emailLower: email.toLowerCase() }).lean().exec();
}

/**
 * The invitation path. An address already on file is the same person, not a
 * second account, so the membership is added to the row that exists. The one
 * thing that cannot be reconciled is a different kind: staff and assessors are
 * told apart everywhere downstream, so that asks a human to decide.
 */
export async function findOrCreateUser(input: UserSeed): Promise<OrgUserDoc> {
  const existing = await findUserByEmail(input.email);
  if (existing) {
    if (existing.kind !== input.kind) {
      throw conflict(`${input.email} is already on file as ${existing.kind} and cannot also be ${input.kind}`);
    }
    return existing;
  }

  try {
    return await insertUser(input);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // two invitations for the same address raced; the unique index decided
    const raced = await findUserByEmail(input.email);
    if (!raced) throw error;
    return raced;
  }
}

export async function createUser(input: CreateUser): Promise<UserView> {
  requireSystemScope('Creating a person outside an organisation');
  const existing = await findUserByEmail(input.email);
  if (existing) throw conflict(`${input.email} already has an account`);

  try {
    return toUserView(await insertUser(input));
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict('That email address or Keycloak identity is already in use');
    throw error;
  }
}

export async function getUser(userId: string): Promise<{
  user: UserView;
  memberships: Array<{
    membershipId: string;
    orgId: string;
    code: string;
    legalName: string;
    roleClasses: string[];
    isActive: boolean;
    effective: boolean;
  }>;
}> {
  requireSystemScope('Reading a person across organisations');
  const user = await OrgUserModel.findOne({ _id: userId }).lean().exec();
  if (!user) throw notFound('No such person');

  const memberships = await MembershipModel.find({ userId }).lean().exec();
  const orgs = await OrganizationModel.find({ _id: { $in: memberships.map((m) => m.orgId) } })
    .select('_id code legalName')
    .lean()
    .exec();
  const byId = new Map(orgs.map((o) => [o._id, o]));

  return {
    user: toUserView(user),
    memberships: memberships.map((m) => ({
      membershipId: m._id,
      orgId: m.orgId,
      code: byId.get(m.orgId)?.code ?? '',
      legalName: byId.get(m.orgId)?.legalName ?? '',
      roleClasses: [...m.roleClasses],
      isActive: m.isActive,
      effective: m.projectedActive,
    })),
  };
}

export async function listUsers(query: UserListQuery): Promise<PageOf<UserView>> {
  requireSystemScope('Listing people across organisations');

  const filter: Record<string, unknown> = {};
  if (query.kind) filter['kind'] = query.kind;
  if (query.status) filter['status'] = query.status;
  if (query.linked !== undefined) {
    const pending = anchoredPrefix(UNLINKED_SUBJECT_PREFIX, 'lower');
    filter['subject'] = query.linked ? { $not: pending } : pending;
  }
  if (query.q) {
    const term = anchoredPrefix(query.q, 'lower');
    filter['$or'] = [{ emailLower: term }, { displayNameLower: term }];
  }

  const sortField = query.sort === 'displayName' ? 'displayNameLower' : query.sort === 'email' ? 'emailLower' : 'createdAt';
  const direction = query.order === 'asc' ? 1 : -1;

  const [rows, total] = await Promise.all([
    OrgUserModel.find(filter)
      .sort({ [sortField]: direction })
      .skip(query.offset)
      .limit(query.limit)
      .lean()
      .exec(),
    OrgUserModel.countDocuments(filter).exec(),
  ]);

  return pageOf(rows.map(toUserView), total, query);
}

export async function patchUser(userId: string, patch: PatchUser): Promise<UserView> {
  requireSystemScope('Editing a person outside an organisation');
  const current = await OrgUserModel.findOne({ _id: userId }).lean().exec();
  if (!current) throw notFound('No such person');

  const assignments: Record<string, unknown> = {};
  if (patch.givenName !== undefined) assignments['givenName'] = patch.givenName;
  if (patch.familyName !== undefined) assignments['familyName'] = patch.familyName;
  if (patch.phoneE164 !== undefined) assignments['phoneE164'] = patch.phoneE164;
  if (patch.whatsappOptIn !== undefined) assignments['whatsappOptIn'] = patch.whatsappOptIn;
  if (patch.status !== undefined) assignments['status'] = patch.status;

  if (patch.givenName !== undefined || patch.familyName !== undefined) {
    const displayName = fullName(patch.givenName ?? current.givenName, patch.familyName ?? current.familyName);
    assignments['displayName'] = displayName;
    assignments['displayNameLower'] = displayName.toLowerCase();
  }

  // suspension reaches the kernel's row first, because that row is what decides
  // whether a token is accepted at all. An interrupted suspension has still
  // locked the account out
  if (patch.status === 'SUSPENDED') await setAuthAccountStatus(userId, 'SUSPENDED');

  const updated = await OrgUserModel.findOneAndUpdate({ _id: userId }, { $set: assignments }, { new: true })
    .lean()
    .exec();
  if (!updated) throw notFound('No such person');

  // the kernel's row carries a copy of the name, the address and the status, so
  // it is rewritten from the record after every edit rather than only when the
  // status moved. The upsert is idempotent
  await ensureAuthAccount(updated);
  return toUserView(updated);
}

/**
 * Attaches the Keycloak account. Until this runs the person exists and can be
 * given memberships but cannot sign in, which is exactly what an invitation is.
 * Relinking is refused: pointing an existing account at a different subject
 * hands one person's history to another.
 */
export async function linkIdentity(userId: string, kcUserId: string): Promise<UserView> {
  requireSystemScope('Linking an identity');
  const current = await OrgUserModel.findOne({ _id: userId }).lean().exec();
  if (!current) throw notFound('No such person');
  if (isLinked(current.subject)) {
    if (current.subject === kcUserId) return toUserView(current);
    throw conflict('This account is already linked to a different identity');
  }

  try {
    const updated = await OrgUserModel.findOneAndUpdate(
      { _id: userId, subject: current.subject },
      { $set: { subject: kcUserId } },
      { new: true },
    )
      .lean()
      .exec();
    if (!updated) throw conflict('The account was linked by someone else while this ran');
    await linkAuthSubject(userId, kcUserId);
    return toUserView(updated);
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict('That identity is already linked to another account');
    throw error;
  }
}

/** Repair tool: recomputes every slice of one person's access from the record. */
export async function refreshUserAccess(userId: string): Promise<{ userId: string; refreshed: number }> {
  requireSystemScope('Refreshing access across organisations');
  const user = await OrgUserModel.findOne({ _id: userId }).lean().exec();
  if (!user) throw notFound('No such person');

  await ensureAuthAccount(user);
  const memberships = await MembershipModel.find({ userId }).lean().exec();
  const orgs = await OrganizationModel.find({ _id: { $in: memberships.map((m) => m.orgId) } })
    .select('_id state')
    .lean()
    .exec();
  const byId = new Map(orgs.map((o) => [o._id, o]));

  let refreshed = 0;
  for (const membership of memberships) {
    const org = byId.get(membership.orgId);
    if (!org) continue;
    await projectMembership(membership, org);
    refreshed += 1;
  }
  return { userId, refreshed };
}
