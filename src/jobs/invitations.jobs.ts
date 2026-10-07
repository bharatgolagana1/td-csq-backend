import type { JobRunner } from '../core/scheduler.js';
import { activateOpenCycles, expireDue, sendDueReminders } from '../modules/invitations/invitations.service.js';

/**
 * Safety net for the `cycle.transitioned` → ASSESSMENT_OPEN listener: PENDING
 * invitations of a cycle that is already ASSESSMENT_OPEN (a listener that
 * failed, or a sample locked after the assessment opened) get their token and
 * e-mail. `once('invitation.send', invitationId, 'activate')` inside.
 */
export const invitationsActivate: JobRunner = async ({ now, log }) => {
  const { sent, skipped } = await activateOpenCycles(now);
  if (sent > 0 || skipped > 0) log.info({ sent, skipped }, 'Invitations activated by the safety net');
};

/** Assessment reminders on the cycle's derived schedule; `once('invitation.reminder', invitationId, index)` inside. */
export const invitationsReminders: JobRunner = async ({ now, log }) => {
  const { sent } = await sendDueReminders(now);
  if (sent > 0) log.info({ sent }, 'Assessment reminders sent');
};

/** Live invitations past `expiresAt` become EXPIRED (or follow an extended window); idempotent by construction. */
export const invitationsExpire: JobRunner = async ({ now, log }) => {
  const { expired, extended } = await expireDue(now);
  if (expired > 0 || extended > 0) log.info({ expired, extended }, 'Invitation expiry run');
};
