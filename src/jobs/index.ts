import { scheduler } from '../core/scheduler.js';

import { heartbeat } from './heartbeat.job.js';

/**
 * Registers every job runner. A module that needs the clock (cycles,
 * invitations, scoring) adds its runner here: `scheduler.registerJob('cycles.transitions', runner)`.
 * Runners execute every minute in this order; use `once()` inside them.
 */
export function registerJobs(): void {
  scheduler.registerJob('heartbeat', heartbeat);
}
