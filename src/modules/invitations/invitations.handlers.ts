// What invitations listens to (WAVE1-BRIEF §2 "Who listens to what") and the
// hook it registers into cycles. Called once per process by the registry.
import { on, type EventMeta } from '../../core/events.js';
import { registerAssessmentReminderSender } from '../cycles/reminders.service.js';

import { activateCycle, completeInvitation, createPendingForSamples, revokePending, sendReminders } from './invitations.service.js';

export function registerInvitationHandlers(): void {
  // `POST /cycles/:id/reminders/send` with `kind: ASSESSMENT` sends the next reminder now.
  registerAssessmentReminderSender((cycleId, now, acoId) => sendReminders(cycleId, now, { acoId }));

  // Inside the lock transaction: one PENDING invitation per locked sample, or the lock rolls back.
  on('sample.locked', 'invitations.onSampleLocked', async (payload, meta: EventMeta) => {
    await createPendingForSamples(payload, { ctx: meta.ctx, session: meta.session });
  });

  // Inside the unlock transaction: what was never sent is withdrawn; sent links keep working.
  on('sample.unlocked', 'invitations.onSampleUnlocked', async (payload, meta: EventMeta) => {
    await revokePending(payload.cycleId, payload.acoId, { ctx: meta.ctx, session: meta.session, reason: payload.reason });
  });

  // The assessment opens: tokens and e-mails for every PENDING invitation of a LOCKED participant.
  on('cycle.transitioned', 'invitations.onCycleTransitioned', async (payload, meta: EventMeta) => {
    if (payload.to !== 'ASSESSMENT_OPEN') return;
    await activateCycle(payload.cycleId, { ctx: meta.ctx });
  });

  // A participant submitted (inside assessments' transaction): SUBMITTED + thank-you; SELF assessments are not ours.
  on('assessment.submitted', 'invitations.onAssessmentSubmitted', async (payload, meta: EventMeta) => {
    if (payload.kind !== 'CUSTOMER' || payload.invitationId === undefined) return;
    await completeInvitation(payload.invitationId, { ctx: meta.ctx, session: meta.session });
  });
}
