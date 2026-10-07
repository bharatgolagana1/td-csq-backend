// Sampling reminders (REQUIREMENTS §19): the schedule comes from the domain
// (`deriveReminderSchedule`), the clock sends reminder k to every participant
// that has not locked and has sent fewer than k+1, and ACFI can run one by
// hand. Assessment reminders belong to the invitations module, which plugs
// its sender in through `registerAssessmentReminderSender`.
import type { Logger } from 'pino';

import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';
import { idString } from '../../core/ids.js';
import { logger } from '../../core/logger.js';
import { once } from '../../core/scheduler.js';

import { CycleParticipantModel, type CycleParticipantDoc } from './cycle-participants.model.js';
import type { CycleDoc } from './cycles.model.js';
import { mailSamplingReminder } from './cycles.notify.js';
import type { ReminderRunDto, SendRemindersInput } from './cycles.schemas.js';
import { findCyclesByStatus, requireVisibleCycle } from './cycles.service.js';
import { deriveReminderSchedule, nextReminder, type NextReminder } from './domain/derive.js';
import { findParticipantDoc, listParticipantDocs, recordReminderSent } from './participants.service.js';

export const SAMPLING_REMINDER_JOB = 'cycles.samplingReminders';

/** Reminder instants (ISO UTC) for a cycle's sampling window; nothing before the publish instant. */
export function samplingReminderSchedule(cycle: CycleDoc): string[] {
  return deriveReminderSchedule(cycle.sampling, cycle.reminders.sampling, {
    tz: cycle.tz,
    ...(cycle.publishedAt ? { now: cycle.publishedAt } : {}),
  });
}

/** The reminder to send now, or null. When several are overdue (downtime) only the latest goes out. */
export function dueSamplingReminder(schedule: readonly string[], sent: number, now: Date): NextReminder | null {
  let due: NextReminder | null = null;
  let cursor = sent;
  for (;;) {
    const next = nextReminder(schedule, cursor, now);
    if (!next?.due) return due;
    due = next;
    cursor = next.index + 1;
  }
}

const NOT_LOCKED = { 'sampling.status': { $ne: 'LOCKED' } } as const;

/** One scheduler tick: every SAMPLING_OPEN cycle, every unlocked participant, `once()` per participant + reminder index. */
export async function runSamplingReminders(now: Date, log: Logger = logger): Promise<{ sent: number }> {
  let sent = 0;
  for (const cycle of await findCyclesByStatus(['SAMPLING_OPEN'])) {
    const schedule = samplingReminderSchedule(cycle);
    if (schedule.length === 0) continue;
    for (const participant of await listParticipantDocs(cycle._id, NOT_LOCKED)) {
      const due = dueSamplingReminder(schedule, participant.reminders.sent, now);
      if (due === null) continue;
      const refId = `${idString(cycle._id)}:${idString(participant.acoId)}`;
      try {
        const result = await once(SAMPLING_REMINDER_JOB, refId, String(due.index), async () => {
          const mail = await mailSamplingReminder(cycle, participant, now);
          await recordReminderSent(participant._id, due.index + 1, now);
          return `reminder ${due.index + 1}/${schedule.length} to ${mail.to.join(', ') || 'nobody (no ACO admins)'}`;
        });
        if (result.ran) sent += 1;
      } catch (error) {
        log.error({ err: error, cycleId: idString(cycle._id), acoId: idString(participant.acoId) }, 'Sampling reminder failed');
      }
    }
  }
  return { sent };
}

// --- assessment reminders: the invitations module's ------------------------

export type AssessmentReminderSender = (cycleId: string, now: Date, acoId?: string) => Promise<{ sent: number }>;

let assessmentReminderSender: AssessmentReminderSender | null = null;

/** Invitations registers its `sendReminders` here at boot; until then `kind: ASSESSMENT` answers 412. Returns the previous sender. */
export function registerAssessmentReminderSender(sender: AssessmentReminderSender | null): AssessmentReminderSender | null {
  const previous = assessmentReminderSender;
  assessmentReminderSender = sender;
  return previous;
}

export function hasAssessmentReminderSender(): boolean {
  return assessmentReminderSender !== null;
}

// --- manual run ------------------------------------------------------------

async function unlockedParticipants(cycle: CycleDoc, acoId: string | undefined): Promise<CycleParticipantDoc[]> {
  if (acoId === undefined) return listParticipantDocs(cycle._id, NOT_LOCKED);
  const participant = await findParticipantDoc(cycle._id, acoId);
  if (!participant) throw new AppError('NOT_FOUND', 'Participant not found', { acoId });
  if (participant.sampling.status === 'LOCKED') {
    throw new AppError('PRECONDITION_FAILED', 'This operator has already locked its sample', { acoId });
  }
  return [participant];
}

/**
 * `POST /cycles/:id/reminders/send`. SAMPLING: mails every unlocked participant
 * (or one) now without consuming the scheduled count. ASSESSMENT: forwarded to
 * the sender the invitations module registered; 412 while none is registered.
 */
export async function sendRemindersNow(ctx: RequestContext, cycleId: string, input: SendRemindersInput, now = new Date()): Promise<ReminderRunDto> {
  const cycle = await requireVisibleCycle(ctx, cycleId);
  if (input.kind === 'ASSESSMENT') {
    if (assessmentReminderSender === null) {
      throw new AppError('PRECONDITION_FAILED', 'Assessment reminders are sent by the invitations module, which has not registered a sender', { kind: 'ASSESSMENT' });
    }
    const result = await assessmentReminderSender(cycleId, now, input.acoId);
    return { kind: 'ASSESSMENT', sent: result.sent, recipients: [] };
  }
  if (cycle.status !== 'SAMPLING_OPEN') {
    throw new AppError('PRECONDITION_FAILED', `Sampling reminders can only be sent while sampling is open (cycle is ${cycle.status})`, { status: cycle.status });
  }
  const participants = await unlockedParticipants(cycle, input.acoId);
  const recipients: ReminderRunDto['recipients'] = [];
  let sent = 0;
  for (const participant of participants) {
    const mail = await mailSamplingReminder(cycle, participant, now);
    await CycleParticipantModel.updateOne({ _id: participant._id }, { $set: { 'reminders.lastAt': now } });
    recipients.push(mail);
    sent += mail.to.length;
  }
  return { kind: 'SAMPLING', sent, recipients: recipients.map((r) => ({ acoId: r.acoId, to: r.to })) };
}
