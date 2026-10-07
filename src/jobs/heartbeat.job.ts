import { hourSlot, once, type JobRunner } from '../core/scheduler.js';

/**
 * Proves the scheduler loop and the `jobs` idempotency record work: writes one
 * DONE row per hour. Real runners (cycle transitions, reminders, scoring) are
 * added by their modules in `src/jobs/index.ts`.
 */
export const heartbeat: JobRunner = async ({ now, log }) => {
  const result = await once('heartbeat', 'scheduler', hourSlot(now), async () => `tick at ${now.toISOString()}`);
  if (result.ran) log.debug({ slot: hourSlot(now) }, 'Heartbeat recorded');
};
