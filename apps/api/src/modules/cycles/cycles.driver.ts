import { isOpen } from '@csq/core';
import { CsqError } from '../../kernel/errors.js';
import type { Logger } from '../../kernel/logger.js';
import { runSystem } from '../../kernel/requestContext.js';
import {
  CycleModel,
  ParticipationModel,
  ReminderDispatchModel,
  type CycleDoc,
  type ParticipationDoc,
  type ReminderDoc,
} from './cycles.models.js';
import { claimDueTask, completeTask, failTask, type TaskRow } from './cycles.tasks.js';
import { advanceCycle } from './cycles.service.js';
import type { ReminderAudience } from './cycles.contracts.js';

/**
 * The runner. It has no request, so it has no organisation, so it enters system
 * scope explicitly with a reason that gets logged before any work starts.
 *
 * Inside system scope the tenancy plugin injects nothing, which is the whole
 * point of a runner and also the one place a query has to name the organisation
 * itself. Every such query below takes that name from the claimed task row,
 * never from anything a caller supplied, and the models are used directly
 * because TenantRepo types orgId as never on purpose.
 */

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_LIMIT = 50;

export interface DrainOptions {
  readonly now: Date;
  /** Identifies this runner in the lease. A hostname and pid is enough. */
  readonly workerId: string;
  readonly log: Logger;
  readonly leaseMs?: number;
  readonly limit?: number;
}

export interface DrainReport {
  claimed: number;
  completed: number;
  retried: number;
  dead: number;
  /** Work that finished after its lease had already been taken by someone else. */
  lost: number;
}

export async function drainDueTasks(options: DrainOptions): Promise<DrainReport> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;

  return runSystem(
    { reason: `cycle scheduled task drain by ${options.workerId}`, log: options.log },
    async (): Promise<DrainReport> => {
      const report: DrainReport = { claimed: 0, completed: 0, retried: 0, dead: 0, lost: 0 };

      for (let taken = 0; taken < limit; taken += 1) {
        const task = await claimDueTask({ now: options.now, workerId: options.workerId, leaseMs });
        if (!task) break;
        report.claimed += 1;

        try {
          const result = await runClaimedTask(task, options.now, options.log);
          const held = await completeTask(task._id, options.workerId, options.now, result);
          if (held) {
            report.completed += 1;
          } else {
            // the lease expired mid task and another runner took the row. Do not
            // overwrite its outcome; record that this one lost the race
            report.lost += 1;
            options.log.warn({ taskId: task._id }, 'lease lost before the task could be completed');
          }
        } catch (error) {
          const message = error instanceof CsqError ? `${error.code}: ${error.message}` : String(error);
          options.log.error({ err: error, taskId: task._id, kind: task.kind }, 'scheduled task failed');
          const outcome = await failTask(task._id, options.workerId, options.now, message);
          if (outcome === 'DEAD') report.dead += 1;
          else if (outcome === 'RETRY') report.retried += 1;
        }
      }

      return report;
    },
  );
}

/** Exported so one task can be driven in isolation, by a test or by an operator tool. */
export async function runClaimedTask(task: TaskRow, now: Date, log: Logger): Promise<string> {
  switch (task.kind) {
    case 'CYCLE_ADVANCE':
      return runAdvanceTask(task, now);
    case 'CYCLE_REMINDER':
      return runReminderTask(task, now, log);
  }
}

async function loadCycle(task: TaskRow): Promise<CycleDoc | null> {
  // the organisation comes from the task row. In system scope nothing filters
  // it for us, and a cycle whose owner does not match the task is not ours
  return CycleModel.findOne({ _id: task.cycleId, orgId: task.orgId }).lean().exec();
}

/**
 * A window boundary has arrived. The same service function the operator
 * endpoint calls is used here, gated on the same clock, so there is no second
 * path with looser rules.
 */
async function runAdvanceTask(task: TaskRow, now: Date): Promise<string> {
  const cycle = await loadCycle(task);
  if (!cycle) return 'cycle no longer exists';

  try {
    const after = await advanceCycle(task.cycleId, now, { userId: null, automatic: true });
    return `advanced to ${after.state}`;
  } catch (error) {
    // a cycle that was unscheduled, or that an operator already advanced, is not
    // a failure to retry: the task has nothing left to do and says so
    if (error instanceof CsqError && (error.code === 'WINDOW_NOT_OPEN' || error.code === 'CONFLICT')) {
      return `nothing to do: ${error.message}`;
    }
    throw error;
  }
}

/**
 * Recipients are resolved here, at send time, against who has not yet done the
 * thing. That is why a reminder has no cancellation path to get wrong: an
 * operator who submitted an hour ago simply is not in the set any more.
 */
async function runReminderTask(task: TaskRow, now: Date, log: Logger): Promise<string> {
  const cycle = await loadCycle(task);
  if (!cycle) return 'cycle no longer exists';

  const reminder = cycle.reminders.find((r: ReminderDoc) => r._id === task.reminderId);
  if (!reminder) return 'reminder was removed from the cycle';

  if (!isOpen(cycle.windows, 'ASSESSMENT', now)) {
    return 'assessment window is not open, so there is nothing to remind anyone about';
  }

  const roster = await ParticipationModel.find({
    cycleId: cycle._id,
    orgId: task.orgId,
    state: { $ne: 'WITHDRAWN' },
  })
    .lean()
    .exec();

  let resolved = 0;
  let alreadyRecorded = 0;

  for (const participation of roster) {
    const reason = outstandingReason(participation, reminder.audience);
    if (!reason) continue;

    try {
      await ReminderDispatchModel.create({
        orgId: task.orgId,
        cycleId: cycle._id,
        reminderId: reminder._id,
        participationId: participation._id,
        acoOrgId: participation.acoOrgId,
        audience: reminder.audience,
        reason,
        dueAt: new Date(reminder.at.utc),
        resolvedAt: now,
        sentAt: null,
      });
      resolved += 1;
    } catch (error) {
      // the unique key already holds a row for this recipient: a previous
      // attempt got this far, and one recipient gets one dispatch
      if (isDuplicateKey(error)) {
        alreadyRecorded += 1;
        continue;
      }
      throw error;
    }
  }

  log.info(
    { cycleId: cycle._id, reminderId: reminder._id, resolved, alreadyRecorded },
    'reminder recipients resolved',
  );
  return `resolved ${resolved} outstanding, ${alreadyRecorded} already recorded`;
}

/** What this participation still owes, or null when it owes nothing. */
export function outstandingReason(
  participation: ParticipationDoc,
  audience: ReminderAudience,
): string | null {
  switch (audience) {
    case 'SAMPLING':
      return participation.sampling.state === 'LOCKED' || participation.sampling.state === 'WAIVED'
        ? null
        : `sample is ${participation.sampling.state}`;
    case 'SELF':
      return participation.progress.selfSubmittedAt === null ? 'self assessment not submitted' : null;
    case 'EXTERNAL':
      return participation.progress.externalSubmittedAt === null
        ? 'external assessment not submitted'
        : null;
    case 'CUSTOMER': {
      const outstanding = participation.progress.customerInvited - participation.progress.customerSubmitted;
      return outstanding > 0 ? `${outstanding} sampled customers have not responded` : null;
    }
  }
}

const DUPLICATE_KEY = 11000;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY
  );
}
