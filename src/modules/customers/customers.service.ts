import type { ClientSession, FilterQuery, Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';
import { and } from '../../core/filters.js';
import { idString, toId } from '../../core/ids.js';
import { escapeRegex, pageOf, parseSort, searchFilter, skipLimit, type Page } from '../../core/pagination.js';
import { audit } from '../audit/audit.service.js';
import type { CycleType, SurveyType } from '../cycles/domain/types.js';
import { eligibleCustomers, type EligibleEntry } from '../sampling/domain/eligibility.js';

import { CustomerModel, type CustomerDoc } from './customers.model.js';
import type { CreateCustomerInput, CustomerDto, CustomerListQuery, PatchCustomerInput } from './customers.schemas.js';
import { customerScopeFilter, requireAcoTarget } from './customers.scope.js';

export function toCustomerDto(doc: CustomerDoc): CustomerDto {
  return {
    id: idString(doc._id),
    acoId: idString(doc.acoId),
    airportId: idString(doc.airportId),
    name: doc.name,
    contactPerson: doc.contactPerson,
    email: doc.email,
    phone: doc.phone,
    type: doc.type,
    surveyType: doc.surveyType,
    status: doc.status,
    tags: [...doc.tags],
    lastSampledCycleId: doc.lastSampledCycleId ? idString(doc.lastSampledCycleId) : null,
    importBatchId: doc.importBatchId ? idString(doc.importBatchId) : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

const SORTABLE = ['name', 'contactPerson', 'email', 'type', 'surveyType', 'status', 'createdAt', 'updatedAt'] as const;

export async function listCustomers(ctx: RequestContext, query: CustomerListQuery): Promise<Page<CustomerDto>> {
  const requested: FilterQuery<CustomerDoc> = {};
  if (query.type) requested.type = query.type;
  if (query.surveyType) requested.surveyType = query.surveyType;
  if (query.status) requested.status = query.status;
  if (query.tag) requested.tags = new RegExp(`^${escapeRegex(query.tag)}$`, 'i');
  const filter = and<CustomerDoc>(
    customerScopeFilter(ctx, query.acoId),
    searchFilter<CustomerDoc>(query.q, ['name', 'email', 'contactPerson']),
    requested,
  );
  const sort = parseSort(query.sort, SORTABLE, 'name');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    CustomerModel.find(filter).sort(sort).skip(skip).limit(limit).lean<CustomerDoc[]>(),
    CustomerModel.countDocuments(filter),
  ]);
  return pageOf(docs.map(toCustomerDto), total, query);
}

async function requireVisibleCustomer(ctx: RequestContext, id: string): Promise<CustomerDoc> {
  const doc = await CustomerModel.findOne(and<CustomerDoc>(customerScopeFilter(ctx), { _id: toId(id) })).lean<CustomerDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Customer not found');
  return doc;
}

export async function getCustomerInScope(ctx: RequestContext, id: string): Promise<CustomerDto> {
  return toCustomerDto(await requireVisibleCustomer(ctx, id));
}

/** One e-mail per customer per operator; the conflict names the customer that holds it. */
async function assertEmailFree(acoId: Types.ObjectId, email: string, except?: Types.ObjectId): Promise<void> {
  const holder = await CustomerModel.findOne(
    and<CustomerDoc>({ acoId, email }, except ? { _id: { $ne: except } } : {}),
    { _id: 1, name: 1 },
  ).lean<Pick<CustomerDoc, '_id' | 'name'>>();
  if (holder) {
    throw new AppError('CONFLICT', `E-mail ${email} already belongs to customer "${holder.name}"`, {
      customerId: idString(holder._id),
      email,
    });
  }
}

export async function createCustomer(ctx: RequestContext, input: CreateCustomerInput): Promise<CustomerDto> {
  const target = await requireAcoTarget(ctx, input.acoId);
  await assertEmailFree(target.acoId, input.email);
  const contactPerson = input.contactPerson === undefined || input.contactPerson === '' ? input.name : input.contactPerson;
  const created = (
    await CustomerModel.create({
      acoId: target.acoId,
      airportId: target.airportId,
      name: input.name,
      contactPerson,
      email: input.email,
      phone: input.phone,
      type: input.type,
      surveyType: input.surveyType,
      status: 'ACTIVE',
      tags: input.tags ?? [],
      lastSampledCycleId: null,
      importBatchId: null,
    })
  ).toObject();
  const dto = toCustomerDto(created);
  await audit(ctx, { action: 'customer.created', entity: 'customer', entityId: dto.id, after: dto, orgId: dto.acoId });
  return dto;
}

export async function updateCustomer(ctx: RequestContext, id: string, patch: PatchCustomerInput): Promise<CustomerDto> {
  const before = await requireVisibleCustomer(ctx, id);
  if (patch.email !== undefined && patch.email !== before.email) await assertEmailFree(before.acoId, patch.email, before._id);
  const $set: Partial<CustomerDoc> = {};
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.contactPerson !== undefined) $set.contactPerson = patch.contactPerson === '' ? (patch.name ?? before.name) : patch.contactPerson;
  if (patch.email !== undefined) $set.email = patch.email;
  if (patch.phone !== undefined) $set.phone = patch.phone;
  if (patch.type !== undefined) $set.type = patch.type;
  if (patch.surveyType !== undefined) $set.surveyType = patch.surveyType;
  if (patch.tags !== undefined) $set.tags = patch.tags;
  if (Object.keys($set).length > 0) await CustomerModel.updateOne({ _id: before._id }, { $set });
  const dto = await getCustomerInScope(ctx, id);
  await audit(ctx, {
    action: 'customer.updated',
    entity: 'customer',
    entityId: dto.id,
    before: toCustomerDto(before),
    after: dto,
    orgId: dto.acoId,
  });
  return dto;
}

export async function deactivateCustomer(ctx: RequestContext, id: string): Promise<CustomerDto> {
  const before = await requireVisibleCustomer(ctx, id);
  if (before.status === 'INACTIVE') throw new AppError('PRECONDITION_FAILED', 'Customer is already inactive');
  await CustomerModel.updateOne({ _id: before._id }, { $set: { status: 'INACTIVE' } });
  const dto = await getCustomerInScope(ctx, id);
  await audit(ctx, {
    action: 'customer.deactivated',
    entity: 'customer',
    entityId: dto.id,
    before: { status: before.status },
    after: { status: dto.status },
    orgId: dto.acoId,
  });
  return dto;
}

/** Reactivation is audited as `customer.updated` (ARCHITECTURE §7 lists no separate action). */
export async function reactivateCustomer(ctx: RequestContext, id: string): Promise<CustomerDto> {
  const before = await requireVisibleCustomer(ctx, id);
  if (before.status === 'ACTIVE') throw new AppError('PRECONDITION_FAILED', 'Customer is already active');
  await CustomerModel.updateOne({ _id: before._id }, { $set: { status: 'ACTIVE' } });
  const dto = await getCustomerInScope(ctx, id);
  await audit(ctx, {
    action: 'customer.updated',
    entity: 'customer',
    entityId: dto.id,
    before: { status: before.status },
    after: { status: dto.status },
    orgId: dto.acoId,
  });
  return dto;
}

// --- exported to higher modules (WAVE1-BRIEF §2) -----------------------------

/** A customer of the operator, whatever its status; another operator's id is NOT_FOUND. */
export async function getCustomer(acoId: string, id: string): Promise<CustomerDto> {
  const doc = await CustomerModel.findOne({ _id: toId(id), acoId: toId(acoId, 'acoId') }).lean<CustomerDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Customer not found');
  return toCustomerDto(doc);
}

/**
 * Every (customer, surveyType) entry the operator may sample in a cycle of
 * `cycleType` (sampling domain `eligibleCustomers`): ACTIVE customers only,
 * BOTH expands to two entries in a BOTH cycle, ordered by customer name.
 * `participantSurveyTypes` narrows to what the participant actually runs.
 */
export async function listEligible(
  acoId: string,
  cycleType: CycleType,
  participantSurveyTypes?: readonly SurveyType[],
): Promise<EligibleEntry<CustomerDto>[]> {
  const docs = await CustomerModel.find({ acoId: toId(acoId, 'acoId'), status: 'ACTIVE' })
    .sort({ name: 1, _id: 1 })
    .lean<CustomerDoc[]>();
  return eligibleCustomers(docs.map(toCustomerDto), cycleType, participantSurveyTypes);
}

/** ACTIVE customers of one operator (what the operator card shows). */
export async function countByAco(acoId: string): Promise<number> {
  return CustomerModel.countDocuments({ acoId: toId(acoId, 'acoId'), status: 'ACTIVE' });
}

/** ACTIVE customers per operator; the organisations module's customer counter. */
export async function countByAcos(acoIds: string[]): Promise<Map<string, number>> {
  if (acoIds.length === 0) return new Map();
  const rows = await CustomerModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { acoId: { $in: acoIds.map((id) => toId(id, 'acoId')) }, status: 'ACTIVE' } },
    { $group: { _id: '$acoId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [idString(row._id), row.count]));
}

/** Every e-mail in the operator's directory, any status — what a re-import matches against. */
export async function emailsByAco(acoId: string): Promise<string[]> {
  return CustomerModel.distinct('email', { acoId: toId(acoId, 'acoId') });
}

/** Records the cycle a set of customers was last sampled in (sampling calls this on lock). */
export async function markLastSampled(
  acoId: string,
  customerIds: readonly string[],
  cycleId: string,
  session?: ClientSession,
): Promise<number> {
  if (customerIds.length === 0) return 0;
  const result = await CustomerModel.updateMany(
    { acoId: toId(acoId, 'acoId'), _id: { $in: customerIds.map((id) => toId(id)) } },
    { $set: { lastSampledCycleId: toId(cycleId, 'cycleId') } },
    session ? { session } : {},
  );
  return result.modifiedCount;
}
