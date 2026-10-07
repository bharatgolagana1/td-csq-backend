// Cycles: create / edit a DRAFT, publish it (windows, market shares, surveys,
// participants), move it through the status machine (manual override or the
// clock) and answer the ACO's "what must I do now" question. The rules live
// in ./domain/**; this file applies them to storage and the other modules.
import type { FilterQuery, Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { isSystemContext, requestContextOf, type AnyContext } from '../../core/auth/system.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { emit } from '../../core/events.js';
import { and } from '../../core/filters.js';
import { idString, toId } from '../../core/ids.js';
import { pageOf, parseSort, searchFilter, skipLimit, type Page } from '../../core/pagination.js';
import { findAirportsByIds } from '../airports/airports.service.js';
import { audit } from '../audit/audit.service.js';
import { getMarketShare, putMarketShare, SHARE_TOLERANCE } from '../organisations/market-share.service.js';
import type { OrganisationDoc } from '../organisations/organisations.model.js';
import { findOrganisationById, findOrganisationsByIds } from '../organisations/organisations.service.js';
import { getSettingsDoc, type DEFAULT_SETTINGS } from '../settings/settings.service.js';

import type { CycleParticipantDoc } from './cycle-participants.model.js';
import { CycleModel, type CycleDoc, type CycleWindowDoc, type SurveyVersionRefs } from './cycles.model.js';
import { mailCyclePublished } from './cycles.notify.js';
import type {
  CreateCycleInput,
  CurrentCycleDto,
  CurrentCycleQuery,
  CycleDetailDto,
  CycleListQuery,
  CycleSummaryDto,
  DeadlineKind,
  ParticipantDto,
  ParticipantListQuery,
  PatchCycleInput,
  WindowDto,
  WindowInput,
  WindowPatch,
} from './cycles.schemas.js';
import { publishedSurveyVersions } from './cycles.surveys.js';
import { deriveWindows } from './domain/derive.js';
import { cycleSurveyTypes } from './domain/participants.js';
import { checkManualTransition, statusAfterPublish, TRANSITION_TABLE } from './domain/transitions.js';
import type { CycleStatus, CycleWindows } from './domain/types.js';
import { validateWindows, windowEdge, type WindowProblem } from './domain/windows.js';
import {
  createParticipants,
  listParticipantDocs,
  listParticipantDocsForOperator,
  listParticipantsPage,
  participantScopeFilter,
  planParticipants,
  progressByCycle,
  toParticipantDtos,
} from './participants.service.js';

// The participant half of the contract (WAVE1-BRIEF §2) is implemented in
// participants.service.ts; higher modules may import it from either file.
export { bumpParticipantStats, getParticipant, listParticipants, setParticipantSampling, setSelfAssessmentStatus } from './participants.service.js';
export type { SamplingPatch } from './participants.service.js';

type Defaults = (typeof DEFAULT_SETTINGS)['defaults'];

/** Statuses the scheduler drives (ARCHITECTURE §7 "Cycle clock"). */
export const CLOCK_STATUSES: readonly CycleStatus[] = ['PUBLISHED', 'SAMPLING_OPEN', 'SAMPLING_CLOSED', 'ASSESSMENT_OPEN', 'ASSESSMENT_CLOSED'];

/** Statuses in which an operator still has something to do or wait for (`GET /cycles/current`). */
export const ACTING_STATUSES: readonly CycleStatus[] = CLOCK_STATUSES;

/** From the assessment window on, the cycle's market-share snapshot is frozen (REQUIREMENTS §21). */
export const MARKET_SHARE_FROZEN_STATUSES: readonly CycleStatus[] = ['ASSESSMENT_OPEN', 'ASSESSMENT_CLOSED', 'SCORED', 'ARCHIVED'];

// --- scope -----------------------------------------------------------------

/** Cycles the caller may see: PLATFORM / system all; ACO and AIRPORT the published cycles they take part in. */
export function cycleScopeFilter(ctx: AnyContext): FilterQuery<CycleDoc> {
  if (isSystemContext(ctx)) return {};
  switch (ctx.scope.kind) {
    case 'PLATFORM':
      return {};
    case 'ACO':
      return { participatingAcoIds: toId(ctx.scope.acoId), status: { $ne: 'DRAFT' } };
    case 'AIRPORT':
      return { participatingAirportIds: toId(ctx.scope.airportId), status: { $ne: 'DRAFT' } };
  }
}

export async function findCycleDoc(id: string | Types.ObjectId): Promise<CycleDoc | null> {
  return CycleModel.findById(toId(idString(id), 'cycleId')).lean<CycleDoc>();
}

export async function findCyclesByStatus(statuses: readonly CycleStatus[]): Promise<CycleDoc[]> {
  return CycleModel.find({ status: { $in: [...statuses] } }).sort({ 'sampling.start.utc': 1 }).lean<CycleDoc[]>();
}

export async function requireVisibleCycle(ctx: AnyContext, id: string): Promise<CycleDoc> {
  const doc = await CycleModel.findOne(and<CycleDoc>(cycleScopeFilter(ctx), { _id: toId(id, 'cycleId') })).lean<CycleDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Cycle not found');
  return doc;
}

// --- DTOs ------------------------------------------------------------------

function windowDto(window: CycleWindowDoc): WindowDto {
  return {
    start: { wall: window.start.wall, utc: window.start.utc.toISOString() },
    end: { wall: window.end.wall, utc: window.end.utc.toISOString() },
  };
}

async function toSummaries(docs: CycleDoc[], participantScope: FilterQuery<CycleParticipantDoc>): Promise<CycleSummaryDto[]> {
  const progress = await progressByCycle(
    docs.map((doc) => doc._id),
    participantScope,
  );
  return docs.map((doc) => {
    const p = progress.get(idString(doc._id));
    return {
      id: idString(doc._id),
      code: doc.code,
      name: doc.name,
      type: doc.type,
      status: doc.status,
      tz: doc.tz,
      sampling: windowDto(doc.sampling),
      assessment: windowDto(doc.assessment),
      minSampleSize: doc.minSampleSize,
      participants: { airports: doc.participatingAirportIds.length, operators: doc.participatingAcoIds.length },
      progress: { locked: p?.locked ?? 0, invited: p?.invited ?? 0, completed: p?.completed ?? 0 },
      publishedAt: doc.publishedAt?.toISOString() ?? null,
      scoredAt: doc.scoredAt?.toISOString() ?? null,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  });
}

async function toDetail(doc: CycleDoc, participantScope: FilterQuery<CycleParticipantDoc>): Promise<CycleDetailDto> {
  const [summary] = await toSummaries([doc], participantScope);
  const participants = await toParticipantDtos(await listParticipantDocs(doc._id, participantScope));
  return {
    ...(summary as CycleSummaryDto),
    reminders: { sampling: { ...doc.reminders.sampling }, assessment: { ...doc.reminders.assessment } },
    participatingAirportIds: doc.participatingAirportIds.map(idString),
    participatingAcoIds: doc.participatingAcoIds.map(idString),
    surveyVersions: {
      DOMESTIC: doc.surveyVersions.DOMESTIC ? idString(doc.surveyVersions.DOMESTIC) : null,
      INTERNATIONAL: doc.surveyVersions.INTERNATIONAL ? idString(doc.surveyVersions.INTERNATIONAL) : null,
    },
    marketShareFrozen: doc.marketShareFrozen || MARKET_SHARE_FROZEN_STATUSES.includes(doc.status),
    publishedBy: doc.publishedBy ? idString(doc.publishedBy) : null,
    createdBy: doc.createdBy ? idString(doc.createdBy) : null,
    participantList: participants,
  };
}

// --- reads -----------------------------------------------------------------

const SORTABLE = ['name', 'code', 'status', 'type', 'createdAt', 'sampling.start.utc', 'assessment.start.utc'] as const;

export async function listCycles(ctx: RequestContext, query: CycleListQuery): Promise<Page<CycleSummaryDto>> {
  const requested: FilterQuery<CycleDoc> = {};
  if (query.status) requested.status = query.status;
  if (query.type) requested.type = query.type;
  if (query.airportId) requested.participatingAirportIds = toId(query.airportId);
  if (query.acoId) requested.participatingAcoIds = toId(query.acoId);
  const filter = and<CycleDoc>(cycleScopeFilter(ctx), searchFilter<CycleDoc>(query.q, ['code', 'name']), requested);
  const sort = parseSort(query.sort, SORTABLE, '-sampling.start.utc');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    CycleModel.find(filter).sort(sort).skip(skip).limit(limit).lean<CycleDoc[]>(),
    CycleModel.countDocuments(filter),
  ]);
  return pageOf(await toSummaries(docs, participantScopeFilter(ctx)), total, query);
}

/** Contract: the cycle with its (scoped) participants, survey versions and frozen flag; cross-tenant → 404. */
export async function getCycle(ctx: AnyContext, id: string): Promise<CycleDetailDto> {
  return toDetail(await requireVisibleCycle(ctx, id), participantScopeFilter(ctx));
}

/** `GET /cycles/:id/participants`: the cycle must be visible (404 otherwise), then the scoped page. */
export async function listCycleParticipants(ctx: RequestContext, id: string, query: ParticipantListQuery): Promise<Page<ParticipantDto>> {
  await requireVisibleCycle(ctx, id);
  return listParticipantsPage(ctx, id, query);
}

/** Contract, registered into organisations at boot: may the cycle's market-share snapshot still change? */
export async function isMarketShareFrozen(cycleId: string): Promise<boolean> {
  const doc = await CycleModel.findById(toId(cycleId, 'cycleId'), { marketShareFrozen: 1, status: 1 }).lean<Pick<CycleDoc, 'marketShareFrozen' | 'status'>>();
  if (!doc) return false;
  return doc.marketShareFrozen || MARKET_SHARE_FROZEN_STATUSES.includes(doc.status);
}

// --- windows ---------------------------------------------------------------

function windowsFromInput(sampling: WindowInput, assessment: WindowInput, tz: string): CycleWindows {
  return {
    sampling: { start: windowEdge(sampling.start, tz), end: windowEdge(sampling.end, tz) },
    assessment: { start: windowEdge(assessment.start, tz), end: windowEdge(assessment.end, tz) },
  };
}

/** Explicit windows win; otherwise `initiationDate` + `settings.defaults` derive them (ARCHITECTURE §6 `POST /cycles`). */
function resolveWindows(
  input: { initiationDate?: string | undefined; sampling?: WindowInput | undefined; assessment?: WindowInput | undefined },
  tz: string,
  defaults: Defaults,
): CycleWindows {
  if (input.sampling && input.assessment) return windowsFromInput(input.sampling, input.assessment, tz);
  if (input.sampling || input.assessment) {
    throw new AppError('VALIDATION', 'Give both the sampling and the assessment window, or an initiationDate to derive them');
  }
  if (input.initiationDate) {
    return deriveWindows({
      initiationDate: input.initiationDate,
      tz,
      defaults: { samplingDays: defaults.samplingDays, assessmentDays: defaults.assessmentDays },
    });
  }
  throw new AppError('VALIDATION', 'Either initiationDate or both sampling and assessment windows are required');
}

function windowIssues(problems: WindowProblem[]): { path: string; code: string; message: string }[] {
  return problems.map((problem) => ({ path: problem.path, code: problem.code, message: problem.message }));
}

function assertWindowsValid(windows: CycleWindows, options: { allowSamplingOverlap?: boolean; now?: Date } = {}): void {
  const result = validateWindows(windows, options);
  if (!result.ok) throw new AppError('VALIDATION', 'Invalid cycle windows', { issues: windowIssues(result.problems) });
}

// --- participants (ids on the DRAFT) ---------------------------------------

async function assertParticipantIds(airportIds: string[], acoIds: string[]): Promise<void> {
  const issues: { path: string; message: string }[] = [];
  const [airports, orgs] = await Promise.all([findAirportsByIds(airportIds), findOrganisationsByIds(acoIds)]);
  airportIds.forEach((id, index) => {
    if (!airports.has(id)) issues.push({ path: `participatingAirportIds.${index}`, message: `Unknown airport ${id}` });
  });
  acoIds.forEach((id, index) => {
    const org = orgs.get(id);
    if (org?.type !== 'ACO') issues.push({ path: `participatingAcoIds.${index}`, message: `Unknown operator ${id}` });
    else if (org.status !== 'ACTIVE') issues.push({ path: `participatingAcoIds.${index}`, message: `Operator ${org.code} is ${org.status}` });
    else if (!org.airportId || !airportIds.includes(idString(org.airportId))) {
      issues.push({ path: `participatingAcoIds.${index}`, message: `Operator ${org.code} is not at a participating airport` });
    }
  });
  if (issues.length > 0) throw new AppError('VALIDATION', 'Invalid participants', { issues });
}

async function assertCodeFree(code: string, exceptId?: Types.ObjectId): Promise<void> {
  const existing = await CycleModel.findOne({ code }, { _id: 1 }).lean<Pick<CycleDoc, '_id'>>();
  if (existing && (!exceptId || !existing._id.equals(exceptId))) throw new AppError('CONFLICT', `Cycle code ${code} already exists`);
}

function surveyVersionRefs(input: { DOMESTIC?: string | null | undefined; INTERNATIONAL?: string | null | undefined } | undefined, base: SurveyVersionRefs): SurveyVersionRefs {
  const pick = (value: string | null | undefined, current: Types.ObjectId | null): Types.ObjectId | null =>
    value === undefined ? current : value === null ? null : toId(value, 'surveyId');
  return { DOMESTIC: pick(input?.DOMESTIC, base.DOMESTIC), INTERNATIONAL: pick(input?.INTERNATIONAL, base.INTERNATIONAL) };
}

// --- create / update -------------------------------------------------------

export async function createCycle(ctx: RequestContext, input: CreateCycleInput): Promise<CycleDetailDto> {
  const settings = await getSettingsDoc();
  const tz = input.tz ?? settings.defaults.tz;
  const windows = resolveWindows(input, tz, settings.defaults);
  assertWindowsValid(windows);
  await assertCodeFree(input.code);
  await assertParticipantIds(input.participatingAirportIds, input.participatingAcoIds);

  const created = (
    await CycleModel.create({
      name: input.name,
      code: input.code,
      type: input.type,
      tz,
      sampling: windows.sampling,
      assessment: windows.assessment,
      minSampleSize: input.minSampleSize,
      reminders: input.reminders ?? settings.defaults.reminders,
      participatingAirportIds: input.participatingAirportIds.map((id) => toId(id)),
      participatingAcoIds: input.participatingAcoIds.map((id) => toId(id)),
      surveyVersions: surveyVersionRefs(input.surveyVersions, { DOMESTIC: null, INTERNATIONAL: null }),
      status: 'DRAFT',
      createdBy: toId(ctx.user.id),
    })
  ).toObject();
  const dto = await toDetail(created, participantScopeFilter(ctx));
  await audit(ctx, { action: 'cycle.created', entity: 'cycle', entityId: dto.id, after: dto });
  return dto;
}

export async function updateCycle(ctx: RequestContext, id: string, patch: PatchCycleInput): Promise<CycleDetailDto> {
  const before = await requireVisibleCycle(ctx, id);
  if (before.status === 'SCORED' || before.status === 'ARCHIVED') {
    throw new AppError('PRECONDITION_FAILED', `A ${before.status} cycle can no longer be changed`, { status: before.status });
  }
  const $set = before.status === 'DRAFT' ? await draftChanges(before, patch) : publishedChanges(before, patch);
  const after = Object.keys($set).length === 0 ? before : await CycleModel.findOneAndUpdate({ _id: before._id }, { $set }, { new: true }).lean<CycleDoc>();
  if (!after) throw new AppError('NOT_FOUND', 'Cycle not found');
  const scope = participantScopeFilter(ctx);
  const [beforeDto, afterDto] = await Promise.all([toDetail(before, scope), toDetail(after, scope)]);
  await audit(ctx, { action: 'cycle.updated', entity: 'cycle', entityId: id, before: beforeDto, after: afterDto });
  return afterDto;
}

function applyWindowPatch(current: CycleWindowDoc, patch: WindowPatch | undefined): WindowInput {
  return { start: patch?.start ?? current.start.wall, end: patch?.end ?? current.end.wall };
}

/** DRAFT: any field; windows are rebuilt from wall clocks (so a tz change re-computes every instant). */
async function draftChanges(before: CycleDoc, patch: PatchCycleInput): Promise<Partial<CycleDoc>> {
  const settings = await getSettingsDoc();
  const $set: Partial<CycleDoc> = {};
  const tz = patch.tz ?? before.tz;
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.code !== undefined && patch.code !== before.code) {
    await assertCodeFree(patch.code, before._id);
    $set.code = patch.code;
  }
  if (patch.type !== undefined) $set.type = patch.type;
  if (patch.minSampleSize !== undefined) $set.minSampleSize = patch.minSampleSize;
  if (patch.reminders !== undefined) $set.reminders = patch.reminders;
  if (patch.surveyVersions !== undefined) $set.surveyVersions = surveyVersionRefs(patch.surveyVersions, before.surveyVersions);

  const touchesWindows = patch.tz !== undefined || patch.initiationDate !== undefined || patch.sampling !== undefined || patch.assessment !== undefined;
  if (touchesWindows) {
    const windows =
      patch.initiationDate !== undefined && patch.sampling === undefined && patch.assessment === undefined
        ? resolveWindows({ initiationDate: patch.initiationDate }, tz, settings.defaults)
        : windowsFromInput(applyWindowPatch(before.sampling, patch.sampling), applyWindowPatch(before.assessment, patch.assessment), tz);
    assertWindowsValid(windows);
    $set.tz = tz;
    $set.sampling = windows.sampling;
    $set.assessment = windows.assessment;
  }

  if (patch.participatingAirportIds !== undefined || patch.participatingAcoIds !== undefined) {
    const airportIds = patch.participatingAirportIds ?? before.participatingAirportIds.map(idString);
    const acoIds = patch.participatingAcoIds ?? before.participatingAcoIds.map(idString);
    await assertParticipantIds(airportIds, acoIds);
    $set.participatingAirportIds = airportIds.map((value) => toId(value));
    $set.participatingAcoIds = acoIds.map((value) => toId(value));
  }
  return $set;
}

const PUBLISHED_PATCHABLE = ['sampling.end', 'assessment.end', 'reminders'] as const;

/** After publishing: end-date extensions and reminder settings only (ARCHITECTURE §6 `PATCH /cycles/:id`). */
function publishedChanges(before: CycleDoc, patch: PatchCycleInput): Partial<CycleDoc> {
  const offending = Object.keys(patch).filter((key) => !['sampling', 'assessment', 'reminders'].includes(key));
  for (const key of ['sampling', 'assessment'] as const) {
    const start = patch[key]?.start;
    if (start !== undefined && start !== before[key].start.wall) offending.push(`${key}.start`);
  }
  if (offending.length > 0) {
    throw new AppError('VALIDATION', `After publishing only ${PUBLISHED_PATCHABLE.join(', ')} can be changed`, {
      allowed: PUBLISHED_PATCHABLE,
      offending,
    });
  }
  const $set: Partial<CycleDoc> = {};
  if (patch.reminders !== undefined) $set.reminders = patch.reminders;
  const windows: CycleWindows = { sampling: before.sampling, assessment: before.assessment };
  for (const key of ['sampling', 'assessment'] as const) {
    const end = patch[key]?.end;
    if (end === undefined || end === before[key].end.wall) continue;
    const edge = windowEdge(end, before.tz);
    if (edge.utc.getTime() <= before[key].end.utc.getTime()) {
      throw new AppError('VALIDATION', `${key}.end can only be extended (currently ${before[key].end.wall})`, { path: `${key}.end` });
    }
    windows[key] = { start: before[key].start, end: edge };
    $set[key] = windows[key];
  }
  // A sampling extension may run into the assessment window; the clock copes (assessment opens when sampling closes).
  assertWindowsValid(windows, { allowSamplingOverlap: true });
  return $set;
}

// --- publish ---------------------------------------------------------------

async function loadParticipatingOperators(cycle: CycleDoc): Promise<OrganisationDoc[]> {
  const orgs = await findOrganisationsByIds(cycle.participatingAcoIds);
  const airportIds = new Set(cycle.participatingAirportIds.map(idString));
  return cycle.participatingAcoIds.map((acoId) => {
    const org = orgs.get(idString(acoId));
    if (org?.type !== 'ACO') throw new AppError('PRECONDITION_FAILED', `Operator ${idString(acoId)} no longer exists`, { acoId: idString(acoId) });
    if (org.status !== 'ACTIVE') throw new AppError('PRECONDITION_FAILED', `Operator ${org.code} is ${org.status}`, { acoId: idString(acoId), code: org.code });
    if (!org.airportId || !airportIds.has(idString(org.airportId))) {
      throw new AppError('PRECONDITION_FAILED', `Operator ${org.code} is not at a participating airport`, { acoId: idString(acoId), code: org.code });
    }
    return org;
  });
}

interface ShareSnapshot {
  airportId: string;
  entries: { acoId: string; sharePct: number }[];
}

/** Every participating airport's current shares must total 100 (ARCHITECTURE §7 "Onboarding"); returns what to snapshot. */
async function assertMarketSharesComplete(ctx: RequestContext, cycle: CycleDoc): Promise<ShareSnapshot[]> {
  const airports = await findAirportsByIds(cycle.participatingAirportIds);
  const snapshots: ShareSnapshot[] = [];
  for (const airportId of cycle.participatingAirportIds.map(idString)) {
    const share = await getMarketShare(ctx, airportId, null);
    if (Math.abs(share.total - 100) > SHARE_TOLERANCE) {
      const airport = airports.get(airportId);
      throw new AppError(
        'PRECONDITION_FAILED',
        `Market shares at ${airport?.iata ?? airportId}${airport ? ` (${airport.name})` : ''} total ${share.total}, not 100`,
        { airportId, iata: airport?.iata ?? null, name: airport?.name ?? null, total: share.total },
      );
    }
    snapshots.push({ airportId, entries: share.entries.map((entry) => ({ acoId: entry.acoId, sharePct: entry.sharePct })) });
  }
  return snapshots;
}

/** Pinned versions stay; the rest come from the surveys module; a missing published survey refuses the publish. */
async function resolveSurveyVersions(cycle: CycleDoc): Promise<SurveyVersionRefs> {
  const latest = await publishedSurveyVersions();
  const versions: SurveyVersionRefs = { DOMESTIC: null, INTERNATIONAL: null };
  for (const type of cycleSurveyTypes(cycle.type)) {
    const pinned = cycle.surveyVersions[type];
    const chosen = pinned ? idString(pinned) : latest[type];
    if (!chosen) {
      throw new AppError('PRECONDITION_FAILED', `No published ${type} survey version; publish the ${type.toLowerCase()} survey first`, { surveyType: type });
    }
    versions[type] = toId(chosen, 'surveyId');
  }
  return versions;
}

/**
 * `POST /cycles/:id/publish`. Guards (all 412): DRAFT, windows ordered and
 * sampling not over, participants listed, operators active and eligible,
 * market shares complete, surveys published. Then: market-share snapshot
 * (through organisations), cycle_participants + status in one transaction,
 * audit, ACO-admin e-mails, `cycle.published` and `cycle.transitioned`.
 */
export async function publishCycle(ctx: RequestContext, id: string, now = new Date()): Promise<CycleDetailDto> {
  const cycle = await requireVisibleCycle(ctx, id);
  if (cycle.status !== 'DRAFT') {
    throw new AppError('PRECONDITION_FAILED', `Cycle is ${cycle.status}; only a DRAFT cycle can be published`, { status: cycle.status });
  }
  const validation = validateWindows(cycle, { now });
  if (!validation.ok) {
    throw new AppError('PRECONDITION_FAILED', 'Cycle windows are not valid for publishing', { issues: windowIssues(validation.problems) });
  }
  if (cycle.participatingAirportIds.length === 0 || cycle.participatingAcoIds.length === 0) {
    throw new AppError('PRECONDITION_FAILED', 'A cycle needs at least one participating airport and operator');
  }
  const operators = await loadParticipatingOperators(cycle);
  const plans = planParticipants(cycle, operators);
  const snapshots = await assertMarketSharesComplete(ctx, cycle);
  const surveyVersions = await resolveSurveyVersions(cycle);

  for (const snapshot of snapshots) {
    await putMarketShare(ctx, snapshot.airportId, { cycleId: id, entries: snapshot.entries, note: `Snapshot at publish of ${cycle.code}` });
  }
  const status = statusAfterPublish(cycle, now);
  const participants = await withTransaction(async (session) => {
    const updated = await CycleModel.findOneAndUpdate(
      { _id: cycle._id, status: 'DRAFT' },
      { $set: { status, publishedAt: now, publishedBy: toId(ctx.user.id), surveyVersions } },
      { new: true, session },
    ).lean<CycleDoc>();
    if (!updated) throw new AppError('CONFLICT', 'Cycle was published concurrently');
    return createParticipants(cycle._id, plans, session);
  });

  const published = await requireVisibleCycle(ctx, id);
  const dto = await toDetail(published, participantScopeFilter(ctx));
  await audit(ctx, {
    action: 'cycle.published',
    entity: 'cycle',
    entityId: id,
    before: { status: 'DRAFT' },
    after: { status, publishedAt: now.toISOString(), surveyVersions: dto.surveyVersions, participants: participants.length },
  });
  await mailCyclePublished(published, participants, status === 'SAMPLING_OPEN');
  await emit('cycle.published', { cycleId: id }, { ctx });
  await emit('cycle.transitioned', { cycleId: id, from: 'DRAFT', to: status, trigger: 'MANUAL' }, { ctx });
  return dto;
}

// --- transitions -----------------------------------------------------------

function canAutoTransition(from: CycleStatus, to: CycleStatus): boolean {
  return TRANSITION_TABLE.some((rule) => rule.from === from && rule.to === to && rule.via.includes('AUTO'));
}

export interface TransitionOptions {
  /** Defaults to CLOCK under a system context, MANUAL under a request. */
  trigger?: 'CLOCK' | 'MANUAL';
  now?: Date;
}

/**
 * Contract: moves the cycle to `to`. MANUAL goes through `checkManualTransition`
 * (the §6 override); CLOCK through the table's AUTO edges. The status update is
 * atomic on the current status, audited as `cycle.transitioned`, then
 * `cycle.transitioned` is emitted (after the write, with no session: handlers
 * such as invitations' activation and scoring's run own their own writes).
 */
export async function transition(ctx: AnyContext, cycleId: string, to: CycleStatus, reason: string, options: TransitionOptions = {}): Promise<CycleDetailDto> {
  const now = options.now ?? new Date();
  const trigger = options.trigger ?? (isSystemContext(ctx) ? 'CLOCK' : 'MANUAL');
  if (reason.trim().length === 0) throw new AppError('VALIDATION', 'A reason is required');
  const cycle = await requireVisibleCycle(ctx, cycleId);
  const from = cycle.status;
  if (trigger === 'MANUAL') {
    const check = checkManualTransition(cycle, to, now);
    if (!check.ok) {
      throw new AppError('PRECONDITION_FAILED', check.problems[0]?.message ?? `Cannot move a ${from} cycle to ${to}`, { from, to, problems: check.problems });
    }
  } else if (!canAutoTransition(from, to)) {
    throw new AppError('PRECONDITION_FAILED', `The clock cannot move a ${from} cycle to ${to}`, { from, to });
  }
  const $set: Partial<CycleDoc> = { status: to };
  if (to === 'SCORED') $set.scoredAt = now;
  if (MARKET_SHARE_FROZEN_STATUSES.includes(to)) $set.marketShareFrozen = true;
  const updated = await CycleModel.findOneAndUpdate({ _id: cycle._id, status: from }, { $set }, { new: true }).lean<CycleDoc>();
  if (!updated) throw new AppError('CONFLICT', 'Cycle status changed concurrently; reload and retry', { cycleId });
  await audit(requestContextOf(ctx), {
    action: 'cycle.transitioned',
    entity: 'cycle',
    entityId: cycleId,
    before: { status: from },
    after: { status: to, trigger, reason },
  });
  await emit('cycle.transitioned', { cycleId, from, to, trigger }, { ctx });
  return toDetail(updated, participantScopeFilter(ctx));
}

// --- current cycles (the ACO strip) ----------------------------------------

function nextDeadline(cycle: CycleDoc, participant: CycleParticipantDoc): { kind: DeadlineKind; at: string } | null {
  switch (cycle.status) {
    case 'PUBLISHED':
      return { kind: 'SAMPLING_OPENS', at: cycle.sampling.start.utc.toISOString() };
    case 'SAMPLING_OPEN':
      return participant.sampling.status === 'LOCKED'
        ? { kind: 'ASSESSMENT_OPENS', at: cycle.assessment.start.utc.toISOString() }
        : { kind: 'SAMPLING_CLOSES', at: cycle.sampling.end.utc.toISOString() };
    case 'SAMPLING_CLOSED':
      return { kind: 'ASSESSMENT_OPENS', at: cycle.assessment.start.utc.toISOString() };
    case 'ASSESSMENT_OPEN':
      return { kind: 'ASSESSMENT_CLOSES', at: cycle.assessment.end.utc.toISOString() };
    case 'DRAFT':
    case 'ASSESSMENT_CLOSED':
    case 'SCORED':
    case 'ARCHIVED':
      return null;
  }
}

/** Contract: the cycles an operator must act on now, oldest sampling start first, with its participant and next deadline. */
export async function currentCyclesForOperator(acoId: string): Promise<CurrentCycleDto[]> {
  const participants = await listParticipantDocsForOperator(acoId);
  if (participants.length === 0) return [];
  const byCycle = new Map(participants.map((participant) => [idString(participant.cycleId), participant]));
  const cycles = await CycleModel.find({ _id: { $in: participants.map((participant) => participant.cycleId) }, status: { $in: [...ACTING_STATUSES] } })
    .sort({ 'sampling.start.utc': 1 })
    .lean<CycleDoc[]>();
  const scope: FilterQuery<CycleParticipantDoc> = { acoId: toId(acoId, 'acoId') };
  const summaries = await toSummaries(cycles, scope);
  const out: CurrentCycleDto[] = [];
  for (const [index, cycle] of cycles.entries()) {
    const participant = byCycle.get(idString(cycle._id));
    const summary = summaries[index];
    if (!participant || !summary) continue;
    const [participantDto] = await toParticipantDtos([participant]);
    if (!participantDto) continue;
    out.push({ cycle: summary, participant: participantDto, nextDeadline: nextDeadline(cycle, participant) });
  }
  return out;
}

/** `GET /cycles/current`: ACO its own; PLATFORM and AIRPORT name the operator with `?acoId=` (AIRPORT: at its airport). */
export async function currentCycles(ctx: RequestContext, query: CurrentCycleQuery): Promise<CurrentCycleDto[]> {
  switch (ctx.scope.kind) {
    case 'ACO':
      if (query.acoId !== undefined && query.acoId !== ctx.scope.acoId) throw new AppError('NOT_FOUND', 'Operator not found');
      return currentCyclesForOperator(ctx.scope.acoId);
    case 'PLATFORM':
      if (query.acoId === undefined) throw new AppError('VALIDATION', 'acoId is required for platform users');
      return currentCyclesForOperator(query.acoId);
    case 'AIRPORT': {
      if (query.acoId === undefined) throw new AppError('VALIDATION', 'acoId is required for airport users');
      const org = await findOrganisationById(query.acoId);
      if (org?.type !== 'ACO' || !org.airportId || idString(org.airportId) !== ctx.scope.airportId) {
        throw new AppError('NOT_FOUND', 'Operator not found');
      }
      return currentCyclesForOperator(query.acoId);
    }
  }
}
