// What sampling reads from the features below it (cycles, customers,
// identity, organisations), normalised to the few fields the rules need. It
// is the only file in this module that imports another feature's service, so
// a change in a neighbour's contract is absorbed here.
import mongoose, { type ClientSession, type Types } from 'mongoose';

import type { AnyContext } from '../../core/auth/system.js';
import { AppError } from '../../core/errors.js';
import { idString } from '../../core/ids.js';
import { getCustomer, listEligible, markLastSampled } from '../customers/customers.service.js';
import { getCycle, getParticipant, setParticipantSampling } from '../cycles/cycles.service.js';
import type { CycleStatus, CycleType, SurveyType } from '../cycles/domain/types.js';
import { listActiveUserIdsInOrg, listMembershipsForUsers } from '../identity/memberships.service.js';
import { findUserById } from '../identity/users.service.js';
import { findOrganisationById } from '../organisations/organisations.service.js';

import type { CustomerSurveyType, EligibleEntry } from './domain/eligibility.js';
import type { SampleDoc } from './sampling.model.js';
import type {
  CustomerSummaryDto,
  CycleSummaryDto,
  ParticipantSamplingStatus,
  ParticipantSummaryDto,
} from './sampling.schemas.js';

type IdLike = string | Types.ObjectId;
type DateLike = Date | string | null | undefined;

const iso = (value: DateLike): string | null => (value === null || value === undefined ? null : new Date(value).toISOString());
const idOrNull = (value: IdLike | null | undefined): string | null => (value === null || value === undefined ? null : idString(value));

// --- cycles ------------------------------------------------------------------

/** The fields sampling reads off a cycle, whatever else `getCycle` returns. */
interface CycleLike {
  id: IdLike;
  code: string;
  name: string;
  type: CycleType;
  status: CycleStatus;
  sampling: { start: { utc: Date | string }; end: { utc: Date | string } };
}

/** The fields sampling reads off a `cycle_participants` row. */
interface ParticipantLike {
  cycleId: IdLike;
  acoId: IdLike;
  airportId?: IdLike | null;
  surveyTypes: readonly SurveyType[];
  requiredSampleSize: number;
  sampling: {
    status: ParticipantSamplingStatus;
    selectedCount: number;
    lockedAt?: DateLike;
    lockedBy?: IdLike | null;
    unlockedAt?: DateLike;
    unlockedBy?: IdLike | null;
    unlockReason?: string | null;
  };
}

function toCycleSummary(cycle: CycleLike): CycleSummaryDto {
  return {
    id: idString(cycle.id),
    code: cycle.code,
    name: cycle.name,
    type: cycle.type,
    status: cycle.status,
    samplingStart: iso(cycle.sampling.start.utc),
    samplingEnd: iso(cycle.sampling.end.utc),
  };
}

function toParticipantSummary(participant: ParticipantLike): ParticipantSummaryDto {
  return {
    cycleId: idString(participant.cycleId),
    acoId: idString(participant.acoId),
    airportId: idOrNull(participant.airportId),
    surveyTypes: [...participant.surveyTypes],
    requiredSampleSize: participant.requiredSampleSize,
    sampling: {
      status: participant.sampling.status,
      selectedCount: participant.sampling.selectedCount,
      lockedAt: iso(participant.sampling.lockedAt),
      lockedBy: idOrNull(participant.sampling.lockedBy),
      unlockedAt: iso(participant.sampling.unlockedAt),
      unlockedBy: idOrNull(participant.sampling.unlockedBy),
      unlockReason: participant.sampling.unlockReason ?? null,
    },
  };
}

/** The cycle as the caller may see it; cross-tenant is the cycles module's 404. */
export async function loadCycleSummary(ctx: AnyContext, cycleId: string): Promise<CycleSummaryDto> {
  const cycle: CycleLike = await getCycle(ctx, cycleId);
  return toCycleSummary(cycle);
}

/** Like `loadCycleSummary`, but null instead of NOT_FOUND (participation history). */
export async function findCycleSummary(ctx: AnyContext, cycleId: string): Promise<CycleSummaryDto | null> {
  try {
    return await loadCycleSummary(ctx, cycleId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export async function loadParticipant(cycleId: string, acoId: string): Promise<ParticipantSummaryDto> {
  const participant: ParticipantLike | null = await getParticipant(cycleId, acoId);
  if (!participant) throw new AppError('NOT_FOUND', 'Cycle participant not found');
  return toParticipantSummary(participant);
}

export interface SamplingContext {
  cycle: CycleSummaryDto;
  participant: ParticipantSummaryDto;
}

/** Cycle (visible to the caller) + the operator's participant row, or 404. */
export async function loadSamplingContext(ctx: AnyContext, cycleId: string, acoId: string): Promise<SamplingContext> {
  const cycle = await loadCycleSummary(ctx, cycleId);
  const participant = await loadParticipant(cycle.id, acoId);
  return { cycle, participant };
}

export interface ParticipantSamplingPatch {
  status?: ParticipantSamplingStatus;
  selectedCount?: number;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  unlockedAt?: Date | null;
  unlockedBy?: string | null;
  unlockReason?: string | null;
}

/** Writes through the cycles feature; inside a transaction the session is passed on. */
export async function patchParticipantSampling(
  cycleId: string,
  acoId: string,
  patch: ParticipantSamplingPatch,
  session?: ClientSession,
): Promise<void> {
  await setParticipantSampling(cycleId, acoId, patch, session);
}

// --- customers ---------------------------------------------------------------

/** The fields sampling reads off a customer DTO. */
interface CustomerLike {
  id: string;
  name: string;
  contactPerson: string;
  email: string;
  phone: string;
  type: 'FF' | 'CB';
  surveyType: CustomerSurveyType;
  status: 'ACTIVE' | 'INACTIVE';
}

function toCustomerSummary(customer: CustomerLike): CustomerSummaryDto {
  return {
    id: customer.id,
    name: customer.name,
    contactPerson: customer.contactPerson,
    email: customer.email,
    phone: customer.phone,
    type: customer.type,
    surveyType: customer.surveyType,
    status: customer.status,
  };
}

/** One of the operator's customers (any status), or null when it is not theirs. */
export async function findCustomer(acoId: string, customerId: string): Promise<CustomerSummaryDto | null> {
  try {
    const customer: CustomerLike = await getCustomer(acoId, customerId);
    return toCustomerSummary(customer);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/** The operator's customers among `ids`, keyed by id; unknown ids are simply absent. */
export async function customersByIds(acoId: string, ids: Iterable<string>): Promise<Map<string, CustomerSummaryDto>> {
  const unique = [...new Set(ids)];
  const found = await Promise.all(unique.map((id) => findCustomer(acoId, id)));
  return new Map(found.flatMap((customer) => (customer ? [[customer.id, customer] as const] : [])));
}

/**
 * Every (customer, surveyType) entry the participant may select: the
 * operator's ACTIVE customers matching the cycle type, expanded per survey
 * type (domain `eligibleCustomers`, applied by the customers feature) and
 * narrowed to the participant's own survey types.
 */
export async function eligibleEntries(
  acoId: string,
  cycle: Pick<CycleSummaryDto, 'type'>,
  participant: Pick<ParticipantSummaryDto, 'surveyTypes'>,
): Promise<EligibleEntry<CustomerSummaryDto>[]> {
  const entries: EligibleEntry<CustomerLike>[] = await listEligible(acoId, cycle.type, participant.surveyTypes);
  return entries.map((entry) => ({ customer: toCustomerSummary(entry.customer), surveyType: entry.surveyType, key: entry.key }));
}

/** Stamps `lastSampledCycleId` on the locked customers, inside the lock transaction. */
export async function recordLastSampled(acoId: string, customerIds: readonly string[], cycleId: string, session: ClientSession): Promise<void> {
  await markLastSampled(acoId, customerIds, cycleId, session);
}

// --- assessments (optional) --------------------------------------------------

/**
 * Whether the sampled customer submitted its assessment. `assessments` is a
 * higher feature, so it is read only through a lightweight query, and only
 * once that module has registered its model in this process; before that the
 * answer is null.
 */
export async function hasSubmittedAssessment(
  sample: Pick<SampleDoc, 'cycleId' | 'acoId' | 'customerId' | 'surveyType'>,
): Promise<boolean | null> {
  const registered = Object.values(mongoose.models).some((model) => model.collection.collectionName === 'assessments');
  const db = mongoose.connection.db;
  if (!registered || !db) return null;
  const submitted = await db.collection('assessments').findOne(
    {
      cycleId: sample.cycleId,
      acoId: sample.acoId,
      customerId: sample.customerId,
      surveyType: sample.surveyType,
      kind: 'CUSTOMER',
      status: 'SUBMITTED',
    },
    { projection: { _id: 1 } },
  );
  return submitted !== null;
}

// --- recipients --------------------------------------------------------------

export interface Recipient {
  name: string;
  email: string;
}

/** The operator's active ACO_ADMIN users; the organisation contact when it has none. */
export async function acoAdminRecipients(acoId: string): Promise<Recipient[]> {
  const userIds = await listActiveUserIdsInOrg(acoId);
  const memberships = await listMembershipsForUsers(userIds);
  const adminIds = userIds.filter((userId) =>
    (memberships.get(idString(userId)) ?? []).some((m) => m.orgId === acoId && m.roleCode === 'ACO_ADMIN' && m.status === 'ACTIVE'),
  );
  const users = await Promise.all(adminIds.map((userId) => findUserById(userId)));
  const recipients = users.flatMap((user) => (user && user.status !== 'SUSPENDED' ? [{ name: user.name, email: user.email }] : []));
  if (recipients.length > 0) return recipients;
  const org = await findOrganisationById(acoId);
  return org?.contact ? [{ name: org.contact.name, email: org.contact.email }] : [];
}

export async function operatorName(acoId: string): Promise<string> {
  const org = await findOrganisationById(acoId);
  return org?.name ?? 'your organisation';
}
