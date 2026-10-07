import type { FilterQuery, Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { and } from '../../core/filters.js';
import { idString, toId } from '../../core/ids.js';
import { pageOf, parseSort, searchFilter, skipLimit, type Page } from '../../core/pagination.js';
import { findAirportsByIds, requireAirport } from '../airports/airports.service.js';
import { audit } from '../audit/audit.service.js';
import { countActiveMembersByOrg, ensureMembership } from '../identity/memberships.service.js';
import { requireRoleByCode } from '../identity/roles.service.js';
import { findOrCreateInvitedUser } from '../identity/users.service.js';
import { send } from '../notifications/notifications.service.js';

import { currentSharesForOperators, setCurrentShare } from './market-share.service.js';
import { OrganisationModel, type OrganisationDoc } from './organisations.model.js';
import type { CreateOperatorInput, OperatorDto, OperatorListQuery, PatchOperatorInput } from './organisations.schemas.js';
import { createOrganisation, findOrganisationByCode, toOrganisationView } from './organisations.service.js';

/**
 * Customer counts come from the customers module, which does not exist yet.
 * It registers its counter at boot; until then every operator reports 0.
 */
export type CustomerCounter = (acoIds: string[]) => Promise<Map<string, number>>;

let countCustomers: CustomerCounter = async () => new Map();

export function registerCustomerCounter(counter: CustomerCounter): void {
  countCustomers = counter;
}

/** Operators the caller may see: PLATFORM all; ACO itself; AIRPORT those at its airport. */
export function operatorScopeFilter(ctx: RequestContext): FilterQuery<OrganisationDoc> {
  switch (ctx.scope.kind) {
    case 'PLATFORM':
      return { type: 'ACO' };
    case 'ACO':
      return { type: 'ACO', _id: toId(ctx.scope.acoId) };
    case 'AIRPORT':
      return { type: 'ACO', airportId: toId(ctx.scope.airportId) };
  }
}

async function toOperatorDtos(docs: OrganisationDoc[]): Promise<OperatorDto[]> {
  const ids = docs.map((doc) => idString(doc._id));
  const [airports, members, customers, shares] = await Promise.all([
    findAirportsByIds(docs.flatMap((doc) => (doc.airportId ? [doc.airportId] : []))),
    countActiveMembersByOrg(ids),
    countCustomers(ids),
    currentSharesForOperators(ids),
  ]);
  return docs.map((doc) => {
    const view = toOrganisationView(doc);
    const airport = doc.airportId ? airports.get(idString(doc.airportId)) : undefined;
    return {
      id: view.id,
      code: view.code,
      name: view.name,
      legalName: view.legalName,
      airport: airport ? { id: idString(airport._id), iata: airport.iata, name: airport.name } : null,
      operations: view.operations,
      address: view.address,
      contact: view.contact,
      status: view.status,
      createdVia: view.createdVia,
      memberCount: members.get(view.id) ?? 0,
      customerCount: customers.get(view.id) ?? 0,
      currentShare: shares.get(view.id) ?? null,
      approvedAt: view.approvedAt,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
  });
}

const SORTABLE = ['name', 'code', 'status', 'createdAt'] as const;

export async function listOperators(ctx: RequestContext, query: OperatorListQuery): Promise<Page<OperatorDto>> {
  const requested: FilterQuery<OrganisationDoc> = {};
  if (query.airportId) requested.airportId = toId(query.airportId);
  if (query.status) requested.status = query.status;
  const filter = and<OrganisationDoc>(
    operatorScopeFilter(ctx),
    searchFilter<OrganisationDoc>(query.q, ['code', 'name', 'legalName']),
    requested,
  );
  const sort = parseSort(query.sort, SORTABLE, 'name');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    OrganisationModel.find(filter).sort(sort).skip(skip).limit(limit).lean<OrganisationDoc[]>(),
    OrganisationModel.countDocuments(filter),
  ]);
  return pageOf(await toOperatorDtos(docs), total, query);
}

/** Operators at one airport (any status), for the airport detail view. */
export async function listOperatorsAtAirport(ctx: RequestContext, airportId: string): Promise<OperatorDto[]> {
  const docs = await OrganisationModel.find(and<OrganisationDoc>(operatorScopeFilter(ctx), { airportId: toId(airportId) }))
    .sort({ name: 1 })
    .lean<OrganisationDoc[]>();
  return toOperatorDtos(docs);
}

async function requireVisibleOperator(ctx: RequestContext, id: string): Promise<OrganisationDoc> {
  const doc = await OrganisationModel.findOne(and<OrganisationDoc>(operatorScopeFilter(ctx), { _id: toId(id) })).lean<OrganisationDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Operator not found');
  return doc;
}

export async function getOperator(ctx: RequestContext, id: string): Promise<OperatorDto> {
  const doc = await requireVisibleOperator(ctx, id);
  return (await toOperatorDtos([doc]))[0] as OperatorDto;
}

/**
 * POST /operators: one transaction creates the ACTIVE organisation, the
 * INVITED admin user (or reuses an existing account), the ACO_ADMIN membership
 * and the optional current market share; then the invitation is sent and the
 * creation audited.
 */
export async function createOperator(ctx: RequestContext, input: CreateOperatorInput): Promise<OperatorDto> {
  const airport = await requireAirport(input.airportId);
  if (await findOrganisationByCode(input.code)) throw new AppError('CONFLICT', `Operator code ${input.code} already exists`);
  const adminRole = await requireRoleByCode('ACO_ADMIN').catch(() => {
    throw new AppError('PRECONDITION_FAILED', 'The ACO_ADMIN role is not seeded; run npm run seed');
  });

  const { org, admin } = await withTransaction(async (session) => {
    const created = await createOrganisation(
      {
        type: 'ACO',
        code: input.code,
        name: input.name,
        airportId: input.airportId,
        legalName: input.legalName ?? null,
        address: input.address,
        contact: input.contact,
        operations: input.operations,
        status: 'ACTIVE',
        createdVia: 'ADMIN',
        approvedBy: ctx.user.id,
      },
      session,
    );
    const { user } = await findOrCreateInvitedUser(input.admin, session);
    await ensureMembership({ userId: user._id, orgId: created._id, roleId: adminRole._id }, session);
    if (input.marketSharePct !== undefined) {
      await setCurrentShare(
        { airportId: airport._id, acoId: created._id, sharePct: input.marketSharePct, setBy: toId(ctx.user.id) },
        session,
      );
    }
    return { org: created, admin: user };
  });

  await send({
    template: 'account-invited',
    to: admin.email,
    vars: { name: admin.name, orgName: org.name, roleName: adminRole.name, invitedBy: ctx.user.name },
    refs: { userId: idString(admin._id), acoId: idString(org._id) },
  });
  const dto = await getOperator(ctx, idString(org._id));
  await audit(ctx, {
    action: 'operator.created',
    entity: 'operator',
    entityId: dto.id,
    after: { ...dto, admin: { id: idString(admin._id), email: admin.email } },
    orgId: dto.id,
  });
  return dto;
}

export async function updateOperator(ctx: RequestContext, id: string, patch: PatchOperatorInput): Promise<OperatorDto> {
  const before = await requireVisibleOperator(ctx, id);
  if (patch.airportId !== undefined) await requireAirport(patch.airportId);
  const $set: Partial<OrganisationDoc> = {};
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.legalName !== undefined) $set.legalName = patch.legalName;
  if (patch.airportId !== undefined) $set.airportId = toId(patch.airportId);
  if (patch.operations !== undefined) $set.operations = patch.operations;
  if (patch.address !== undefined) $set.address = patch.address;
  if (patch.contact !== undefined) $set.contact = patch.contact;
  if (Object.keys($set).length > 0) await OrganisationModel.updateOne({ _id: before._id }, { $set });
  const dto = await getOperator(ctx, id);
  await audit(ctx, {
    action: 'operator.updated',
    entity: 'operator',
    entityId: dto.id,
    before: toOrganisationView(before),
    after: dto,
    orgId: dto.id,
  });
  return dto;
}

export async function deactivateOperator(ctx: RequestContext, id: string): Promise<OperatorDto> {
  const before = await requireVisibleOperator(ctx, id);
  if (before.status === 'INACTIVE') throw new AppError('PRECONDITION_FAILED', 'Operator is already inactive');
  await OrganisationModel.updateOne({ _id: before._id }, { $set: { status: 'INACTIVE' } });
  const dto = await getOperator(ctx, id);
  await audit(ctx, {
    action: 'operator.deactivated',
    entity: 'operator',
    entityId: dto.id,
    before: { status: before.status },
    after: { status: dto.status },
    orgId: dto.id,
  });
  return dto;
}

export async function findOperatorIdsAtAirport(airportId: string | Types.ObjectId): Promise<Types.ObjectId[]> {
  const docs = await OrganisationModel.find({ type: 'ACO', airportId: toId(idString(airportId)) }, { _id: 1 }).lean<Pick<OrganisationDoc, '_id'>[]>();
  return docs.map((doc) => doc._id);
}
