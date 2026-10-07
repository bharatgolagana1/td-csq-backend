// cycle_participants: created at publish, then written by sampling (lock /
// unlock through `setParticipantSampling`), invitations and assessments
// (`bumpParticipantStats`, events) and read by reports. Every exported
// function here is part of the cross-module contract (WAVE1-BRIEF §2).
import type { ClientSession, FilterQuery, Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { isSystemContext, type AnyContext } from '../../core/auth/system.js';
import { AppError } from '../../core/errors.js';
import { and } from '../../core/filters.js';
import { idString, toId } from '../../core/ids.js';
import { pageOf, parseSort, skipLimit, type Page } from '../../core/pagination.js';
import { findAirportsByIds } from '../airports/airports.service.js';
import { listOperators } from '../organisations/operators.service.js';
import type { OrganisationDoc } from '../organisations/organisations.model.js';
import { findOrganisationsByIds } from '../organisations/organisations.service.js';

import {
  CycleParticipantModel,
  type CycleParticipantDoc,
  type ParticipantStatField,
  type SamplingStatus,
  type SelfAssessmentStatus,
} from './cycle-participants.model.js';
import type { ParticipantDto, ParticipantListQuery } from './cycles.schemas.js';
import { participantSurveyTypes, requiredSampleSize } from './domain/participants.js';
import type { CycleType, SurveyType } from './domain/types.js';

// --- DTOs ------------------------------------------------------------------

export async function toParticipantDtos(docs: CycleParticipantDoc[]): Promise<ParticipantDto[]> {
  const [orgs, airports] = await Promise.all([
    findOrganisationsByIds(docs.map((doc) => doc.acoId)),
    findAirportsByIds(docs.map((doc) => doc.airportId)),
  ]);
  return docs.map((doc) => {
    const org = orgs.get(idString(doc.acoId));
    const airport = airports.get(idString(doc.airportId));
    return {
      id: idString(doc._id),
      cycleId: idString(doc.cycleId),
      acoId: idString(doc.acoId),
      airportId: idString(doc.airportId),
      operator: { id: idString(doc.acoId), code: org?.code ?? '?', name: org?.name ?? 'Unknown operator' },
      airport: { id: idString(doc.airportId), iata: airport?.iata ?? '?', name: airport?.name ?? 'Unknown airport' },
      surveyTypes: [...doc.surveyTypes],
      requiredSampleSize: doc.requiredSampleSize,
      sampling: {
        status: doc.sampling.status,
        selectedCount: doc.sampling.selectedCount,
        lockedAt: doc.sampling.lockedAt?.toISOString() ?? null,
        lockedBy: doc.sampling.lockedBy ? idString(doc.sampling.lockedBy) : null,
        unlockedAt: doc.sampling.unlockedAt?.toISOString() ?? null,
        unlockedBy: doc.sampling.unlockedBy ? idString(doc.sampling.unlockedBy) : null,
        unlockReason: doc.sampling.unlockReason,
      },
      stats: { invited: doc.stats.invited, started: doc.stats.started, completed: doc.stats.completed },
      selfAssessment: { DOMESTIC: doc.selfAssessment.DOMESTIC, INTERNATIONAL: doc.selfAssessment.INTERNATIONAL },
      reminders: { sent: doc.reminders.sent, lastAt: doc.reminders.lastAt?.toISOString() ?? null },
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  });
}

// --- scope -----------------------------------------------------------------

/** Participants the caller may see: PLATFORM / system all; ACO itself; AIRPORT those at its airport. */
export function participantScopeFilter(ctx: AnyContext): FilterQuery<CycleParticipantDoc> {
  if (isSystemContext(ctx)) return {};
  switch (ctx.scope.kind) {
    case 'PLATFORM':
      return {};
    case 'ACO':
      return { acoId: toId(ctx.scope.acoId) };
    case 'AIRPORT':
      return { airportId: toId(ctx.scope.airportId) };
  }
}

// --- reads (contract) ------------------------------------------------------

export async function findParticipantDoc(
  cycleId: string | Types.ObjectId,
  acoId: string | Types.ObjectId,
  session?: ClientSession,
): Promise<CycleParticipantDoc | null> {
  return CycleParticipantModel.findOne({ cycleId: toId(idString(cycleId), 'cycleId'), acoId: toId(idString(acoId), 'acoId') })
    .session(session ?? null)
    .lean<CycleParticipantDoc>();
}

export async function getParticipant(cycleId: string, acoId: string): Promise<ParticipantDto | null> {
  const doc = await findParticipantDoc(cycleId, acoId);
  return doc ? ((await toParticipantDtos([doc]))[0] ?? null) : null;
}

async function requireParticipantDoc(cycleId: string, acoId: string, session?: ClientSession): Promise<CycleParticipantDoc> {
  const doc = await findParticipantDoc(cycleId, acoId, session);
  if (!doc) throw new AppError('NOT_FOUND', 'Participant not found', { cycleId, acoId });
  return doc;
}

export async function listParticipantDocs(cycleId: string | Types.ObjectId, filter: FilterQuery<CycleParticipantDoc> = {}): Promise<CycleParticipantDoc[]> {
  return CycleParticipantModel.find(and<CycleParticipantDoc>({ cycleId: toId(idString(cycleId), 'cycleId') }, filter))
    .sort({ createdAt: 1 })
    .lean<CycleParticipantDoc[]>();
}

/** Every participant of a cycle, unscoped (for jobs, scoring and reports). */
export async function listParticipants(cycleId: string): Promise<ParticipantDto[]> {
  return toParticipantDtos(await listParticipantDocs(cycleId));
}

export async function listParticipantDocsForOperator(acoId: string | Types.ObjectId): Promise<CycleParticipantDoc[]> {
  return CycleParticipantModel.find({ acoId: toId(idString(acoId), 'acoId') }).lean<CycleParticipantDoc[]>();
}

const SORTABLE = ['createdAt', 'sampling.status', 'sampling.selectedCount', 'stats.invited', 'stats.completed'] as const;

/** `GET /cycles/:id/participants`: scoped page; `q` matches operator code / name. */
export async function listParticipantsPage(ctx: RequestContext, cycleId: string, query: ParticipantListQuery): Promise<Page<ParticipantDto>> {
  const requested: FilterQuery<CycleParticipantDoc> = {};
  if (query.airportId) requested.airportId = toId(query.airportId);
  if (query.samplingStatus) requested['sampling.status'] = query.samplingStatus;
  if (query.q) {
    const matches = await listOperators(ctx, { page: 1, pageSize: 200, q: query.q });
    requested.acoId = { $in: matches.data.map((op) => toId(op.id)) };
  }
  const filter = and<CycleParticipantDoc>({ cycleId: toId(cycleId) }, participantScopeFilter(ctx), requested);
  const sort = parseSort(query.sort, SORTABLE, 'createdAt');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    CycleParticipantModel.find(filter).sort(sort).skip(skip).limit(limit).lean<CycleParticipantDoc[]>(),
    CycleParticipantModel.countDocuments(filter),
  ]);
  return pageOf(await toParticipantDtos(docs), total, query);
}

// --- aggregates ------------------------------------------------------------

export interface CycleProgress {
  operators: number;
  locked: number;
  invited: number;
  completed: number;
}

/** Per cycle: participants in scope, how many locked, and invitation / completion totals. */
export async function progressByCycle(
  cycleIds: Types.ObjectId[],
  scope: FilterQuery<CycleParticipantDoc>,
): Promise<Map<string, CycleProgress>> {
  if (cycleIds.length === 0) return new Map();
  const rows = await CycleParticipantModel.aggregate<{ _id: Types.ObjectId } & CycleProgress>([
    { $match: and<CycleParticipantDoc>({ cycleId: { $in: cycleIds } }, scope) },
    {
      $group: {
        _id: '$cycleId',
        operators: { $sum: 1 },
        locked: { $sum: { $cond: [{ $eq: ['$sampling.status', 'LOCKED'] }, 1, 0] } },
        invited: { $sum: '$stats.invited' },
        completed: { $sum: '$stats.completed' },
      },
    },
  ]);
  return new Map(rows.map((row) => [idString(row._id), { operators: row.operators, locked: row.locked, invited: row.invited, completed: row.completed }]));
}

// --- writes (contract) -----------------------------------------------------

export interface SamplingPatch {
  status?: SamplingStatus;
  selectedCount?: number;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  unlockedAt?: Date | null;
  unlockedBy?: string | null;
  unlockReason?: string | null;
}

/** The sampling module's write path (lock / unlock / selection count); pass `session` inside its transaction. */
export async function setParticipantSampling(
  cycleId: string,
  acoId: string,
  patch: SamplingPatch,
  session?: ClientSession,
): Promise<ParticipantDto> {
  const before = await requireParticipantDoc(cycleId, acoId, session);
  const $set: Record<string, unknown> = {};
  if (patch.status !== undefined) $set['sampling.status'] = patch.status;
  if (patch.selectedCount !== undefined) {
    if (!Number.isInteger(patch.selectedCount) || patch.selectedCount < 0) {
      throw new AppError('VALIDATION', 'selectedCount must be a whole number ≥ 0', { selectedCount: patch.selectedCount });
    }
    $set['sampling.selectedCount'] = patch.selectedCount;
  }
  if (patch.lockedAt !== undefined) $set['sampling.lockedAt'] = patch.lockedAt;
  if (patch.lockedBy !== undefined) $set['sampling.lockedBy'] = patch.lockedBy ? toId(patch.lockedBy, 'lockedBy') : null;
  if (patch.unlockedAt !== undefined) $set['sampling.unlockedAt'] = patch.unlockedAt;
  if (patch.unlockedBy !== undefined) $set['sampling.unlockedBy'] = patch.unlockedBy ? toId(patch.unlockedBy, 'unlockedBy') : null;
  if (patch.unlockReason !== undefined) $set['sampling.unlockReason'] = patch.unlockReason;
  const after =
    Object.keys($set).length === 0
      ? before
      : await CycleParticipantModel.findOneAndUpdate({ _id: before._id }, { $set }, { new: true, ...(session ? { session } : {}) }).lean<CycleParticipantDoc>();
  if (!after) throw new AppError('NOT_FOUND', 'Participant not found', { cycleId, acoId });
  return (await toParticipantDtos([after]))[0] as ParticipantDto;
}

/** Adds `delta` (may be negative) to `stats.<field>`; the counter never drops below zero. */
export async function bumpParticipantStats(
  cycleId: string,
  acoId: string,
  field: ParticipantStatField,
  delta: number,
  session?: ClientSession,
): Promise<ParticipantDto> {
  if (!Number.isInteger(delta)) throw new AppError('VALIDATION', 'delta must be an integer', { delta });
  const before = await requireParticipantDoc(cycleId, acoId, session);
  const next = Math.max(0, before.stats[field] + delta);
  const after = await CycleParticipantModel.findOneAndUpdate(
    { _id: before._id },
    { $set: { [`stats.${field}`]: next } },
    { new: true, ...(session ? { session } : {}) },
  ).lean<CycleParticipantDoc>();
  if (!after) throw new AppError('NOT_FOUND', 'Participant not found', { cycleId, acoId });
  return (await toParticipantDtos([after]))[0] as ParticipantDto;
}

/** Self-assessment progress per survey type (assessments module; also set on `assessment.submitted` SELF). */
export async function setSelfAssessmentStatus(
  cycleId: string,
  acoId: string,
  surveyType: SurveyType,
  status: SelfAssessmentStatus,
  session?: ClientSession,
): Promise<ParticipantDto> {
  const before = await requireParticipantDoc(cycleId, acoId, session);
  if (!before.surveyTypes.includes(surveyType)) {
    throw new AppError('PRECONDITION_FAILED', `Participant does not run a ${surveyType} survey in this cycle`, { cycleId, acoId, surveyType });
  }
  const after = await CycleParticipantModel.findOneAndUpdate(
    { _id: before._id },
    { $set: { [`selfAssessment.${surveyType}`]: status } },
    { new: true, ...(session ? { session } : {}) },
  ).lean<CycleParticipantDoc>();
  if (!after) throw new AppError('NOT_FOUND', 'Participant not found', { cycleId, acoId });
  return (await toParticipantDtos([after]))[0] as ParticipantDto;
}

export async function recordReminderSent(participantId: Types.ObjectId, sent: number, at: Date): Promise<void> {
  await CycleParticipantModel.updateOne({ _id: participantId }, { $set: { 'reminders.sent': sent, 'reminders.lastAt': at } });
}

// --- creation (publish) ----------------------------------------------------

export interface ParticipantPlan {
  acoId: Types.ObjectId;
  airportId: Types.ObjectId;
  surveyTypes: SurveyType[];
  requiredSampleSize: number;
}

/**
 * What each operator owes in the cycle, from the domain rules
 * (`participantSurveyTypes`, `requiredSampleSize`). Throws when an operator
 * runs none of the cycle's survey types, naming it so the admin can fix the list.
 */
export function planParticipants(cycle: { type: CycleType; minSampleSize: number }, operators: OrganisationDoc[]): ParticipantPlan[] {
  return operators.map((org) => {
    const surveyTypes = participantSurveyTypes(cycle.type, org.operations);
    if (surveyTypes.length === 0) {
      throw new AppError('PRECONDITION_FAILED', `Operator ${org.code} runs no ${cycle.type === 'BOTH' ? 'domestic or international' : cycle.type.toLowerCase()} services; remove it from the cycle`, {
        acoId: idString(org._id),
        code: org.code,
      });
    }
    if (!org.airportId) throw new AppError('PRECONDITION_FAILED', `Operator ${org.code} is not linked to an airport`, { acoId: idString(org._id) });
    return { acoId: org._id, airportId: org.airportId, surveyTypes, requiredSampleSize: requiredSampleSize(cycle, surveyTypes) };
  });
}

export async function createParticipants(cycleId: Types.ObjectId, plans: ParticipantPlan[], session: ClientSession): Promise<CycleParticipantDoc[]> {
  if (plans.length === 0) return [];
  const created = await CycleParticipantModel.insertMany(
    plans.map((plan) => ({
      cycleId,
      acoId: plan.acoId,
      airportId: plan.airportId,
      surveyTypes: plan.surveyTypes,
      requiredSampleSize: plan.requiredSampleSize,
      sampling: { status: 'NOT_STARTED', selectedCount: 0 },
      stats: { invited: 0, started: 0, completed: 0 },
      selfAssessment: {
        DOMESTIC: plan.surveyTypes.includes('DOMESTIC') ? 'NOT_STARTED' : null,
        INTERNATIONAL: plan.surveyTypes.includes('INTERNATIONAL') ? 'NOT_STARTED' : null,
      },
      reminders: { sent: 0, lastAt: null },
    })),
    { session },
  );
  return created.map((doc) => doc.toObject());
}
