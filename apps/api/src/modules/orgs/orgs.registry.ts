import { conflict, fail, notFound } from '../../kernel/errors.js';
import { requireOrgId, type Principal } from '../../kernel/requestContext.js';
import {
  MembershipModel,
  OrganizationModel,
  RoleDefinitionModel,
  type OrganizationDoc,
  type StateChange,
} from './orgs.models.js';
import { projectMembership, requireSystemScope } from './orgs.access.js';
import { createMembershipForOrg, reprojectOrganization } from './orgs.members.js';
import { findOrCreateUser } from './orgs.users.js';
import { anchoredPrefix, pageOf, toOrganizationView } from './orgs.views.js';
import {
  TRANSITION_TABLE,
  type CreateOrganization,
  type MyMembershipView,
  type OrgListQuery,
  type OrganizationView,
  type PageOf,
  type PatchOrganization,
  type PatchOwnOrganization,
  type RegisterOrganization,
  type TransitionOrganization,
} from './orgs.contracts.js';

/**
 * The organisation registry and its lifecycle.
 *
 * A refusal because an organisation is in the wrong state is a CONFLICT: the
 * request is well formed and would work later or from somewhere else. A refusal
 * because something has to exist first, a primary contact or a seeded role
 * class, is PRECONDITION_FAILED: nothing about the request changes that.
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

async function insertOrganization(
  input: CreateOrganization | RegisterOrganization,
  state: OrganizationDoc['state'],
  samplingApprovalMode: OrganizationDoc['samplingApprovalMode'],
  submittedAt: Date | null,
): Promise<OrganizationDoc> {
  try {
    const created = await OrganizationModel.create({
      type: input.type,
      state,
      legalName: input.legalName,
      legalNameLower: input.legalName.toLowerCase(),
      displayName: input.displayName,
      code: input.code,
      airportId: input.airportId,
      address: { ...input.address },
      registrationIds: { ...input.registrationIds },
      formScope: input.formScope,
      samplingApprovalMode,
      primaryContact: 'primaryContact' in input ? input.primaryContact : null,
      submittedAt,
      approvedAt: null,
      approvedBy: null,
      stateHistory: [],
    });
    return created.toObject();
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict(`${input.code} is already registered`);
    throw error;
  }
}

/**
 * Public self registration. It creates an application and nothing else: no
 * account, no membership and no access, because nobody has been approved yet
 * and an unapproved application that already provisioned people would be a way
 * to fill the user directory from the open internet.
 */
export async function registerOrganization(input: RegisterOrganization): Promise<{
  organizationId: string;
  code: string;
  state: OrganizationDoc['state'];
  submittedAt: string;
}> {
  const submittedAt = new Date();
  const org = await insertOrganization(input, 'PENDING_APPROVAL', 'SUPER_ADMIN', submittedAt);
  return {
    organizationId: org._id,
    code: org.code,
    state: org.state,
    submittedAt: submittedAt.toISOString(),
  };
}

export async function createOrganization(input: CreateOrganization): Promise<OrganizationView> {
  requireSystemScope('Creating an organisation in the registry');
  return toOrganizationView(await insertOrganization(input, 'REGISTERED', input.samplingApprovalMode, null));
}

export async function listOrganizations(query: OrgListQuery): Promise<PageOf<OrganizationView>> {
  requireSystemScope('Listing the organisation registry');

  const filter: Record<string, unknown> = {};
  if (query.type) filter['type'] = query.type;
  if (query.state) filter['state'] = query.state;
  if (query.country) filter['address.country'] = query.country;
  if (query.region) filter['address.region'] = query.region;
  if (query.airportId) filter['airportId'] = query.airportId;
  if (query.samplingApprovalMode) filter['samplingApprovalMode'] = query.samplingApprovalMode;
  if (query.q) {
    filter['$or'] = [
      { code: anchoredPrefix(query.q, 'upper') },
      { legalNameLower: anchoredPrefix(query.q, 'lower') },
    ];
  }

  const sortField = query.sort === 'legalName' ? 'legalNameLower' : query.sort;
  const direction = query.order === 'asc' ? 1 : -1;

  const [rows, total] = await Promise.all([
    OrganizationModel.find(filter)
      .sort({ [sortField]: direction, _id: 1 })
      .skip(query.offset)
      .limit(query.limit)
      .lean()
      .exec(),
    OrganizationModel.countDocuments(filter).exec(),
  ]);

  return pageOf(rows.map(toOrganizationView), total, query);
}

export async function getOrganization(orgId: string): Promise<OrganizationView> {
  requireSystemScope('Reading any organisation from the registry');
  const org = await OrganizationModel.findOne({ _id: orgId }).lean().exec();
  if (!org) throw notFound('No such organisation');
  return toOrganizationView(org);
}

function assignments(patch: PatchOrganization | PatchOwnOrganization): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    next[key] = value;
    if (key === 'legalName' && typeof value === 'string') next['legalNameLower'] = value.toLowerCase();
  }
  return next;
}

export async function patchOrganization(orgId: string, patch: PatchOrganization): Promise<OrganizationView> {
  requireSystemScope('Editing any organisation in the registry');
  const updated = await OrganizationModel.findOneAndUpdate(
    { _id: orgId },
    { $set: assignments(patch) },
    { new: true },
  )
    .lean()
    .exec();
  if (!updated) throw notFound('No such organisation');
  return toOrganizationView(updated);
}

/** The organisation the caller is acting in. The scope decides which one; there is no id to pass. */
export async function readOwnOrganization(): Promise<OrganizationView> {
  const org = await OrganizationModel.findOne({ _id: requireOrgId() }).lean().exec();
  if (!org) throw fail('INTERNAL', 'The request names an organisation that is not in the registry');
  return toOrganizationView(org);
}

export async function patchOwnOrganization(patch: PatchOwnOrganization): Promise<OrganizationView> {
  const updated = await OrganizationModel.findOneAndUpdate(
    { _id: requireOrgId() },
    { $set: assignments(patch) },
    { new: true },
  )
    .lean()
    .exec();
  if (!updated) throw fail('INTERNAL', 'The request names an organisation that is not in the registry');
  return toOrganizationView(updated);
}

async function writeState(
  org: OrganizationDoc,
  change: StateChange,
  extra: Record<string, unknown>,
): Promise<OrganizationDoc> {
  const updated = await OrganizationModel.findOneAndUpdate(
    { _id: org._id, state: org.state },
    { $set: { state: change.to, ...extra }, $push: { stateHistory: change } },
    { new: true },
  )
    .lean()
    .exec();
  // the filter names the state it read, so two operators clicking at once
  // cannot both apply a transition from the same starting point
  if (!updated) throw conflict('The organisation changed state while this ran');
  return updated;
}

/**
 * Approval is where an application becomes a working organisation: the primary
 * contact gets an account, the role class the catalogue marks as granted on
 * approval, and with it the ability to invite everybody else.
 */
async function approve(org: OrganizationDoc, actorId: string | null, at: Date): Promise<string> {
  const contact = org.primaryContact;
  if (!contact) {
    throw fail(
      'PRECONDITION_FAILED',
      'Set a primary contact before approving, because approval has to give somebody the keys',
    );
  }

  const role = await RoleDefinitionModel.findOne({ grantedOnApproval: true, orgTypes: org.type })
    .select('_id')
    .lean()
    .exec();
  if (!role) {
    throw fail('PRECONDITION_FAILED', `No role class is granted on approval for a ${org.type}. Seed one first.`);
  }

  const user = await findOrCreateUser({
    email: contact.email,
    givenName: contact.givenName,
    familyName: contact.familyName,
    kind: 'STAFF',
    phoneE164: contact.phoneE164,
    whatsappOptIn: contact.whatsappOptIn,
  });

  // a second approval of the same organisation must not create a second
  // membership for the same person, and the partial unique index would refuse
  const existing = await MembershipModel.findOne({ orgId: org._id, userId: user._id, isActive: true })
    .lean()
    .exec();
  const membership =
    existing ??
    (await createMembershipForOrg(org._id, {
      userId: user._id,
      roleClasses: [role._id],
      // the window opens at the moment of approval, not a millisecond later,
      // so the projection that follows sees a membership that has started
      validFrom: at,
      invitedBy: actorId,
    }));

  // the state is written before the projection, so the projection sees ACTIVE
  await writeState(
    org,
    { from: org.state, to: 'ACTIVE', action: 'APPROVE', at, by: actorId, reason: null },
    { approvedAt: at, approvedBy: actorId },
  );
  await projectMembership(membership, { state: 'ACTIVE' });
  return user._id;
}

export async function transitionOrganization(
  orgId: string,
  input: TransitionOrganization,
  actorId: string | null,
): Promise<OrganizationView> {
  requireSystemScope('Moving an organisation through its lifecycle');

  const org = await OrganizationModel.findOne({ _id: orgId }).lean().exec();
  if (!org) throw notFound('No such organisation');

  const rule = TRANSITION_TABLE[input.action];
  if (!rule.from.includes(org.state)) {
    throw conflict(`${input.action} is not available from ${org.state}`);
  }

  const at = new Date();
  const change: StateChange = {
    from: org.state,
    to: rule.to,
    action: input.action,
    at,
    by: actorId,
    reason: input.reason ?? null,
  };

  switch (input.action) {
    case 'APPROVE': {
      await approve(org, actorId, at);
      break;
    }
    case 'SUSPEND': {
      // access is withdrawn before the record says the organisation is
      // suspended, so an interruption leaves nobody holding capabilities
      await reprojectOrganization(org._id, 'SUSPENDED');
      await writeState(org, change, {});
      break;
    }
    case 'REINSTATE': {
      await writeState(org, change, {});
      await reprojectOrganization(org._id, 'ACTIVE');
      break;
    }
    case 'SUBMIT': {
      await writeState(org, change, { submittedAt: at });
      break;
    }
    case 'REJECT': {
      await writeState(org, change, { submittedAt: null });
      break;
    }
  }

  return getOrganization(orgId);
}

/**
 * The organisation switcher. Everything it reports comes from the caller's own
 * principal, so there is no id here that the caller did not already hold.
 */
export async function myMemberships(principal: Principal): Promise<MyMembershipView[]> {
  const orgIds = principal.memberships.map((m) => m.orgId);
  if (orgIds.length === 0) return [];

  const orgs = await OrganizationModel.find({ _id: { $in: orgIds } })
    .select('_id code legalName type state')
    .lean()
    .exec();
  const byId = new Map(orgs.map((org) => [org._id, org]));

  const views: MyMembershipView[] = [];
  for (const membership of principal.memberships) {
    const org = byId.get(membership.orgId);
    if (!org) continue;
    views.push({
      orgId: org._id,
      code: org.code,
      legalName: org.legalName,
      type: org.type,
      state: org.state,
      roles: [...membership.roles],
      capabilities: [...membership.capabilities],
      active: membership.active,
    });
  }
  return views.sort((a, b) => a.legalName.localeCompare(b.legalName));
}
