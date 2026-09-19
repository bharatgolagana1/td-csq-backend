import { TenantRepo } from '../../kernel/tenancy.js';
import { ScheduledTaskModel, type CycleDoc, type ScheduledTaskDoc } from './cycles.models.js';
import { automaticBoundaries, type CycleTransition } from './cycles.state.js';
import type { ScheduledTaskKind, ScheduledTaskView } from './cycles.contracts.js';

/**
 * The scheduled work a cycle creates, and the claim that makes running it safe.
 *
 * Two guarantees, and they protect different things.
 *
 * The lease stops two runners executing one task: the claim is a single
 * findOneAndUpdate, which MongoDB applies atomically to one document, so of two
 * instances reaching for the same row exactly one gets it. It is deliberately
 * not a transaction. A transaction would need a replica set to do what one
 * atomic document update already does, and a task runner that only works on a
 * replica set is a task runner that silently does not run in development.
 *
 * The lease also expires. A runner that is killed mid-task holds nothing
 * forever: the row becomes claimable again once the lease runs out, and the
 * attempt counter carries over so a task that kills its runner every time still
 * ends up dead rather than looping.
 *
 * The dedupe key stops the same piece of work being enqueued twice. It is a
 * unique index, so creating a task that already exists is a duplicate key error
 * and not a second send, which makes scheduling idempotent and therefore safe
 * to re-run after a crash.
 */

const tasks = new TenantRepo<ScheduledTaskDoc>(ScheduledTaskModel);

/** A claimed task carries its organisation, because the runner has no scope of its own. */
export interface TaskRow extends ScheduledTaskDoc {
  orgId: string;
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

function advanceKey(cycleId: string, transition: CycleTransition, at: Date): string {
  // the instant is part of the key, so moving a window produces a different
  // task rather than silently reusing one aimed at the old date
  return `advance:${cycleId}:${transition}:${at.getTime()}`;
}

function reminderKey(cycleId: string, reminderId: string, at: Date): string {
  return `reminder:${cycleId}:${reminderId}:${at.getTime()}`;
}

interface TaskDraft {
  kind: ScheduledTaskKind;
  cycleId: string;
  reminderId: string | null;
  transition: CycleTransition | null;
  runAt: Date;
  dedupeKey: string;
}

/** True when the task was created, false when an identical one already existed. */
async function ensureTask(draft: TaskDraft): Promise<boolean> {
  try {
    await tasks.create({
      kind: draft.kind,
      cycleId: draft.cycleId,
      reminderId: draft.reminderId,
      transition: draft.transition,
      runAt: draft.runAt,
      dedupeKey: draft.dedupeKey,
      state: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
      leaseOwner: null,
      leaseExpiresAt: null,
      startedAt: null,
      completedAt: null,
      lastError: null,
      result: null,
    });
    return true;
  } catch (error) {
    if (isDuplicateKey(error)) return false;
    throw error;
  }
}

/** One task per clock-driven edge, plus one per reminder. Safe to run twice. */
export async function scheduleCycleTasks(cycle: CycleDoc): Promise<number> {
  let created = 0;

  for (const edge of automaticBoundaries(cycle.state, cycle.windows)) {
    const made = await ensureTask({
      kind: 'CYCLE_ADVANCE',
      cycleId: cycle._id,
      reminderId: null,
      transition: edge.name,
      runAt: new Date(edge.at),
      dedupeKey: advanceKey(cycle._id, edge.name, new Date(edge.at)),
    });
    if (made) created += 1;
  }

  for (const reminder of cycle.reminders) {
    const at = new Date(reminder.at.utc);
    const made = await ensureTask({
      kind: 'CYCLE_REMINDER',
      cycleId: cycle._id,
      reminderId: reminder._id,
      transition: null,
      runAt: at,
      dedupeKey: reminderKey(cycle._id, reminder._id, at),
    });
    if (made) created += 1;
  }

  return created;
}

/**
 * Brings the pending reminder tasks back in line with the cycle's reminders
 * after the set has been edited. Only pending rows are touched: a task that has
 * already run is a record of something that happened.
 */
export async function syncReminderTasks(cycle: CycleDoc): Promise<{ created: number; cancelled: number }> {
  const wanted = new Map(
    cycle.reminders.map((reminder) => {
      const at = new Date(reminder.at.utc);
      return [reminderKey(cycle._id, reminder._id, at), { reminderId: reminder._id, at }];
    }),
  );

  const existing = await tasks
    .find({ cycleId: cycle._id, kind: 'CYCLE_REMINDER', state: 'PENDING' })
    .lean()
    .exec();

  let cancelled = 0;
  for (const row of existing) {
    if (wanted.has(row.dedupeKey)) {
      wanted.delete(row.dedupeKey);
      continue;
    }
    const { deletedCount } = await tasks.deleteOne({ _id: row._id, state: 'PENDING' });
    cancelled += deletedCount;
  }

  let created = 0;
  for (const [dedupeKey, reminder] of wanted) {
    const made = await ensureTask({
      kind: 'CYCLE_REMINDER',
      cycleId: cycle._id,
      reminderId: reminder.reminderId,
      transition: null,
      runAt: reminder.at,
      dedupeKey,
    });
    if (made) created += 1;
  }

  return { created, cancelled };
}

/** Withdraws work that has not started. Used when a cycle is unscheduled. */
export async function cancelPendingTasks(cycleId: string): Promise<number> {
  // deleteMany is a query path, so the tenancy plugin filters it; TenantRepo
  // simply does not expose it
  const result = await ScheduledTaskModel.deleteMany({ cycleId, state: 'PENDING' }).exec();
  return result.deletedCount;
}

export function taskView(row: ScheduledTaskDoc): ScheduledTaskView {
  return {
    id: row._id,
    kind: row.kind,
    cycleId: row.cycleId,
    state: row.state,
    runAt: new Date(row.runAt).toISOString(),
    attempts: row.attempts,
    leaseExpiresAt: row.leaseExpiresAt ? new Date(row.leaseExpiresAt).toISOString() : null,
    lastError: row.lastError,
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
  };
}

export async function listCycleTasks(cycleId: string): Promise<ScheduledTaskView[]> {
  const rows = await tasks.find({ cycleId }).sort({ runAt: 1 }).lean().exec();
  return rows.map(taskView);
}

export interface ClaimOptions {
  readonly now: Date;
  /** Identifies the runner. Recorded on the row so a stuck lease has an owner. */
  readonly workerId: string;
  readonly leaseMs: number;
}

/**
 * Claims one due task, or returns null when there is nothing to do.
 *
 * A row is claimable when it is due and either unclaimed or holding an expired
 * lease. Both conditions and the write are one atomic document update, so a
 * second instance reaching for the same row at the same instant finds the lease
 * already taken and moves on.
 */
export async function claimDueTask(options: ClaimOptions): Promise<TaskRow | null> {
  const { now, workerId, leaseMs } = options;
  return tasks
    .findOneAndUpdate(
      {
        state: { $in: ['PENDING', 'RUNNING'] },
        runAt: { $lte: now },
        $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
      },
      {
        $set: {
          state: 'RUNNING',
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          startedAt: now,
        },
        // counted on claim rather than on failure, so a task that kills its
        // runner before it can report anything still exhausts its attempts
        $inc: { attempts: 1 },
      },
      { sort: { runAt: 1 } },
    )
    .lean()
    .exec();
}

/** Extends a lease held by this runner. Returns false when the lease was lost. */
export async function extendLease(
  taskId: string,
  workerId: string,
  now: Date,
  leaseMs: number,
): Promise<boolean> {
  const updated = await tasks
    .findOneAndUpdate(
      { _id: taskId, leaseOwner: workerId, state: 'RUNNING' },
      { $set: { leaseExpiresAt: new Date(now.getTime() + leaseMs) } },
    )
    .lean()
    .exec();
  return updated !== null;
}

/**
 * Marks a task done. Filtered on the lease, so a runner whose lease expired and
 * was taken by somebody else cannot report on work it no longer owns.
 */
export async function completeTask(
  taskId: string,
  workerId: string,
  now: Date,
  result: string,
): Promise<boolean> {
  const updated = await tasks
    .findOneAndUpdate(
      { _id: taskId, leaseOwner: workerId, state: 'RUNNING' },
      {
        $set: {
          state: 'DONE',
          completedAt: now,
          result: result.slice(0, 500),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      },
    )
    .lean()
    .exec();
  return updated !== null;
}

const RETRY_BASE_MS = 30_000;
const RETRY_CEILING_MS = 3_600_000;

export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_CEILING_MS);
}

/**
 * Returns a failed task to the queue, or retires it once it has used up its
 * attempts. A dead task is left in place rather than deleted: an operator
 * needs to see that a reminder never went out.
 */
export async function failTask(
  taskId: string,
  workerId: string,
  now: Date,
  error: string,
): Promise<'RETRY' | 'DEAD' | 'LOST'> {
  const held = await tasks.findOne({ _id: taskId, leaseOwner: workerId, state: 'RUNNING' }).lean().exec();
  if (!held) return 'LOST';

  const exhausted = held.attempts >= held.maxAttempts;
  await tasks.updateOne(
    { _id: taskId, leaseOwner: workerId },
    {
      $set: {
        state: exhausted ? 'DEAD' : 'PENDING',
        lastError: error.slice(0, 1000),
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(exhausted ? { completedAt: now } : { runAt: new Date(now.getTime() + backoffMs(held.attempts)) }),
      },
    },
  );
  return exhausted ? 'DEAD' : 'RETRY';
}
