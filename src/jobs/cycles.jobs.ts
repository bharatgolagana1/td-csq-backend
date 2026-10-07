import { systemContext } from '../core/auth/system.js';
import { idString } from '../core/ids.js';
import { once, type JobRunner } from '../core/scheduler.js';
import { CLOCK_STATUSES, findCyclesByStatus, transition } from '../modules/cycles/cycles.service.js';
import { dueTransitions } from '../modules/cycles/domain/transitions.js';
import { runSamplingReminders } from '../modules/cycles/reminders.service.js';

export const TRANSITIONS_JOB = 'cycles.transitions';

/**
 * The cycle clock (ARCHITECTURE §7): every tick, each non-terminal cycle
 * takes every automatic step its windows make due, in order, one `once()`
 * slot per cycle + target status + window instant (so an extended window
 * yields a new slot). ASSESSMENT_CLOSED → SCORED is not taken here: scoring
 * runs on `cycle.transitioned` to ASSESSMENT_CLOSED and cycles marks SCORED
 * when `scoring.completed` arrives.
 */
export const cyclesTransitions: JobRunner = async ({ now, log }) => {
  for (const cycle of await findCyclesByStatus(CLOCK_STATUSES)) {
    const cycleId = idString(cycle._id);
    for (const step of dueTransitions(cycle, now)) {
      if (step.trigger === 'SCORING') break;
      const slot = `${step.to}@${step.at.toISOString()}`;
      let ran = false;
      try {
        const result = await once(TRANSITIONS_JOB, cycleId, slot, async () => {
          await transition(systemContext(`scheduler: ${TRANSITIONS_JOB}`), cycleId, step.to, `CLOCK: ${step.trigger} at ${step.at.toISOString()}`, {
            trigger: 'CLOCK',
            now,
          });
          return `${step.from} → ${step.to}`;
        });
        ran = result.ran;
      } catch (error) {
        log.error({ err: error, cycleId, code: cycle.code, from: step.from, to: step.to }, 'Cycle transition failed');
        break;
      }
      if (!ran) break;
      log.info({ cycleId, code: cycle.code, from: step.from, to: step.to, at: step.at.toISOString() }, 'Cycle transitioned by the clock');
    }
  }
};

/** Sampling reminders to unlocked participants on the derived schedule; `once()` per participant + reminder index. */
export const cyclesSamplingReminders: JobRunner = async ({ now, log }) => {
  const { sent } = await runSamplingReminders(now, log);
  if (sent > 0) log.info({ sent }, 'Sampling reminders sent');
};
