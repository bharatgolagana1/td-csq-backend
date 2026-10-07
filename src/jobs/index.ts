import { scheduler } from '../core/scheduler.js';

import { cyclesSamplingReminders, cyclesTransitions } from './cycles.jobs.js';
import { heartbeat } from './heartbeat.job.js';
import { invitationsActivate, invitationsExpire, invitationsReminders } from './invitations.jobs.js';
import { scoringFinalise, scoringNightly } from './scoring.jobs.js';

/**
 * Registers every job runner. A module that needs the clock (cycles,
 * invitations, scoring) adds its runner here: `scheduler.registerJob('cycles.transitions', runner)`.
 * Runners execute every minute in this order; use `once()` inside them.
 */
export function registerJobs(): void {
  scheduler.registerJob('heartbeat', heartbeat);
  scheduler.registerJob('cycles.transitions', cyclesTransitions);
  scheduler.registerJob('cycles.samplingReminders', cyclesSamplingReminders);
  scheduler.registerJob('invitations.activate', invitationsActivate);
  scheduler.registerJob('invitations.reminders', invitationsReminders);
  scheduler.registerJob('invitations.expire', invitationsExpire);
  scheduler.registerJob('scoring.nightly', scoringNightly);
  scheduler.registerJob('scoring.finalise', scoringFinalise);
}
