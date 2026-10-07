// Sampling rules: selection changes, the lock gate, the lock / unlock
// transactions, the participant's audit view and a customer's participation
// history (ARCHITECTURE §6 "sampling", §7 "Sampling"; REQUIREMENTS §13–14).
// The pure rules live in ./domain; this file applies them to storage.
import type { AnyBulkWriteOperation } from 'mongoose';

import { assertScope } from '../../core/auth/rbac.js';
import type { RequestContext } from '../../core/auth/session.js';
import { systemContext } from '../../core/auth/system.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { emit, EventHandlerError, type EventMeta, type Events } from '../../core/events.js';
import { idString, toId } from '../../core/ids.js';
import type { Page } from '../../core/pagination.js';
import type { AuditEntryDto } from '../audit/audit.schemas.js';
import { audit, listAudit } from '../audit/audit.service.js';
import type { CycleStatus } from '../cycles/domain/types.js';
import { send } from '../notifications/notifications.service.js';

import { selectionKey } from './domain/eligibility.js';
import { evaluateLock, type LockEvaluation } from './domain/lockGate.js';
import { applySelection, type SelectionItem, type SelectionResult } from './domain/selection.js';
import {
  acoAdminRecipients,
  customersByIds,
  eligibleEntries,
  findCustomer,
  findCycleSummary,
  hasSubmittedAssessment,
  loadSamplingContext,
  operatorName,
  patchParticipantSampling,
  recordLastSampled,
  type SamplingContext,
} from './sampling.context.js';
import { SampleModel, type SampleDoc } from './sampling.model.js';
import type {
  CycleSummaryDto,
  ParticipantSummaryDto,
  ParticipationDto,
  SamplingAuditQuery,
  SelectionChangeDto,
  SelectionInput,
  SelectionRowDto,
  SelectionStateDto,
} from './sampling.schemas.js';

export const SAMPLE_AUDIT_ENTITY = 'sample';

// --- scope -------------------------------------------------------------------

/**
 * The operator a call concerns: an ACO acts for itself (another operator's id
 * is 404, never 403); a PLATFORM user names one with `acoId`.
 */
export function resolveAcoId(ctx: RequestContext, requested?: string): string {
  assertScope(ctx, 'ACO', 'PLATFORM');
  if (ctx.scope.kind === 'ACO') {
    if (requested !== undefined && requested !== ctx.scope.acoId) throw new AppError('NOT_FOUND', 'Cycle participant not found');
    return ctx.scope.acoId;
  }
  if (requested === undefined) throw new AppError('VALIDATION', 'acoId is required for platform users');
  return requested;
}

// --- window rules --------------------------------------------------------------

const AFTER_ASSESSMENT: readonly CycleStatus[] = ['ASSESSMENT_CLOSED', 'SCORED', 'ARCHIVED'];
const UNLOCKED_MAY_EDIT_IN: readonly CycleStatus[] = ['SAMPLING_OPEN', 'SAMPLING_CLOSED', 'ASSESSMENT_OPEN'];

/** SAMPLING_OPEN, or PUBLISHED while the sampling window is already running on the clock. */
export function isSamplingOpen(cycle: CycleSummaryDto, now = new Date()): boolean {
  if (cycle.status === 'SAMPLING_OPEN') return true;
  if (cycle.status !== 'PUBLISHED' || cycle.samplingStart === null || cycle.samplingEnd === null) return false;
  const t = now.getTime();
  return t >= new Date(cycle.samplingStart).getTime() && t < new Date(cycle.samplingEnd).getTime();
}

/**
 * The selection may change (and be locked) while sampling is open and the
 * sample is not locked. A participant ACFI has UNLOCKED may also edit and
 * re-lock after the window closed, until the assessment closes.
 */
export function isSelectionEditable(cycle: CycleSummaryDto, participant: ParticipantSummaryDto, now = new Date()): boolean {
  const status = participant.sampling.status;
  if (status === 'LOCKED') return false;
  if (isSamplingOpen(cycle, now)) return true;
  return status === 'UNLOCKED' && UNLOCKED_MAY_EDIT_IN.includes(cycle.status);
}

function assertEditable({ cycle, participant }: SamplingContext): void {
  if (participant.sampling.status === 'LOCKED') {
    throw new AppError('PRECONDITION_FAILED', 'The sample is locked; ask ACFI to unlock it before changing the selection');
  }
  if (!isSelectionEditable(cycle, participant)) {
    throw new AppError('PRECONDITION_FAILED', 'Sampling is not open for this cycle', { cycleStatus: cycle.status });
  }
}

// --- selection state -----------------------------------------------------------

const activeFilter = (cycleId: string, acoId: string) => ({
  cycleId: toId(cycleId),
  acoId: toId(acoId),
  state: { $in: ['SELECTED', 'LOCKED'] },
});

async function activeSamples(cycleId: string, acoId: string): Promise<SampleDoc[]> {
  return SampleModel.find(activeFilter(cycleId, acoId)).sort({ addedAt: 1, _id: 1 }).lean<SampleDoc[]>();
}

const toItem = (sample: SampleDoc): SelectionItem => ({ customerId: idString(sample.customerId), surveyType: sample.surveyType });
const keyOf = (item: SelectionItem): string => selectionKey(item.customerId, item.surveyType);

type StateReason = SelectionStateDto['reason'];

function stateReason(context: SamplingContext, evaluation: LockEvaluation): { lockable: boolean; reason: StateReason } {
  if (context.participant.sampling.status === 'LOCKED') return { lockable: false, reason: 'ALREADY_LOCKED' };
  if (!isSelectionEditable(context.cycle, context.participant)) return { lockable: false, reason: 'SAMPLING_CLOSED' };
  return { lockable: evaluation.lockable, reason: evaluation.reason };
}

async function buildState(context: SamplingContext): Promise<SelectionStateDto> {
  const { cycle, participant } = context;
  const [samples, eligible] = await Promise.all([activeSamples(cycle.id, participant.acoId), eligibleEntries(participant.acoId, cycle, participant)]);
  const customers = await customersByIds(participant.acoId, samples.map((sample) => idString(sample.customerId)));
  const evaluation = evaluateLock({
    required: participant.requiredSampleSize,
    selectedCount: samples.length,
    eligibleCount: eligible.length,
  });
  const selection: SelectionRowDto[] = samples.map((sample) => ({
    id: idString(sample._id),
    customerId: idString(sample.customerId),
    customer: customers.get(idString(sample.customerId)) ?? null,
    surveyType: sample.surveyType,
    state: sample.state,
    addedAt: sample.addedAt.toISOString(),
    addedBy: sample.addedBy ? idString(sample.addedBy) : null,
  }));
  return {
    cycle,
    participant,
    required: evaluation.required,
    selectedCount: evaluation.selectedCount,
    eligibleCount: evaluation.eligibleCount,
    ...stateReason(context, evaluation),
    shortfallRule: evaluation.shortfallRule,
    remaining: evaluation.remaining,
    target: evaluation.target,
    progress: evaluation.progress,
    progressPct: evaluation.progressPct,
    editable: isSelectionEditable(cycle, participant),
    selection,
  };
}

/** The selection screen for one participant, outside any request (jobs, other features). */
export async function getSelection(cycleId: string, acoId: string): Promise<SelectionStateDto> {
  return buildState(await loadSamplingContext(systemContext('sampling: selection state'), cycleId, acoId));
}

/** `GET /sampling/cycles/:cycleId` — scoped: an ACO sees itself, PLATFORM names the operator. */
export async function getSelectionState(ctx: RequestContext, cycleId: string, requestedAcoId?: string): Promise<SelectionStateDto> {
  const acoId = resolveAcoId(ctx, requestedAcoId);
  return buildState(await loadSamplingContext(ctx, cycleId, acoId));
}

// --- selection changes ---------------------------------------------------------

async function persistSelection(ctx: RequestContext, context: SamplingContext, result: SelectionResult): Promise<void> {
  const { cycle, participant } = context;
  const now = new Date();
  const key = (item: SelectionItem) => ({
    cycleId: toId(cycle.id),
    acoId: toId(participant.acoId),
    customerId: toId(item.customerId),
    surveyType: item.surveyType,
  });
  const operations: AnyBulkWriteOperation<SampleDoc>[] = [
    ...result.added.map((item) => ({
      updateOne: {
        filter: key(item),
        update: { $set: { state: 'SELECTED' as const, addedBy: toId(ctx.user.id), addedAt: now, removedAt: null } },
        upsert: true,
      },
    })),
    ...result.removed.map((item) => ({
      updateOne: { filter: key(item), update: { $set: { state: 'REMOVED' as const, removedAt: now } } },
    })),
  ];
  if (operations.length > 0) await SampleModel.bulkWrite(operations, { ordered: true });
  const selectedCount = await SampleModel.countDocuments({ cycleId: toId(cycle.id), acoId: toId(participant.acoId), state: 'SELECTED' });
  await patchParticipantSampling(cycle.id, participant.acoId, {
    status: participant.sampling.status === 'UNLOCKED' ? 'UNLOCKED' : 'IN_PROGRESS',
    selectedCount,
  });
}

async function commitSelection(
  ctx: RequestContext,
  context: SamplingContext,
  current: readonly SelectionItem[],
  result: SelectionResult,
): Promise<SelectionChangeDto> {
  const { cycle, participant } = context;
  if (result.added.length > 0 || result.removed.length > 0) {
    await persistSelection(ctx, context, result);
    await audit(ctx, {
      action: 'sample.selection.changed',
      entity: SAMPLE_AUDIT_ENTITY,
      entityId: cycle.id,
      orgId: participant.acoId,
      before: { selectedCount: current.length },
      after: {
        selectedCount: result.selection.length,
        required: participant.requiredSampleSize,
        added: result.added,
        removed: result.removed,
        rejected: result.rejected.length,
      },
    });
  }
  const state = await buildState(await loadSamplingContext(ctx, cycle.id, participant.acoId));
  return { added: result.added, removed: result.removed, rejected: result.rejected, state };
}

/** `PUT /sampling/cycles/:cycleId/selection` — `{ add, remove }` through `applySelection`; rejections are returned, never thrown. */
export async function changeSelection(ctx: RequestContext, cycleId: string, input: SelectionInput): Promise<SelectionChangeDto> {
  const acoId = resolveAcoId(ctx, input.acoId);
  const context = await loadSamplingContext(ctx, cycleId, acoId);
  assertEditable(context);
  const [current, customers] = await Promise.all([
    activeSamples(context.cycle.id, acoId).then((samples) => samples.map(toItem)),
    customersByIds(acoId, input.add.map((item) => item.customerId)),
  ]);
  const result = applySelection(
    { current, add: input.add, remove: input.remove },
    { customers: [...customers.values()], cycleType: context.cycle.type, participantSurveyTypes: context.participant.surveyTypes },
  );
  return commitSelection(ctx, context, current, result);
}

/** `POST /sampling/cycles/:cycleId/select-all` — only when fewer entries are eligible than required. */
export async function selectAll(ctx: RequestContext, cycleId: string, requestedAcoId?: string): Promise<SelectionChangeDto> {
  const acoId = resolveAcoId(ctx, requestedAcoId);
  const context = await loadSamplingContext(ctx, cycleId, acoId);
  assertEditable(context);
  const { cycle, participant } = context;
  const [current, eligible] = await Promise.all([
    activeSamples(cycle.id, acoId).then((samples) => samples.map(toItem)),
    eligibleEntries(acoId, cycle, participant),
  ]);
  if (eligible.length >= participant.requiredSampleSize) {
    throw new AppError('PRECONDITION_FAILED', 'Select-all is only allowed when fewer customers are eligible than the minimum sample size', {
      eligibleCount: eligible.length,
      required: participant.requiredSampleSize,
    });
  }
  const selected = new Set(current.map(keyOf));
  const add = eligible.filter((entry) => !selected.has(entry.key)).map((entry) => ({ customerId: entry.customer.id, surveyType: entry.surveyType }));
  const customers = new Map(eligible.map((entry) => [entry.customer.id, entry.customer]));
  const result = applySelection({ current, add }, { customers: [...customers.values()], cycleType: cycle.type, participantSurveyTypes: participant.surveyTypes });
  return commitSelection(ctx, context, current, result);
}

// --- lock / unlock -------------------------------------------------------------

/** A listener's own AppError (e.g. a precondition) reaches the caller as such; anything else is a 500. */
async function emitInSession<K extends keyof Events>(event: K, payload: Events[K], meta: EventMeta): Promise<void> {
  try {
    await emit(event, payload, meta);
  } catch (error) {
    if (error instanceof EventHandlerError && error.cause instanceof AppError) throw error.cause;
    throw error;
  }
}

function lockRefusal(evaluation: LockEvaluation): AppError {
  const { required, selectedCount, eligibleCount, remaining } = evaluation;
  const message =
    evaluation.reason === 'NOTHING_SELECTED'
      ? 'Select at least one participant before locking the sample'
      : evaluation.reason === 'SELECT_ALL_REQUIRED'
        ? `Only ${eligibleCount} entries are eligible, fewer than the ${required} required: select all of them to lock`
        : `${selectedCount} of ${required} required participants selected; select ${remaining} more before locking`;
  return new AppError('PRECONDITION_FAILED', message, {
    reason: evaluation.reason,
    required,
    selectedCount,
    eligibleCount,
    remaining,
    shortfallRule: evaluation.shortfallRule,
  });
}

/**
 * `POST /sampling/cycles/:cycleId/lock`. One transaction: the gate is
 * re-evaluated on the rows it will lock, samples → LOCKED, participant →
 * LOCKED, and `sample.locked` is emitted inside the session so the listeners'
 * writes (PENDING invitations) commit or roll back with it.
 */
export async function lock(ctx: RequestContext, cycleId: string, requestedAcoId?: string): Promise<SelectionStateDto> {
  const acoId = resolveAcoId(ctx, requestedAcoId);
  const context = await loadSamplingContext(ctx, cycleId, acoId);
  const { cycle, participant } = context;
  if (participant.sampling.status === 'LOCKED') throw new AppError('PRECONDITION_FAILED', 'The sample is already locked');
  if (!isSelectionEditable(cycle, participant)) {
    throw new AppError('PRECONDITION_FAILED', 'Sampling is not open for this cycle', { cycleStatus: cycle.status });
  }
  const eligible = await eligibleEntries(acoId, cycle, participant);
  const lockedAt = new Date();

  const { samples, evaluation } = await withTransaction(async (session) => {
    const selected = await SampleModel.find({ cycleId: toId(cycle.id), acoId: toId(acoId), state: 'SELECTED' })
      .sort({ addedAt: 1, _id: 1 })
      .session(session)
      .lean<SampleDoc[]>();
    const gate = evaluateLock({ required: participant.requiredSampleSize, selectedCount: selected.length, eligibleCount: eligible.length });
    if (!gate.lockable) throw lockRefusal(gate);
    await SampleModel.updateMany({ _id: { $in: selected.map((sample) => sample._id) } }, { $set: { state: 'LOCKED' } }, { session });
    await patchParticipantSampling(cycle.id, acoId, { status: 'LOCKED', selectedCount: selected.length, lockedAt, lockedBy: ctx.user.id }, session);
    await recordLastSampled(acoId, [...new Set(selected.map((sample) => idString(sample.customerId)))], cycle.id, session);
    await emitInSession(
      'sample.locked',
      {
        cycleId: cycle.id,
        acoId,
        samples: selected.map((sample) => ({ sampleId: idString(sample._id), customerId: idString(sample.customerId), surveyType: sample.surveyType })),
      },
      { ctx, session },
    );
    return { samples: selected, evaluation: gate };
  });

  await audit(ctx, {
    action: 'sample.locked',
    entity: SAMPLE_AUDIT_ENTITY,
    entityId: cycle.id,
    orgId: acoId,
    before: { status: participant.sampling.status, selectedCount: participant.sampling.selectedCount },
    after: {
      status: 'LOCKED',
      selectedCount: samples.length,
      required: evaluation.required,
      eligibleCount: evaluation.eligibleCount,
      shortfallRule: evaluation.shortfallRule,
      lockedAt: lockedAt.toISOString(),
      lockedBy: ctx.user.id,
    },
  });
  const orgName = await operatorName(acoId);
  for (const recipient of await acoAdminRecipients(acoId)) {
    await send({
      template: 'sample-locked',
      to: recipient.email,
      vars: {
        name: recipient.name,
        orgName,
        cycleName: cycle.name,
        cycleCode: cycle.code,
        selectedCount: samples.length,
        required: evaluation.required,
        lockedBy: ctx.user.name,
      },
      refs: { cycleId: cycle.id, acoId },
    });
  }
  return buildState(await loadSamplingContext(ctx, cycle.id, acoId));
}

/**
 * `POST /sampling/cycles/:cycleId/unlock` — PLATFORM only, reasoned. Samples
 * go back to SELECTED, the participant to UNLOCKED, and `sample.unlocked`
 * lets invitations revoke what is still PENDING, all in one transaction.
 */
export async function unlock(ctx: RequestContext, cycleId: string, acoId: string, reason: string): Promise<SelectionStateDto> {
  assertScope(ctx, 'PLATFORM');
  const context = await loadSamplingContext(ctx, cycleId, acoId);
  const { cycle, participant } = context;
  if (participant.sampling.status !== 'LOCKED') throw new AppError('PRECONDITION_FAILED', 'The sample is not locked');
  if (AFTER_ASSESSMENT.includes(cycle.status)) {
    throw new AppError('PRECONDITION_FAILED', 'The assessment has closed; the sample can no longer be unlocked', { cycleStatus: cycle.status });
  }
  const unlockedAt = new Date();

  await withTransaction(async (session) => {
    await SampleModel.updateMany({ cycleId: toId(cycle.id), acoId: toId(acoId), state: 'LOCKED' }, { $set: { state: 'SELECTED' } }, { session });
    await patchParticipantSampling(cycle.id, acoId, { status: 'UNLOCKED', unlockedAt, unlockedBy: ctx.user.id, unlockReason: reason }, session);
    await emitInSession('sample.unlocked', { cycleId: cycle.id, acoId, reason }, { ctx, session });
  });

  await audit(ctx, {
    action: 'sample.unlocked',
    entity: SAMPLE_AUDIT_ENTITY,
    entityId: cycle.id,
    orgId: acoId,
    before: { status: 'LOCKED', lockedAt: participant.sampling.lockedAt, lockedBy: participant.sampling.lockedBy },
    after: { status: 'UNLOCKED', reason, unlockedAt: unlockedAt.toISOString(), unlockedBy: ctx.user.id },
  });
  const orgName = await operatorName(acoId);
  for (const recipient of await acoAdminRecipients(acoId)) {
    await send({
      template: 'sample-unlocked',
      to: recipient.email,
      vars: { name: recipient.name, orgName, cycleName: cycle.name, cycleCode: cycle.code, reason, unlockedBy: ctx.user.name },
      refs: { cycleId: cycle.id, acoId },
    });
  }
  return buildState(await loadSamplingContext(ctx, cycle.id, acoId));
}

// --- audit and participation ---------------------------------------------------

/** `GET /sampling/cycles/:cycleId/audit` — the participant's `sample.*` entries. */
export async function listSamplingAudit(ctx: RequestContext, cycleId: string, query: SamplingAuditQuery): Promise<Page<AuditEntryDto>> {
  const acoId = resolveAcoId(ctx, query.acoId);
  await loadSamplingContext(ctx, cycleId, acoId);
  const { acoId: _requested, ...list } = query;
  return listAudit(ctx, { ...list, entity: SAMPLE_AUDIT_ENTITY, entityId: cycleId, orgId: acoId });
}

/** `GET /customers/:id/participation` — the cycles a customer was sampled in, newest first. */
export async function getParticipation(ctx: RequestContext, customerId: string, requestedAcoId?: string): Promise<ParticipationDto> {
  const acoId = resolveAcoId(ctx, requestedAcoId);
  const customer = await findCustomer(acoId, customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found');
  const samples = await SampleModel.find({ acoId: toId(acoId), customerId: toId(customerId), state: { $ne: 'REMOVED' } })
    .sort({ addedAt: -1, _id: -1 })
    .lean<SampleDoc[]>();
  const cycleIds = [...new Set(samples.map((sample) => idString(sample.cycleId)))];
  const cycles = new Map(await Promise.all(cycleIds.map(async (id) => [id, await findCycleSummary(ctx, id)] as const)));
  const rows = await Promise.all(
    samples.map(async (sample) => {
      const cycle = cycles.get(idString(sample.cycleId)) ?? null;
      return {
        cycleId: idString(sample.cycleId),
        cycle: cycle ? { id: cycle.id, code: cycle.code, name: cycle.name, type: cycle.type, status: cycle.status } : null,
        surveyType: sample.surveyType,
        state: sample.state,
        addedAt: sample.addedAt.toISOString(),
        submitted: await hasSubmittedAssessment(sample),
      };
    }),
  );
  return { customer, cycles: rows };
}
