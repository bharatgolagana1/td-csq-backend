// Invitation lifecycle (ARCHITECTURE §5 `invitations`, §6 "invitations", §7
// "Cycle clock" and "Participant link"): PENDING at sample lock, SENT at
// assessment open, reminders while open, EXPIRED at assessment end,
// SUBMITTED on the assessment event, REVOKED on unlock or by an operator.
import type { ClientSession, FilterQuery } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { requestContextOf, systemContext, type AnyContext } from '../../core/auth/system.js';
import { AppError } from '../../core/errors.js';
import { emit, type Events } from '../../core/events.js';
import { and } from '../../core/filters.js';
import { idString, toId } from '../../core/ids.js';
import { logger } from '../../core/logger.js';
import { pageOf, parseSort, searchFilter, skipLimit, type Page } from '../../core/pagination.js';
import { once } from '../../core/scheduler.js';
import { webAppUrl } from '../../core/web-url.js';
import { audit } from '../audit/audit.service.js';
import { deriveReminderSchedule, nextReminder } from '../cycles/domain/derive.js';
import { send } from '../notifications/notifications.service.js';
import { findOrganisationById } from '../organisations/organisations.service.js';

import { canReceiveReminder, canTransition, INVITATION_STATES, isExpired, transition, type InvitationState } from './domain/states.js';
import { generateToken, hashToken, isWellFormedToken, maskEmail, maskName } from './domain/token.js';
import { invitationsConfig } from './invitations.config.js';
import { mailContext } from './invitations.mail.js';
import { InvitationModel, type InvitationDoc, type InvitationOtp } from './invitations.model.js';
import { customerFacts, cycleFacts, participantFacts, type CustomerFacts, type CycleFacts } from './invitations.peers.js';
import type { InvitationDto, InvitationListQuery } from './invitations.schemas.js';

/** States the clock may expire, and states that receive reminders — both derived from the machine. */
export const EXPIRABLE_STATES: readonly InvitationState[] = INVITATION_STATES.filter((state) => canTransition(state, 'EXPIRE'));
export const REMINDABLE_STATES: readonly InvitationState[] = INVITATION_STATES.filter(canReceiveReminder);

const EMPTY_OTP: InvitationOtp = { hash: null, expiresAt: null, attempts: 0, sentAts: [] };

export function toInvitationDto(doc: InvitationDoc): InvitationDto {
  const iso = (date: Date | null): string | null => date?.toISOString() ?? null;
  return {
    id: idString(doc._id),
    cycleId: idString(doc.cycleId),
    acoId: idString(doc.acoId),
    airportId: doc.airportId ? idString(doc.airportId) : null,
    customerId: idString(doc.customerId),
    assessmentId: doc.assessmentId ? idString(doc.assessmentId) : null,
    surveyType: doc.surveyType,
    state: doc.state,
    emailMasked: maskEmail(doc.email),
    customer: { nameMasked: maskName(doc.customer.name), type: doc.customer.type },
    sentAt: iso(doc.sentAt),
    openedAt: iso(doc.openedAt),
    verifiedAt: iso(doc.verifiedAt),
    submittedAt: iso(doc.submittedAt),
    revokedAt: iso(doc.revokedAt),
    expiresAt: doc.expiresAt.toISOString(),
    remindersSent: doc.remindersSent,
    lastReminderAt: iso(doc.lastReminderAt),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function requireCycle(ctx: AnyContext, cycleId: string): Promise<CycleFacts> {
  const cycle = await cycleFacts(ctx, cycleId);
  if (!cycle) throw new AppError('NOT_FOUND', 'Cycle not found');
  return cycle;
}

/**
 * The raw token is only ever matched through its hash; a malformed token is
 * simply unknown. The current link and the links of earlier reminders all
 * resolve; a resend clears the earlier ones.
 */
export async function getByToken(token: string): Promise<InvitationDoc | null> {
  if (!isWellFormedToken(token)) return null;
  const hash = hashToken(token);
  return InvitationModel.findOne({ $or: [{ tokenHash: hash }, { previousTokenHashes: hash }] }).lean<InvitationDoc>();
}

/** `${PUBLIC_WEB_URL}/assess/${token}`, whatever slashes PUBLIC_WEB_URL ends in. */
export function invitationLink(token: string): string {
  return webAppUrl(invitationsConfig().webUrl, `/assess/${token}`);
}

// --- sample lock / unlock ------------------------------------------------------

export type SampleLockedPayload = Events['sample.locked'];

export interface HandlerOptions {
  ctx?: AnyContext | undefined;
  /** The emitter's transaction, when it holds one: every write goes through it. */
  session?: ClientSession | undefined;
}

export interface CreatePendingResult {
  created: number;
  existing: number;
}

/**
 * `sample.locked`: one PENDING invitation per locked sample, keyed on
 * cycle + aco + customer + surveyType (the partial unique index ignores
 * REVOKED rows, so a re-lock after an unlock creates fresh ones). Copies
 * the customer's e-mail and name; `expiresAt` is the cycle's assessment end.
 */
export async function createPendingForSamples(payload: SampleLockedPayload, options: HandlerOptions = {}): Promise<CreatePendingResult> {
  if (payload.samples.length === 0) return { created: 0, existing: 0 };
  const ctx = options.ctx ?? systemContext(`event: sample.locked ${payload.cycleId}/${payload.acoId}`);
  const cycle = await requireCycle(ctx, payload.cycleId);
  const operator = await findOrganisationById(payload.acoId);
  if (!operator) throw new AppError('PRECONDITION_FAILED', 'Operator not found for the locked sample', { acoId: payload.acoId });

  const customers = new Map<string, CustomerFacts>();
  for (const customerId of new Set(payload.samples.map((sample) => sample.customerId))) {
    const customer = await customerFacts(payload.acoId, customerId);
    if (!customer) throw new AppError('PRECONDITION_FAILED', 'Sampled customer not found', { customerId });
    customers.set(customerId, customer);
  }

  const cycleId = toId(payload.cycleId, 'cycleId');
  const acoId = toId(payload.acoId, 'acoId');
  const result = await InvitationModel.bulkWrite(
    payload.samples.map((sample) => {
      const customer = customers.get(sample.customerId);
      if (!customer) throw new AppError('INTERNAL', `Customer ${sample.customerId} vanished during lock`);
      return {
        updateOne: {
          filter: { cycleId, acoId, customerId: toId(sample.customerId), surveyType: sample.surveyType, state: { $ne: 'REVOKED' } },
          update: {
            $setOnInsert: {
              cycleId,
              acoId,
              airportId: operator.airportId,
              customerId: toId(sample.customerId),
              surveyType: sample.surveyType,
              assessmentId: null,
              tokenHash: null,
              previousTokenHashes: [],
              state: 'PENDING',
              email: customer.email,
              customer: { name: customer.name, contactPerson: customer.contactPerson, type: customer.type },
              otp: EMPTY_OTP,
              sentAt: null,
              openedAt: null,
              verifiedAt: null,
              submittedAt: null,
              revokedAt: null,
              expiredAt: null,
              remindersSent: 0,
              lastReminderAt: null,
              expiresAt: cycle.assessment.end,
            },
          },
          upsert: true,
        },
      };
    }),
    { ordered: true, ...(options.session ? { session: options.session } : {}) },
  );
  return { created: result.upsertedCount, existing: result.matchedCount };
}

export interface RevokeOptions extends HandlerOptions {
  reason?: string | undefined;
}

/** `sample.unlocked`: PENDING invitations of the participant become REVOKED (SENT ones keep working). */
export async function revokePending(cycleId: string, acoId: string, options: RevokeOptions = {}): Promise<number> {
  const ctx = options.ctx ?? systemContext(`event: sample.unlocked ${cycleId}/${acoId}`);
  const filter: FilterQuery<InvitationDoc> = { cycleId: toId(cycleId), acoId: toId(acoId), state: 'PENDING' };
  const pending = await InvitationModel.find(filter, { _id: 1 })
    .session(options.session ?? null)
    .lean<Pick<InvitationDoc, '_id'>[]>();
  if (pending.length === 0) return 0;
  const now = new Date();
  await InvitationModel.updateMany(
    { _id: { $in: pending.map((doc) => doc._id) }, state: 'PENDING' },
    { $set: { state: 'REVOKED', revokedAt: now } },
    options.session ? { session: options.session } : {},
  );
  for (const doc of pending) {
    await audit(requestContextOf(ctx), {
      action: 'invitation.revoked',
      entity: 'invitation',
      entityId: idString(doc._id),
      before: { state: 'PENDING' },
      after: { state: 'REVOKED', reason: options.reason ?? 'sample unlocked' },
      orgId: acoId,
    });
  }
  return pending.length;
}

// --- activation -----------------------------------------------------------------

export interface ActivateOptions {
  ctx?: AnyContext | undefined;
  now?: Date | undefined;
}

export interface ActivateResult {
  sent: number;
  /** PENDING invitations whose participant is not LOCKED (they wait for the lock). */
  skipped: number;
}

/**
 * Gives every PENDING invitation of a LOCKED participant its token and sends
 * the invitation e-mail. Runs from the `cycle.transitioned` → ASSESSMENT_OPEN
 * listener and from the `invitations.activate` safety net; `once()` per
 * invitation makes both idempotent.
 */
export async function activateCycle(cycleId: string, options: ActivateOptions = {}): Promise<ActivateResult> {
  const ctx = options.ctx ?? systemContext(`invitations.activate ${cycleId}`);
  const now = options.now ?? new Date();
  const cycle = await requireCycle(ctx, cycleId);
  const pending = await InvitationModel.find({ cycleId: toId(cycleId), state: 'PENDING' }).sort({ acoId: 1, _id: 1 }).lean<InvitationDoc[]>();
  const result: ActivateResult = { sent: 0, skipped: 0 };
  const lockedByAco = new Map<string, boolean>();
  for (const invitation of pending) {
    const acoId = idString(invitation.acoId);
    let locked = lockedByAco.get(acoId);
    if (locked === undefined) {
      locked = (await participantFacts(cycleId, acoId))?.samplingStatus === 'LOCKED';
      lockedByAco.set(acoId, locked);
    }
    if (!locked) {
      result.skipped += 1;
      continue;
    }
    const ran = await once('invitation.send', idString(invitation._id), 'activate', async () => {
      const sent = await issueToken(ctx, invitation, cycle, now, 'SEND');
      return sent ? `sent to ${maskEmail(invitation.email)}` : 'state changed; nothing sent';
    });
    if (ran.ran) result.sent += 1;
  }
  return result;
}

/** The safety net: every cycle with PENDING invitations that is already ASSESSMENT_OPEN. */
export async function activateOpenCycles(now: Date): Promise<ActivateResult> {
  const ctx = systemContext('scheduler: invitations.activate');
  const total: ActivateResult = { sent: 0, skipped: 0 };
  for (const cycleId of await distinctCycleIds({ state: 'PENDING' })) {
    const cycle = await cycleFacts(ctx, cycleId);
    if (cycle?.status !== 'ASSESSMENT_OPEN') continue;
    const result = await activateCycle(cycleId, { ctx, now });
    total.sent += result.sent;
    total.skipped += result.skipped;
  }
  return total;
}

/**
 * New token, state SENT, invitation e-mail. SEND (activation) also announces
 * `invitation.sent` so cycles counts the participant's `stats.invited`;
 * RESEND does not, the participant was already counted. Returns false when
 * the invitation changed state underneath (someone else got there first).
 */
async function issueToken(ctx: AnyContext, invitation: InvitationDoc, cycle: CycleFacts, now: Date, event: 'SEND' | 'RESEND'): Promise<boolean> {
  const next = transition(invitation.state, event);
  if (!next.ok) throw new AppError('PRECONDITION_FAILED', next.reason);
  const token = generateToken();
  const updated = await InvitationModel.findOneAndUpdate(
    { _id: invitation._id, state: invitation.state },
    { $set: { tokenHash: hashToken(token), previousTokenHashes: [], state: next.state, sentAt: now, expiresAt: cycle.assessment.end, otp: EMPTY_OTP } },
    { new: true },
  ).lean<InvitationDoc>();
  if (!updated) return false;

  const mail = await mailContext(updated, cycle);
  await send({
    template: 'assessment-invitation',
    to: updated.email,
    vars: { ...mail, url: invitationLink(token) },
    refs: { cycleId: idString(updated.cycleId), acoId: idString(updated.acoId), customerId: idString(updated.customerId), invitationId: idString(updated._id) },
  });
  const invitationId = idString(updated._id);
  await audit(requestContextOf(ctx), {
    action: event === 'SEND' ? 'invitation.sent' : 'invitation.resent',
    entity: 'invitation',
    entityId: invitationId,
    before: { state: invitation.state },
    after: { state: updated.state, emailMasked: maskEmail(updated.email), sentAt: now.toISOString(), expiresAt: updated.expiresAt.toISOString() },
    orgId: idString(updated.acoId),
  });
  if (event === 'SEND') {
    await emit('invitation.sent', { invitationId, cycleId: idString(updated.cycleId), acoId: idString(updated.acoId) }, { ctx });
  }
  return true;
}

// --- reminders --------------------------------------------------------------------

export interface ReminderOptions {
  ctx?: AnyContext | undefined;
  /** True for the clock: only reminders whose scheduled instant has passed. A manual run sends the next one now. */
  dueOnly?: boolean | undefined;
  acoId?: string | undefined;
}

export interface ReminderResult {
  sent: number;
}

/**
 * Reminder k of the cycle's assessment schedule (`deriveReminderSchedule`) to
 * every SENT / OPENED / VERIFIED invitation with `remindersSent === k`.
 * `once()` per invitation + index means a tick, a retry or a second instance
 * never sends the same reminder twice; submitting, revoking or expiring stops them.
 */
export async function sendReminders(cycleId: string, now: Date, options: ReminderOptions = {}): Promise<ReminderResult> {
  const ctx = options.ctx ?? systemContext(`invitations.reminders ${cycleId}`);
  const cycle = await requireCycle(ctx, cycleId);
  const schedule = deriveReminderSchedule(cycle.assessment, cycle.reminders.assessment, { tz: cycle.tz });
  const filter: FilterQuery<InvitationDoc> = { cycleId: toId(cycleId), state: { $in: [...REMINDABLE_STATES] } };
  if (options.acoId) filter.acoId = toId(options.acoId, 'acoId');
  const candidates = await InvitationModel.find(filter).sort({ _id: 1 }).lean<InvitationDoc[]>();

  const result: ReminderResult = { sent: 0 };
  for (const invitation of candidates) {
    if (isExpired(invitation, now)) continue;
    const index = options.dueOnly === true ? dueReminderIndex(schedule, invitation.remindersSent, now) : invitation.remindersSent;
    if (index === null) continue;
    const ran = await once('invitation.reminder', idString(invitation._id), String(index), async () => {
      await sendReminder(invitation, cycle, index, now);
      return `reminder ${index + 1} to ${maskEmail(invitation.email)}`;
    });
    if (ran.ran) result.sent += 1;
    else if (invitation.remindersSent <= index) {
      // The slot was taken (another instance, or a crash after sending): keep the counter moving.
      await InvitationModel.updateOne({ _id: invitation._id, remindersSent: { $lte: index } }, { $set: { remindersSent: index + 1 } });
    }
  }
  return result;
}

/**
 * The schedule index to send now, or null. When several reminders are
 * overdue (the server was down), only the latest is sent: one e-mail, not a burst.
 */
function dueReminderIndex(schedule: readonly string[], sent: number, now: Date): number | null {
  let chosen = nextReminder(schedule, sent, now);
  if (!chosen?.due) return null;
  for (;;) {
    const following = nextReminder(schedule, chosen.index + 1, now);
    if (!following?.due) return chosen.index;
    chosen = following;
  }
}

async function sendReminder(invitation: InvitationDoc, cycle: CycleFacts, index: number, now: Date): Promise<void> {
  // The reminder carries a link of its own (the raw token is never stored, so the
  // first one cannot be repeated). The earlier links stay valid, a session in
  // progress is bound to the invitation rather than the token, and the OTP hash is
  // scoped by the invitation id, so a code in flight keeps working too.
  const current = await InvitationModel.findById(invitation._id).lean<InvitationDoc>();
  if (!current || !canReceiveReminder(current.state) || current.tokenHash === null) return;
  const token = generateToken();
  const updated = await InvitationModel.findOneAndUpdate(
    { _id: current._id, state: current.state, tokenHash: current.tokenHash },
    { $set: { tokenHash: hashToken(token), remindersSent: index + 1, lastReminderAt: now }, $push: { previousTokenHashes: current.tokenHash } },
    { new: true },
  ).lean<InvitationDoc>();
  if (!updated) return;
  const mail = await mailContext(updated, cycle);
  await send({
    template: 'assessment-reminder',
    to: updated.email,
    vars: { contactName: mail.contactName, operatorName: mail.operatorName, cycleName: mail.cycleName, assessmentEnd: mail.assessmentEnd, url: invitationLink(token), reminderNumber: index + 1 },
    refs: { cycleId: idString(updated.cycleId), acoId: idString(updated.acoId), customerId: idString(updated.customerId), invitationId: idString(updated._id) },
  });
}

/** The clock: reminders for every ASSESSMENT_OPEN cycle that still has reminder-able invitations. */
export async function sendDueReminders(now: Date): Promise<ReminderResult> {
  const ctx = systemContext('scheduler: invitations.reminders');
  const total: ReminderResult = { sent: 0 };
  for (const cycleId of await distinctCycleIds({ state: { $in: [...REMINDABLE_STATES] } })) {
    const cycle = await cycleFacts(ctx, cycleId);
    if (cycle?.status !== 'ASSESSMENT_OPEN') continue;
    total.sent += (await sendReminders(cycleId, now, { ctx, dueOnly: true })).sent;
  }
  return total;
}

// --- expiry ------------------------------------------------------------------------

export interface ExpireResult {
  expired: number;
  /** Invitations whose `expiresAt` moved because the cycle's assessment end was extended. */
  extended: number;
}

/**
 * Live invitations past `expiresAt` become EXPIRED — unless the cycle's
 * assessment end has moved later (ACFI extended the window), in which case
 * they follow it instead.
 */
export async function expireDue(now: Date): Promise<ExpireResult> {
  const ctx = systemContext('scheduler: invitations.expire');
  const result: ExpireResult = { expired: 0, extended: 0 };
  const live: FilterQuery<InvitationDoc> = { state: { $in: [...EXPIRABLE_STATES] } };
  for (const cycleId of await distinctCycleIds({ ...live, expiresAt: { $lte: now } })) {
    const cycle = await cycleFacts(ctx, cycleId);
    const scope = and<InvitationDoc>(live, { cycleId: toId(cycleId) });
    if (cycle && cycle.assessment.end.getTime() > now.getTime()) {
      const moved = await InvitationModel.updateMany(and<InvitationDoc>(scope, { expiresAt: { $ne: cycle.assessment.end } }), { $set: { expiresAt: cycle.assessment.end } });
      result.extended += moved.modifiedCount;
      continue;
    }
    const expired = await InvitationModel.updateMany(and<InvitationDoc>(scope, { expiresAt: { $lte: now } }), { $set: { state: 'EXPIRED', expiredAt: now } });
    result.expired += expired.modifiedCount;
    if (expired.modifiedCount > 0) logger.info({ cycleId, expired: expired.modifiedCount }, 'Invitations expired');
  }
  return result;
}

// --- submission ---------------------------------------------------------------------

/** `assessment.submitted` (CUSTOMER): VERIFIED → SUBMITTED; already SUBMITTED is a no-op. */
export async function markSubmitted(invitationId: string, options: HandlerOptions = {}): Promise<InvitationDoc> {
  const invitation = await InvitationModel.findById(toId(invitationId, 'invitationId'))
    .session(options.session ?? null)
    .lean<InvitationDoc>();
  if (!invitation) throw new AppError('NOT_FOUND', 'Invitation not found');
  if (invitation.state === 'SUBMITTED') return invitation;
  const next = transition(invitation.state, 'SUBMIT');
  if (!next.ok) throw new AppError('PRECONDITION_FAILED', next.reason);
  const updated = await InvitationModel.findOneAndUpdate(
    { _id: invitation._id, state: invitation.state },
    { $set: { state: 'SUBMITTED', submittedAt: new Date() } },
    { new: true, ...(options.session ? { session: options.session } : {}) },
  ).lean<InvitationDoc>();
  return updated ?? invitation;
}

/** `markSubmitted` plus the thank-you e-mail, sent once (the first call that changes the state). */
export async function completeInvitation(invitationId: string, options: HandlerOptions = {}): Promise<InvitationDoc> {
  const ctx = options.ctx ?? systemContext(`event: assessment.submitted ${invitationId}`);
  const before = await InvitationModel.findById(toId(invitationId, 'invitationId'))
    .session(options.session ?? null)
    .lean<InvitationDoc>();
  const invitation = await markSubmitted(invitationId, options);
  if (before?.state === 'SUBMITTED') return invitation;
  const cycle = await requireCycle(ctx, idString(invitation.cycleId));
  const mail = await mailContext(invitation, cycle);
  await send({
    template: 'assessment-thank-you',
    to: invitation.email,
    vars: { contactName: mail.contactName, operatorName: mail.operatorName, cycleName: mail.cycleName },
    refs: { cycleId: idString(invitation.cycleId), acoId: idString(invitation.acoId), customerId: idString(invitation.customerId), invitationId },
  });
  return invitation;
}

// --- signed-in: list, resend, revoke ---------------------------------------------------

/** PLATFORM sees all; an operator its own; an airport organisation its airport's operators. */
export function invitationScopeFilter(ctx: RequestContext): FilterQuery<InvitationDoc> {
  switch (ctx.scope.kind) {
    case 'PLATFORM':
      return {};
    case 'ACO':
      return { acoId: toId(ctx.scope.acoId) };
    case 'AIRPORT':
      return { airportId: toId(ctx.scope.airportId) };
  }
}

const SORTABLE = ['createdAt', 'state', 'sentAt', 'submittedAt', 'email', 'remindersSent'] as const;

export async function listInvitations(ctx: RequestContext, query: InvitationListQuery): Promise<Page<InvitationDto>> {
  const requested: FilterQuery<InvitationDoc> = {};
  if (query.cycleId) requested.cycleId = toId(query.cycleId);
  if (query.acoId) requested.acoId = toId(query.acoId);
  if (query.state) requested.state = query.state;
  if (query.surveyType) requested.surveyType = query.surveyType;
  const filter = and<InvitationDoc>(invitationScopeFilter(ctx), searchFilter<InvitationDoc>(query.q, ['email', 'customer.name']), requested);
  const sort = parseSort(query.sort, SORTABLE, '-createdAt');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    InvitationModel.find(filter).sort(sort).skip(skip).limit(limit).lean<InvitationDoc[]>(),
    InvitationModel.countDocuments(filter),
  ]);
  return pageOf(docs.map(toInvitationDto), total, query);
}

async function requireVisibleInvitation(ctx: RequestContext, id: string): Promise<InvitationDoc> {
  const doc = await InvitationModel.findOne(and<InvitationDoc>(invitationScopeFilter(ctx), { _id: toId(id) })).lean<InvitationDoc>();
  if (!doc) throw new AppError('NOT_FOUND', 'Invitation not found');
  return doc;
}

/**
 * `POST /invitations/:id/resend`: a new token (the old link and any session
 * die), state SENT, the invitation e-mail again. Only while the assessment is
 * open; an EXPIRED invitation comes back when the window was extended.
 */
export async function resendInvitation(ctx: RequestContext, id: string): Promise<InvitationDto> {
  const invitation = await requireVisibleInvitation(ctx, id);
  const cycle = await requireCycle(ctx, idString(invitation.cycleId));
  if (cycle.status !== 'ASSESSMENT_OPEN') {
    throw new AppError('PRECONDITION_FAILED', 'The assessment is not open for this cycle', { cycleStatus: cycle.status });
  }
  const now = new Date();
  if (cycle.assessment.end.getTime() <= now.getTime()) throw new AppError('PRECONDITION_FAILED', 'The assessment window has ended');
  const sent = await issueToken(ctx, invitation, cycle, now, 'RESEND');
  if (!sent) throw new AppError('CONFLICT', 'The invitation changed; reload and try again');
  return toInvitationDto(await requireVisibleInvitation(ctx, id));
}

/** `POST /invitations/:id/revoke`: the link stops working; terminal. */
export async function revokeInvitation(ctx: RequestContext, id: string): Promise<InvitationDto> {
  const invitation = await requireVisibleInvitation(ctx, id);
  const next = transition(invitation.state, 'REVOKE');
  if (!next.ok) throw new AppError('PRECONDITION_FAILED', next.reason);
  const updated = await InvitationModel.findOneAndUpdate(
    { _id: invitation._id, state: invitation.state },
    { $set: { state: 'REVOKED', revokedAt: new Date() } },
    { new: true },
  ).lean<InvitationDoc>();
  if (!updated) throw new AppError('CONFLICT', 'The invitation changed; reload and try again');
  await audit(ctx, {
    action: 'invitation.revoked',
    entity: 'invitation',
    entityId: idString(updated._id),
    before: { state: invitation.state },
    after: { state: updated.state, reason: 'revoked by operator' },
    orgId: idString(updated.acoId),
  });
  return toInvitationDto(updated);
}

// --- helpers ------------------------------------------------------------------------------

async function distinctCycleIds(filter: FilterQuery<InvitationDoc>): Promise<string[]> {
  const ids = await InvitationModel.distinct('cycleId', filter);
  return ids.map((id) => idString(id));
}
