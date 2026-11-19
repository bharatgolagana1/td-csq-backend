// Who cycles e-mails (ACO admins of a participating operator) and the
// cycle-level mails themselves: publish / sampling open, sampling closed,
// sampling reminder. Composed from identity's and organisations' exported
// functions; never their models.
import type { Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { idString } from '../../core/ids.js';
import { once } from '../../core/scheduler.js';
import { audit } from '../audit/audit.service.js';
import { listActiveUserIdsInOrg, listMembershipsForUsers } from '../identity/memberships.service.js';
import { findUserById } from '../identity/users.service.js';
import { send } from '../notifications/notifications.service.js';
import type { OrganisationDoc } from '../organisations/organisations.model.js';
import { findOrganisationsByIds } from '../organisations/organisations.service.js';

import { CycleParticipantModel, type CycleParticipantDoc } from './cycle-participants.model.js';
import type { CycleDoc } from './cycles.model.js';
import type { SurveyType, WallClock } from './domain/types.js';

export const ACO_ADMIN_ROLE = 'ACO_ADMIN';

export interface Recipient {
  userId: string;
  email: string;
  name: string;
}

/** Active, non-suspended ACO_ADMIN members of an operator. */
export async function acoAdminRecipients(acoId: string | Types.ObjectId): Promise<Recipient[]> {
  const userIds = await listActiveUserIdsInOrg(acoId);
  if (userIds.length === 0) return [];
  const memberships = await listMembershipsForUsers(userIds);
  const admins = userIds.filter((userId) =>
    (memberships.get(idString(userId)) ?? []).some(
      (m) => m.orgId === idString(acoId) && m.roleCode === ACO_ADMIN_ROLE && m.status === 'ACTIVE',
    ),
  );
  const recipients: Recipient[] = [];
  for (const userId of admins) {
    const user = await findUserById(userId);
    if (!user || user.status === 'SUSPENDED') continue;
    recipients.push({ userId: idString(user._id), email: user.email, name: user.name });
  }
  return recipients;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-07T00:00` → `07 Oct 2026, 00:00` (already in the cycle's zone). */
export function formatWall(wall: WallClock): string {
  const [date = '', time = ''] = wall.split('T');
  const [year = '', month = '01', day = ''] = date.split('-');
  return `${day} ${MONTHS[Number(month) - 1] ?? month} ${year}, ${time}`;
}

export function describeSurveyTypes(types: readonly SurveyType[]): string {
  const names = types.map((type) => (type === 'DOMESTIC' ? 'Domestic' : 'International'));
  return names.join(' and ') || 'Cargo';
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days (rounded up, never below 0) from `now` to `end`. */
export function daysUntil(end: Date, now: Date): number {
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
}

export interface MailResult {
  sent: number;
  recipients: { acoId: string; to: string[] }[];
}

async function operatorsOf(participants: CycleParticipantDoc[]): Promise<Map<string, OrganisationDoc>> {
  return findOrganisationsByIds(participants.map((p) => p.acoId));
}

/** `cycle-published` to every ACO admin of every participant; `samplingOpenNow` switches the wording. */
export async function mailCyclePublished(cycle: CycleDoc, participants: CycleParticipantDoc[], samplingOpenNow: boolean): Promise<MailResult> {
  const operators = await operatorsOf(participants);
  const result: MailResult = { sent: 0, recipients: [] };
  for (const participant of participants) {
    const operator = operators.get(idString(participant.acoId));
    const to: string[] = [];
    for (const admin of await acoAdminRecipients(participant.acoId)) {
      await send({
        template: 'cycle-published',
        to: admin.email,
        vars: {
          adminName: admin.name,
          operatorName: operator?.name ?? 'your organisation',
          cycleName: cycle.name,
          cycleCode: cycle.code,
          samplingStart: formatWall(cycle.sampling.start.wall),
          samplingEnd: formatWall(cycle.sampling.end.wall),
          assessmentStart: formatWall(cycle.assessment.start.wall),
          assessmentEnd: formatWall(cycle.assessment.end.wall),
          tz: cycle.tz,
          requiredSampleSize: participant.requiredSampleSize,
          surveyTypes: describeSurveyTypes(participant.surveyTypes),
          samplingOpenNow,
        },
        refs: { cycleId: idString(cycle._id), acoId: idString(participant.acoId), userId: admin.userId },
      });
      to.push(admin.email);
      result.sent += 1;
    }
    result.recipients.push({ acoId: idString(participant.acoId), to });
  }
  return result;
}

/** `sampling-closed` to the ACO admins of participants that have not locked. */
export async function mailSamplingClosed(cycle: CycleDoc, participants: CycleParticipantDoc[]): Promise<MailResult> {
  const operators = await operatorsOf(participants);
  const result: MailResult = { sent: 0, recipients: [] };
  for (const participant of participants) {
    const operator = operators.get(idString(participant.acoId));
    const to: string[] = [];
    for (const admin of await acoAdminRecipients(participant.acoId)) {
      await send({
        template: 'sampling-closed',
        to: admin.email,
        vars: {
          adminName: admin.name,
          operatorName: operator?.name ?? 'your organisation',
          cycleName: cycle.name,
          samplingEnd: formatWall(cycle.sampling.end.wall),
          tz: cycle.tz,
          required: participant.requiredSampleSize,
          selected: participant.sampling.selectedCount,
        },
        refs: { cycleId: idString(cycle._id), acoId: idString(participant.acoId), userId: admin.userId },
      });
      to.push(admin.email);
      result.sent += 1;
    }
    result.recipients.push({ acoId: idString(participant.acoId), to });
  }
  return result;
}

/** Thrown inside a manual reminder's `once()` slot so the slot is FAILED and a later send retries it. */
class ReminderDeliveryFailed extends Error {}

const MANUAL_REMINDER_SLOT_MS = 12 * 60 * 60 * 1000;

/**
 * One `sampling-reminder` run for one participant: "closes in N days ·
 * selected / required". `to` lists the admins mailed, `failed` those whose
 * delivery failed (the notification history holds the error).
 *
 * The clock's run (no `ctx`) makes one attempt per admin, as `once()` per
 * scheduled reminder already guarantees. A manual run (`ctx`) claims a
 * `once()` slot per admin and UTC half-day: a repeated send in that half-day
 * skips the admins already mailed and retries only failed ones, and every
 * attempt is audited.
 */
export async function mailSamplingReminder(
  cycle: CycleDoc,
  participant: CycleParticipantDoc,
  now: Date,
  ctx?: RequestContext,
): Promise<{ acoId: string; to: string[]; failed: string[] }> {
  const operator = (await operatorsOf([participant])).get(idString(participant.acoId));
  const acoId = idString(participant.acoId);
  const to: string[] = [];
  const failed: string[] = [];
  for (const admin of await acoAdminRecipients(participant.acoId)) {
    const mail = () => send({
      template: 'sampling-reminder',
      to: admin.email,
      vars: {
        adminName: admin.name,
        operatorName: operator?.name ?? 'your organisation',
        cycleName: cycle.name,
        closesInDays: daysUntil(cycle.sampling.end.utc, now),
        samplingEnd: formatWall(cycle.sampling.end.wall),
        tz: cycle.tz,
        required: participant.requiredSampleSize,
        selected: participant.sampling.selectedCount,
      },
      refs: { cycleId: idString(cycle._id), acoId, userId: admin.userId },
    });
    if (!ctx) {
      const notification = await mail();
      (notification.status === 'SENT' ? to : failed).push(admin.email);
      continue;
    }
    try {
      const result = await once(
        'cycles.manualSamplingReminder',
        `${idString(cycle._id)}:${acoId}:${admin.email.trim().toLowerCase()}`,
        String(Math.floor(now.getTime() / MANUAL_REMINDER_SLOT_MS)),
        async () => {
          const notification = await mail();
          await audit(ctx, {
            action: notification.status === 'SENT' ? 'sampling.reminder.sent' : 'sampling.reminder.failed',
            entity: 'notification',
            entityId: notification.id,
            orgId: acoId,
            after: { cycleId: idString(cycle._id), to: notification.to, status: notification.status },
          });
          if (notification.status !== 'SENT') throw new ReminderDeliveryFailed(`Delivery failed (notification ${notification.id})`);
          // Recorded per admin, so a later failure in this run does not hide this success.
          await CycleParticipantModel.updateOne({ _id: participant._id }, { $max: { 'reminders.lastAt': now, 'reminders.manualAt': now } });
          return notification.id;
        },
      );
      if (result.ran) to.push(admin.email);
    } catch (error) {
      if (!(error instanceof ReminderDeliveryFailed)) throw error;
      failed.push(admin.email);
    }
  }
  return { acoId, to, failed };
}
