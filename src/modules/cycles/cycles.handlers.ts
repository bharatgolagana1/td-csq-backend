// What cycles listens to (WAVE1-BRIEF §2 "Who listens to what") and the hook
// it registers into organisations. Called once per process by the registry.
import { systemContext } from '../../core/auth/system.js';
import { AppError } from '../../core/errors.js';
import { on, type EventMeta } from '../../core/events.js';
import { logger } from '../../core/logger.js';
import { registerMarketShareFreezeCheck } from '../organisations/market-share.service.js';

import { mailCyclePublished, mailSamplingClosed } from './cycles.notify.js';
import { findCycleDoc, isMarketShareFrozen, transition } from './cycles.service.js';
import { bumpParticipantStats, listParticipantDocs, setSelfAssessmentStatus } from './participants.service.js';

/** Stats are derived data: a missing participant is logged, never allowed to fail a submission. */
async function tolerateMissingParticipant(work: () => Promise<unknown>, context: Record<string, unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') {
      logger.warn({ ...context, err: error }, 'Participant stats not updated: participant not found');
      return;
    }
    throw error;
  }
}

export function registerCycleHandlers(): void {
  registerMarketShareFreezeCheck(isMarketShareFrozen);

  on('assessment.submitted', 'cycles.onAssessmentSubmitted', async (payload, meta: EventMeta) => {
    await tolerateMissingParticipant(
      () =>
        payload.kind === 'CUSTOMER'
          ? bumpParticipantStats(payload.cycleId, payload.acoId, 'completed', 1, meta.session)
          : setSelfAssessmentStatus(payload.cycleId, payload.acoId, payload.surveyType, 'SUBMITTED', meta.session),
      { event: 'assessment.submitted', cycleId: payload.cycleId, acoId: payload.acoId },
    );
  });

  on('invitation.sent', 'cycles.onInvitationSent', async (payload, meta: EventMeta) => {
    await tolerateMissingParticipant(() => bumpParticipantStats(payload.cycleId, payload.acoId, 'invited', 1, meta.session), {
      event: 'invitation.sent',
      cycleId: payload.cycleId,
      acoId: payload.acoId,
    });
  });

  on('scoring.completed', 'cycles.onScoringCompleted', async (payload) => {
    if (payload.provisional) return;
    const cycle = await findCycleDoc(payload.cycleId);
    if (cycle?.status !== 'ASSESSMENT_CLOSED') return;
    await transition(systemContext('event: scoring.completed'), payload.cycleId, 'SCORED', 'Scoring run completed', { trigger: 'CLOCK' });
  });

  on('cycle.transitioned', 'cycles.onTransitioned', async (payload) => {
    // Sampling opens (clock, manual, or an ACFI re-open): mail the admins of every operator
    // that has not locked. Publishing straight into SAMPLING_OPEN already mailed them.
    if (payload.to === 'SAMPLING_OPEN' && payload.from !== 'DRAFT') {
      const cycle = await findCycleDoc(payload.cycleId);
      if (cycle) await mailCyclePublished(cycle, await listParticipantDocs(cycle._id, { 'sampling.status': { $ne: 'LOCKED' } }), true);
    }
    if (payload.to === 'SAMPLING_CLOSED') {
      const cycle = await findCycleDoc(payload.cycleId);
      if (cycle) await mailSamplingClosed(cycle, await listParticipantDocs(cycle._id, { 'sampling.status': { $ne: 'LOCKED' } }));
    }
  });
}
