import type { FilterQuery } from 'mongoose';

import { assertScope, getTasksForRole } from '../../core/auth/rbac.js';
import type { RequestContext } from '../../core/auth/session.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { and } from '../../core/filters.js';
import { idString, toId } from '../../core/ids.js';
import { pageOf, parseSort, searchFilter, skipLimit, type Page } from '../../core/pagination.js';
import type { AirportDoc } from '../airports/airports.model.js';
import { findAirportById, findAirportsByIds } from '../airports/airports.service.js';
import { audit } from '../audit/audit.service.js';
import { ensureMembership, listActiveUserIdsInOrg, listMembershipsForUsers } from '../identity/memberships.service.js';
import { requireRoleByCode } from '../identity/roles.service.js';
import { findOrCreateInvitedUser, findUserById } from '../identity/users.service.js';
import { send } from '../notifications/notifications.service.js';
import { getMarketShare, setCurrentShare } from '../organisations/market-share.service.js';
import { ACFI_ORG, createOrganisation, findOrganisationByCode } from '../organisations/organisations.service.js';

import { findLinkByToken } from './links.service.js';
import { OnboardingLinkModel, type OnboardingOrgType } from './onboarding-links.model.js';
import type {
  ApproveRegistrationInput,
  RegistrationDetailDto,
  RegistrationDto,
  RegistrationFormInput,
  RegistrationListQuery,
  RegistrationSubmittedDto,
  RejectRegistrationInput,
} from './onboarding.schemas.js';
import { registrationReviewUrl } from './onboarding.urls.js';
import { RegistrationModel, type RegistrationDoc } from './registrations.model.js';

/** Which admin role the approved organisation's first user receives. */
const ADMIN_ROLE_FOR_ORG_TYPE: Record<OnboardingOrgType, string> = { ACO: 'ACO_ADMIN', AIRPORT: 'AIRPORT_ADMIN' };

const ORG_TYPE_LABEL: Record<OnboardingOrgType, string> = { ACO: 'an airport cargo operator', AIRPORT: 'an airport organisation' };

/** What a public (unauthenticated) request leaves in the audit trail. */
export interface PublicRequestMeta {
  ip: string;
  requestId: string;
}

// --- DTOs ------------------------------------------------------------------

async function toRegistrationDtos(docs: RegistrationDoc[]): Promise<RegistrationDto[]> {
  const airports = await findAirportsByIds(docs.map((doc) => doc.airportId));
  return docs.map((doc) => {
    const airport = airports.get(idString(doc.airportId));
    return {
      id: idString(doc._id),
      linkId: doc.linkId ? idString(doc.linkId) : null,
      orgType: doc.orgType,
      airport: airport ? { id: idString(airport._id), iata: airport.iata, name: airport.name } : null,
      organisation: {
        name: doc.organisation.name,
        legalName: doc.organisation.legalName,
        address: { ...doc.organisation.address },
        contact: { ...doc.organisation.contact },
      },
      operations: { domestic: doc.operations.domestic, international: doc.operations.international },
      admin: { ...doc.admin },
      marketSharePct: doc.marketSharePct,
      status: doc.status,
      reviewedBy: doc.reviewedBy ? idString(doc.reviewedBy) : null,
      reviewedAt: doc.reviewedAt?.toISOString() ?? null,
      reviewNote: doc.reviewNote,
      resultOrgId: doc.resultOrgId ? idString(doc.resultOrgId) : null,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  });
}

/** Adds the airport's current share set so the reviewer sees whether approving breaks 100. */
async function withMarketShare(ctx: RequestContext, doc: RegistrationDoc): Promise<RegistrationDetailDto> {
  const dto = (await toRegistrationDtos([doc]))[0] as RegistrationDto;
  if (doc.orgType !== 'ACO') return { ...dto, marketShare: null };
  const current = await getMarketShare(ctx, idString(doc.airportId), null);
  const requested = doc.status === 'SUBMITTED' ? (doc.marketSharePct ?? 0) : 0;
  const projectedTotal = Math.round((current.total + requested) * 100) / 100;
  return { ...dto, marketShare: { entries: current.entries, total: current.total, projectedTotal } };
}

// --- public submission -----------------------------------------------------

function assertShareAllowed(orgType: OnboardingOrgType, marketSharePct: number | undefined): void {
  if (orgType !== 'ACO' && marketSharePct !== undefined) {
    throw new AppError('VALIDATION', 'Market share applies to operator (ACO) registrations only', {
      issues: [{ path: 'marketSharePct', message: 'not allowed for an AIRPORT registration' }],
    });
  }
}

/** ACFI members whose role carries `onboarding.review`: the people who will act on a submission. */
async function reviewerRecipients(): Promise<{ id: string; name: string; email: string }[]> {
  const acfi = await findOrganisationByCode(ACFI_ORG.code);
  if (!acfi) return [];
  const acfiId = idString(acfi._id);
  const memberships = await listMembershipsForUsers(await listActiveUserIdsInOrg(acfi._id));
  const recipients: { id: string; name: string; email: string }[] = [];
  for (const [userId, views] of memberships) {
    const membership = views.find((view) => view.orgId === acfiId && view.status === 'ACTIVE');
    if (!membership) continue;
    if (!(await getTasksForRole(membership.roleId)).has('onboarding.review')) continue;
    const user = await findUserById(userId);
    if (!user || user.status === 'SUSPENDED') continue;
    recipients.push({ id: userId, name: user.name, email: user.email });
  }
  return recipients;
}

async function notifyReviewers(dto: RegistrationDto, airport: AirportDoc): Promise<void> {
  const subject = `New registration request: ${dto.organisation.name} (${airport.iata})`;
  const paragraphs = [
    `${dto.organisation.name} has submitted a registration request as ${ORG_TYPE_LABEL[dto.orgType]} at ${airport.name} (${airport.iata}).`,
    `Administrator: ${dto.admin.name}, ${dto.admin.email}, ${dto.admin.phone}.`,
    `Operations: ${[dto.operations.domestic ? 'domestic' : null, dto.operations.international ? 'international' : null].filter((v) => v !== null).join(' and ') || 'none selected'}.`,
    ...(dto.marketSharePct === null ? [] : [`Requested market share: ${dto.marketSharePct}%.`]),
    'Please review the request and approve or reject it on the CSQ platform.',
  ];
  for (const reviewer of await reviewerRecipients()) {
    await send({
      template: 'generic',
      to: reviewer.email,
      vars: { subject, paragraphs: [`Dear ${reviewer.name},`, ...paragraphs], linkUrl: registrationReviewUrl(dto.id), linkLabel: 'Review registration' },
      refs: { userId: reviewer.id },
    });
  }
}

/**
 * POST /public/onboarding/:token. One transaction stores the form and claims
 * the link (guarded on `usedAt: null`, so two submissions of the same link
 * cannot both succeed); then the applicant and the reviewers are e-mailed
 * and the submission audited without an actor.
 */
export async function submitRegistration(
  token: string,
  input: RegistrationFormInput,
  meta: PublicRequestMeta,
): Promise<RegistrationSubmittedDto> {
  const link = await findLinkByToken(token);
  if (link.usedAt) throw new AppError('CONFLICT', 'This onboarding link has already been used');
  assertShareAllowed(link.orgType, input.marketSharePct);
  const airport = await findAirportById(link.airportId);
  if (!airport) throw new AppError('PRECONDITION_FAILED', 'The airport on this link no longer exists');

  const registration = await withTransaction(async (session) => {
    const [created] = await RegistrationModel.create(
      [
        {
          linkId: link._id,
          orgType: link.orgType,
          airportId: link.airportId,
          organisation: {
            name: input.organisation.name,
            legalName: input.organisation.legalName ?? null,
            address: input.organisation.address,
            contact: input.organisation.contact,
          },
          operations: input.operations,
          admin: input.admin,
          marketSharePct: input.marketSharePct ?? null,
          status: 'SUBMITTED',
        },
      ],
      { session },
    );
    if (!created) throw new Error('Registration insert returned nothing');
    const claimed = await OnboardingLinkModel.updateOne(
      { _id: link._id, usedAt: null },
      { $set: { usedAt: new Date(), registrationId: created._id } },
      { session },
    );
    if (claimed.matchedCount === 0) throw new AppError('CONFLICT', 'This onboarding link has already been used');
    return created.toObject();
  });

  const dto = (await toRegistrationDtos([registration]))[0] as RegistrationDto;
  await send({
    template: 'registration-received',
    to: dto.admin.email,
    vars: { adminName: dto.admin.name, orgName: dto.organisation.name, airportName: airport.name },
  });
  await notifyReviewers(dto, airport);
  await audit(null, {
    action: 'registration.submitted',
    entity: 'registration',
    entityId: dto.id,
    after: { ...dto, submittedFrom: { ip: meta.ip, requestId: meta.requestId } },
  });
  return { registrationId: dto.id };
}

// --- review ----------------------------------------------------------------

const SORTABLE = ['createdAt', 'status', 'orgType'] as const;

/** Registrations are platform records: every reviewer route needs the PLATFORM scope. */
export async function listRegistrations(ctx: RequestContext, query: RegistrationListQuery): Promise<Page<RegistrationDto>> {
  assertScope(ctx, 'PLATFORM');
  const requested: FilterQuery<RegistrationDoc> = {};
  if (query.status) requested.status = query.status;
  if (query.orgType) requested.orgType = query.orgType;
  if (query.airportId) requested.airportId = toId(query.airportId);
  const filter = and<RegistrationDoc>(
    searchFilter<RegistrationDoc>(query.q, ['organisation.name', 'organisation.legalName', 'admin.name', 'admin.email']),
    requested,
  );
  const sort = parseSort(query.sort, SORTABLE, '-createdAt');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    RegistrationModel.find(filter).sort(sort).skip(skip).limit(limit).lean<RegistrationDoc[]>(),
    RegistrationModel.countDocuments(filter),
  ]);
  return pageOf(await toRegistrationDtos(docs), total, query);
}

async function requireRegistration(ctx: RequestContext, id: string): Promise<RegistrationDoc> {
  assertScope(ctx, 'PLATFORM');
  const doc = await RegistrationModel.findById(toId(id)).lean<RegistrationDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Registration not found');
  return doc;
}

export async function getRegistration(ctx: RequestContext, id: string): Promise<RegistrationDetailDto> {
  return withMarketShare(ctx, await requireRegistration(ctx, id));
}

function assertReviewable(doc: RegistrationDoc): void {
  if (doc.status !== 'SUBMITTED') {
    throw new AppError('CONFLICT', `Registration has already been ${doc.status.toLowerCase()}`, { status: doc.status });
  }
}

/**
 * POST /registrations/:id/approve. One transaction creates the ACTIVE
 * organisation (createdVia LINK), the INVITED admin user (or reuses the
 * account), the admin membership and, for an operator, the current market
 * share; the registration flips to APPROVED under a status guard so a
 * concurrent second approval aborts the whole transaction with 409.
 */
export async function approveRegistration(ctx: RequestContext, id: string, input: ApproveRegistrationInput): Promise<RegistrationDetailDto> {
  const registration = await requireRegistration(ctx, id);
  assertReviewable(registration);
  assertShareAllowed(registration.orgType, input.marketSharePct);
  const airport = await findAirportById(registration.airportId);
  if (!airport) throw new AppError('PRECONDITION_FAILED', 'The airport on this registration no longer exists');
  if (await findOrganisationByCode(input.code)) throw new AppError('CONFLICT', `Organisation code ${input.code} already exists`);
  const roleCode = ADMIN_ROLE_FOR_ORG_TYPE[registration.orgType];
  const adminRole = await requireRoleByCode(roleCode).catch(() => {
    throw new AppError('PRECONDITION_FAILED', `The ${roleCode} role is not seeded; run npm run seed`);
  });
  const sharePct = registration.orgType === 'ACO' ? (input.marketSharePct ?? registration.marketSharePct ?? undefined) : undefined;

  const { org, admin } = await withTransaction(async (session) => {
    const created = await createOrganisation(
      {
        type: registration.orgType,
        code: input.code,
        name: registration.organisation.name,
        airportId: idString(registration.airportId),
        legalName: registration.organisation.legalName,
        address: registration.organisation.address,
        contact: registration.organisation.contact,
        operations: registration.operations,
        status: 'ACTIVE',
        createdVia: 'LINK',
        approvedBy: ctx.user.id,
      },
      session,
    );
    const { user } = await findOrCreateInvitedUser(registration.admin, session);
    await ensureMembership({ userId: user._id, orgId: created._id, roleId: adminRole._id }, session);
    if (sharePct !== undefined) {
      await setCurrentShare({ airportId: airport._id, acoId: created._id, sharePct, setBy: toId(ctx.user.id) }, session);
    }
    const approved = await RegistrationModel.updateOne(
      { _id: registration._id, status: 'SUBMITTED' },
      { $set: { status: 'APPROVED', reviewedBy: toId(ctx.user.id), reviewedAt: new Date(), reviewNote: input.note ?? null, resultOrgId: created._id } },
      { session },
    );
    if (approved.matchedCount === 0) throw new AppError('CONFLICT', 'Registration has already been reviewed');
    return { org: created, admin: user };
  });

  await send({
    template: 'registration-approved',
    to: admin.email,
    vars: { adminName: admin.name, orgName: org.name, orgCode: org.code },
    refs: { userId: idString(admin._id), acoId: org.type === 'ACO' ? idString(org._id) : null },
  });
  const dto = await getRegistration(ctx, id);
  await audit(ctx, {
    action: 'registration.approved',
    entity: 'registration',
    entityId: dto.id,
    before: { status: 'SUBMITTED' },
    after: {
      status: 'APPROVED',
      organisation: { id: idString(org._id), code: org.code, name: org.name, type: org.type },
      admin: { id: idString(admin._id), email: admin.email, roleCode },
      marketSharePct: sharePct ?? null,
      note: input.note ?? null,
    },
    orgId: idString(org._id),
  });
  return dto;
}

/** POST /registrations/:id/reject: REJECTED with the reviewer's note; the applicant is told why. */
export async function rejectRegistration(ctx: RequestContext, id: string, input: RejectRegistrationInput): Promise<RegistrationDetailDto> {
  const registration = await requireRegistration(ctx, id);
  assertReviewable(registration);
  const rejected = await RegistrationModel.updateOne(
    { _id: registration._id, status: 'SUBMITTED' },
    { $set: { status: 'REJECTED', reviewedBy: toId(ctx.user.id), reviewedAt: new Date(), reviewNote: input.note } },
  );
  if (rejected.matchedCount === 0) throw new AppError('CONFLICT', 'Registration has already been reviewed');
  await send({
    template: 'registration-rejected',
    to: registration.admin.email,
    vars: { adminName: registration.admin.name, orgName: registration.organisation.name, note: input.note },
  });
  const dto = await getRegistration(ctx, id);
  await audit(ctx, {
    action: 'registration.rejected',
    entity: 'registration',
    entityId: dto.id,
    before: { status: 'SUBMITTED' },
    after: { status: 'REJECTED', note: input.note },
  });
  return dto;
}
