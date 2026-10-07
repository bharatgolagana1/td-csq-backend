import { systemContext } from '../core/auth/system.js';
import { idString } from '../core/ids.js';
import { once, type JobRunner } from '../core/scheduler.js';
import { findCyclesByStatus } from '../modules/cycles/cycles.service.js';
import { fromInstant } from '../modules/cycles/domain/windows.js';
import { runCycle } from '../modules/scoring/scoring.service.js';

export const NIGHTLY_JOB = 'scoring.nightly';
export const FINALISE_JOB = 'scoring.finalise';

/** Local hour (in the cycle's zone) from which the day's provisional run is due. */
export const NIGHTLY_HOUR = 1;

/** How long a cycle may sit in ASSESSMENT_CLOSED before the safety net assumes the listener's final run failed. */
export const FINALISE_GRACE_MS = 15 * 60 * 1000;

/**
 * The `once()` slot for a cycle's nightly run at `now`: the cycle-local
 * calendar day once its clock has passed 01:00, else null (not due yet). One
 * slot per day means the first tick at or after 01:00 runs it and later
 * ticks — including a catch-up after downtime, the same day — skip it.
 */
export function nightlySlot(cycle: { tz: string }, now: Date): string | null {
  const wall = fromInstant(now, cycle.tz);
  return Number(wall.slice(11, 13)) >= NIGHTLY_HOUR ? wall.slice(0, 10) : null;
}

/**
 * Provisional scoring of every ASSESSMENT_OPEN cycle at 01:00 cycle-local
 * (ARCHITECTURE §6: "nightly while open for live dashboards, flagged
 * provisional"). The final run is not a job: it follows `cycle.transitioned`
 * to ASSESSMENT_CLOSED (scoring.handlers.ts).
 */
export const scoringNightly: JobRunner = async ({ now, log }) => {
  for (const cycle of await findCyclesByStatus(['ASSESSMENT_OPEN'])) {
    const cycleId = idString(cycle._id);
    try {
      const slot = nightlySlot(cycle, now);
      if (slot === null) continue;
      const result = await once(NIGHTLY_JOB, cycleId, slot, async () => {
        const summary = await runCycle(cycleId, { provisional: true, ctx: systemContext(`scheduler: ${NIGHTLY_JOB}`), now });
        return `${summary.operators} operators, ${summary.airports} airports, ${summary.rows} rows`;
      });
      if (result.ran) log.info({ cycleId, code: cycle.code, slot }, 'Nightly provisional scoring run');
    } catch (error) {
      log.error({ err: error, cycleId, code: cycle.code }, 'Nightly scoring run failed');
    }
  }
};

/**
 * Safety net for the final run. It normally follows `cycle.transitioned` to
 * ASSESSMENT_CLOSED (scoring.handlers.ts); if that run, or the SCORED
 * transition after it, failed, the cycle stays ASSESSMENT_CLOSED and the
 * cycle clock does not retry (it leaves the SCORING step to scoring). So a
 * cycle closed for longer than the grace period gets its final run redone,
 * `once()` per cycle + assessment end (an extended, re-closed window is a new
 * slot). The run is idempotent, so a redo after a lost SCORED transition only
 * re-emits `scoring.completed`.
 */
export const scoringFinalise: JobRunner = async ({ now, log }) => {
  for (const cycle of await findCyclesByStatus(['ASSESSMENT_CLOSED'])) {
    if (now.getTime() - cycle.updatedAt.getTime() < FINALISE_GRACE_MS) continue;
    const cycleId = idString(cycle._id);
    const slot = cycle.assessment.end.utc.toISOString();
    try {
      const result = await once(FINALISE_JOB, cycleId, slot, async () => {
        const summary = await runCycle(cycleId, { provisional: false, ctx: systemContext(`scheduler: ${FINALISE_JOB}`), now });
        return `${summary.operators} operators, ${summary.airports} airports, ${summary.rows} rows`;
      });
      if (result.ran) log.warn({ cycleId, code: cycle.code, slot }, 'Final scoring run redone by the safety net');
    } catch (error) {
      log.error({ err: error, cycleId, code: cycle.code }, 'Final scoring run failed');
    }
  }
};
