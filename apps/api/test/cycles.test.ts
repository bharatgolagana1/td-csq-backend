import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { runAsPrincipal, type Principal } from '../src/kernel/requestContext.js';
import { newId } from '../src/kernel/ids.js';
import {
  CycleModel,
  ParticipationModel,
  ProgramModel,
  ReminderDispatchModel,
  ScheduledTaskModel,
} from '../src/modules/cycles/cycles.models.js';
import {
  addParticipation,
  advanceCycle,
  createCycle,
  createProgram,
  deleteCycle,
  listCycles,
  listParticipations,
  publishCycle,
  readCycle,
  recordParticipationProgress,
  recordSamplingLock,
  removeParticipation,
  replaceReminders,
  replaceWindows,
  scheduleCycle,
  scoreCycle,
  unscheduleCycle,
  withdrawParticipation,
} from '../src/modules/cycles/cycles.service.js';
import {
  backoffMs,
  claimDueTask,
  completeTask,
  failTask,
  listCycleTasks,
  scheduleCycleTasks,
} from '../src/modules/cycles/cycles.tasks.js';
import { drainDueTasks } from '../src/modules/cycles/cycles.driver.js';
import type { RequestHandler } from 'express';
import { checkModule, mountModules } from '../src/kernel/router.js';
import { cyclesModule } from '../src/modules/cycles/cycles.module.js';
import type { CreateCycle } from '../src/modules/cycles/cycles.contracts.js';
import { closeDatabase, openDatabase, silentLog } from './mongo.js';

const ORG_A = newId();
const ORG_B = newId();
const TZ = 'Asia/Kolkata';

function personFor(userId: string, orgId: string): Principal {
  return {
    userId,
    subject: `sub-${userId}`,
    email: null,
    displayName: userId,
    memberships: [{ orgId, roles: ['ADMIN'], capabilities: [], active: true }],
  };
}

const adminA = personFor('admin-a', ORG_A);
const adminB = personFor('admin-b', ORG_B);

function inA<T>(fn: () => T): T {
  return runAsPrincipal({ requestId: newId(), principal: adminA, orgId: ORG_A }, fn);
}
function inB<T>(fn: () => T): T {
  return runAsPrincipal({ requestId: newId(), principal: adminB, orgId: ORG_B }, fn);
}

/** Wall times, so the test reads the way an administrator types. */
const WINDOWS = {
  samplingOpens: { wall: '2026-04-01T00:00', tz: TZ },
  // deliberately after the assessment window opens: the overlap is a requirement
  samplingCloses: { wall: '2026-05-15T00:00', tz: TZ },
  assessmentOpens: { wall: '2026-05-01T00:00', tz: TZ },
  assessmentCloses: { wall: '2026-05-31T00:00', tz: TZ },
} as const;

const BEFORE_ANYTHING = new Date('2026-03-01T00:00:00Z');
const SAMPLING_ONLY = new Date('2026-04-05T00:00:00Z');
const BOTH_OPEN = new Date('2026-05-05T00:00:00Z');
const AFTER_EVERYTHING = new Date('2026-06-05T00:00:00Z');

const actor = { userId: 'admin-a', automatic: false } as const;
const driver = { userId: null, automatic: true } as const;

async function makeProgram(code = 'ACFI-2026'): Promise<string> {
  const program = await createProgram({
    code,
    name: 'ACFI cargo service quality 2026',
    description: null,
    formScope: 'INTERNATIONAL',
    defaultTimezone: TZ,
    defaultMinimumSamplingSize: 5,
  });
  return program.id;
}

function draft(programId: string, code: string, overrides: Partial<CreateCycle> = {}): CreateCycle {
  return {
    programId,
    code,
    name: `Cycle ${code}`,
    windows: { ...WINDOWS },
    minimumSamplingSize: null,
    reminders: [],
    ...overrides,
  };
}

const COLLECTIONS = [
  ProgramModel,
  CycleModel,
  ParticipationModel,
  ScheduledTaskModel,
  ReminderDispatchModel,
];

/**
 * One connection and one set of hooks for the whole file. The cycle models are
 * compiled once per process, and their tenancy plugin closes over the module
 * graph of whichever test file registered them, so every test that touches them
 * has to live in this file.
 */
beforeAll(async () => {
  await openDatabase();
  for (const model of COLLECTIONS) await model.syncIndexes();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  for (const model of COLLECTIONS) {
    await mongoose.connection.collection(model.collection.name).deleteMany({});
  }
});

describe('cycles module', () => {

  it('stores what was typed, the zone it was typed in, and the instant it resolves to', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'Q1'), BEFORE_ANYTHING));

    expect(cycle.windows.samplingOpens.wall).toBe('2026-04-01T00:00:00');
    expect(cycle.windows.samplingOpens.tz).toBe(TZ);
    expect(cycle.windows.samplingOpens.utc).toBe('2026-03-31T18:30:00.000Z');
    expect(cycle.state).toBe('DRAFT');
    expect(cycle.minimumSamplingSize).toBe(5);
    expect(cycle.formScope).toBe('INTERNATIONAL');
  });

  /**
   * The prototype carried a pre-save hook that made a second cycle impossible to
   * create for the life of the product. Nothing here limits the count, and
   * overlapping cycles are ordinary.
   */
  it('lets one programme hold many cycles, including overlapping ones', async () => {
    const programId = await inA(() => makeProgram());

    const first = await inA(() => createCycle(draft(programId, 'Q1'), BEFORE_ANYTHING));
    const second = await inA(() => createCycle(draft(programId, 'Q2'), BEFORE_ANYTHING));
    const third = await inA(() =>
      createCycle(
        draft(programId, 'AUDIT', {
          windows: {
            ...WINDOWS,
            samplingOpens: { wall: '2026-04-10T00:00', tz: TZ },
            assessmentOpens: { wall: '2026-05-02T00:00', tz: TZ },
          },
        }),
        BEFORE_ANYTHING,
      ),
    );

    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    const all = await inA(() => listCycles({ programId, limit: 50 }, BEFORE_ANYTHING));
    expect(all).toHaveLength(3);
  });

  it('refuses a second cycle with the same code in one programme', async () => {
    const programId = await inA(() => makeProgram());
    await inA(() => createCycle(draft(programId, 'Q1'), BEFORE_ANYTHING));

    await expect(inA(() => createCycle(draft(programId, 'q1'), BEFORE_ANYTHING))).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );
  });

  it('accepts an assessment window that opens while sampling is still open', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'OVERLAP'), BEFORE_ANYTHING));

    expect(new Date(cycle.windows.assessmentOpens.utc).getTime()).toBeLessThan(
      new Date(cycle.windows.samplingCloses.utc).getTime(),
    );
  });

  it('refuses windows that cannot happen in that order', async () => {
    const programId = await inA(() => makeProgram());

    await expect(
      inA(() =>
        createCycle(
          draft(programId, 'BAD', {
            windows: { ...WINDOWS, samplingCloses: { wall: '2026-03-01T00:00', tz: TZ } },
          }),
          BEFORE_ANYTHING,
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      inA(() =>
        createCycle(
          draft(programId, 'BAD2', {
            windows: { ...WINDOWS, assessmentOpens: { wall: '2026-03-01T00:00', tz: TZ } },
          }),
          BEFORE_ANYTHING,
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a reminder outside the assessment window and accepts one inside it', async () => {
    const programId = await inA(() => makeProgram());

    await expect(
      inA(() =>
        createCycle(
          draft(programId, 'R1', {
            reminders: [
              { label: 'Too early', audience: 'CUSTOMER', at: { wall: '2026-04-20T09:00', tz: TZ } },
            ],
          }),
          BEFORE_ANYTHING,
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const good = await inA(() =>
      createCycle(
        draft(programId, 'R2', {
          reminders: [
            { label: 'One week left', audience: 'CUSTOMER', at: { wall: '2026-05-24T09:00', tz: TZ } },
          ],
        }),
        BEFORE_ANYTHING,
      ),
    );
    expect(good.reminders).toHaveLength(1);
    expect(good.reminders[0]?.at.utc).toBe('2026-05-24T03:30:00.000Z');
  });

  it('keeps reminder identity when the set is re-submitted', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() =>
      createCycle(
        draft(programId, 'R3', {
          reminders: [
            { label: 'One week left', audience: 'CUSTOMER', at: { wall: '2026-05-24T09:00', tz: TZ } },
          ],
        }),
        BEFORE_ANYTHING,
      ),
    );
    const originalId = cycle.reminders[0]?.id;

    const again = await inA(() =>
      replaceReminders(
        cycle.id,
        [
          { label: 'One week left', audience: 'CUSTOMER', at: { wall: '2026-05-24T09:00', tz: TZ } },
          { label: 'Last day', audience: 'CUSTOMER', at: { wall: '2026-05-30T09:00', tz: TZ } },
        ],
        BEFORE_ANYTHING,
      ),
    );

    expect(again.reminders).toHaveLength(2);
    expect(again.reminders.map((r) => r.id)).toContain(originalId);
  });

  it('enqueues one task per window boundary and one per reminder, idempotently', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() =>
      createCycle(
        draft(programId, 'SCHED', {
          reminders: [
            { label: 'Halfway', audience: 'CUSTOMER', at: { wall: '2026-05-15T09:00', tz: TZ } },
          ],
        }),
        BEFORE_ANYTHING,
      ),
    );

    const scheduled = await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));
    expect(scheduled.state).toBe('SCHEDULED');
    expect(scheduled.freezes.configurationFrozenAt).not.toBeNull();

    const tasks = await inA(() => listCycleTasks(cycle.id));
    expect(tasks.map((t) => t.kind).sort()).toEqual([
      'CYCLE_ADVANCE',
      'CYCLE_ADVANCE',
      'CYCLE_ADVANCE',
      'CYCLE_REMINDER',
    ]);
    expect(tasks.every((t) => t.state === 'PENDING')).toBe(true);

    // re-running the schedule side effect must not enqueue the same work twice
    const stored = await inA(() => CycleModel.findOne({ _id: cycle.id }).lean().exec());
    const createdAgain = await inA(() => scheduleCycleTasks(stored!));
    expect(createdAgain).toBe(0);
    expect(await inA(() => listCycleTasks(cycle.id))).toHaveLength(4);
  });

  it('refuses to schedule a cycle whose sampling window has already opened', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'LATE'), SAMPLING_ONLY));

    await expect(inA(() => scheduleCycle(cycle.id, SAMPLING_ONLY, actor))).rejects.toMatchObject({
      code: 'WINDOW_CLOSED',
    });
  });

  it('will not open a window before its instant, for a person or for the driver', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'EARLY'), BEFORE_ANYTHING));
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));

    const oneSecondEarly = new Date('2026-03-31T18:29:59Z');
    await expect(inA(() => advanceCycle(cycle.id, oneSecondEarly, actor))).rejects.toMatchObject({
      code: 'WINDOW_NOT_OPEN',
    });
    await expect(inA(() => advanceCycle(cycle.id, oneSecondEarly, driver))).rejects.toMatchObject({
      code: 'WINDOW_NOT_OPEN',
    });

    const opened = await inA(() => advanceCycle(cycle.id, new Date('2026-03-31T18:30:00Z'), actor));
    expect(opened.state).toBe('SAMPLING_OPEN');
  });

  it('catches up through every boundary it slept through', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'CATCHUP'), BEFORE_ANYTHING));
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));

    const closed = await inA(() => advanceCycle(cycle.id, AFTER_EVERYTHING, driver));
    expect(closed.state).toBe('CLOSED');

    const stored = await inA(() => CycleModel.findOne({ _id: cycle.id }).lean().exec());
    expect(stored?.transitions.map((t) => t.name)).toEqual([
      'SCHEDULE',
      'OPEN_SAMPLING',
      'OPEN_ASSESSMENT',
      'CLOSE',
    ]);
    expect(stored?.freezes.submissionsFrozenAt).not.toBeNull();
  });

  it('reports sampling and assessment open together while the windows overlap', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'OPEN'), BEFORE_ANYTHING));
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));
    await inA(() => advanceCycle(cycle.id, BOTH_OPEN, driver));

    const view = await inA(() => readCycle(cycle.id, BOTH_OPEN));
    expect(view.state).toBe('ASSESSMENT_OPEN');
    expect(view.samplingOpen).toBe(true);
    expect(view.assessmentOpen).toBe(true);
  });

  it('unschedules before sampling opens and withdraws the pending work', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'UNDO'), BEFORE_ANYTHING));
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));

    const back = await inA(() => unscheduleCycle(cycle.id, BEFORE_ANYTHING, actor));
    expect(back.state).toBe('DRAFT');
    expect(back.freezes.configurationFrozenAt).toBeNull();
    expect(await inA(() => listCycleTasks(cycle.id))).toHaveLength(0);
  });

  it('refuses to unschedule once sampling has opened', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'LOCKEDIN'), BEFORE_ANYTHING));
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));
    await inA(() => advanceCycle(cycle.id, SAMPLING_ONLY, driver));

    await expect(inA(() => unscheduleCycle(cycle.id, SAMPLING_ONLY, actor))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('freezes the windows when a cycle is scheduled', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'FROZEN'), BEFORE_ANYTHING));
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));

    await expect(
      inA(() => replaceWindows(cycle.id, { ...WINDOWS }, BEFORE_ANYTHING)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('answers a request for another organisation cycle as if it never existed', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'MINE'), BEFORE_ANYTHING));

    await expect(inB(() => readCycle(cycle.id, BEFORE_ANYTHING))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await inB(() => listCycles({ limit: 50 }, BEFORE_ANYTHING))).toHaveLength(0);
  });

  it('lets two organisations use the same programme and cycle codes', async () => {
    const a = await inA(() => makeProgram('SHARED'));
    const b = await inB(() => makeProgram('SHARED'));
    await inA(() => createCycle(draft(a, 'Q1'), BEFORE_ANYTHING));
    const theirs = await inB(() => createCycle(draft(b, 'Q1'), BEFORE_ANYTHING));

    expect(theirs.code).toBe('Q1');
  });

  it('deletes a draft cycle only, and only while nobody is in it', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'DEL'), BEFORE_ANYTHING));
    await inA(() =>
      addParticipation(cycle.id, { acoOrgId: newId(), airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
    );

    await expect(inA(() => deleteCycle(cycle.id))).rejects.toMatchObject({ code: 'CONFLICT' });

    const participations = await inA(() => listParticipations(cycle.id, {}));
    await inA(() => removeParticipation(cycle.id, participations[0]!.id));
    await inA(() => deleteCycle(cycle.id));

    await expect(inA(() => readCycle(cycle.id, BEFORE_ANYTHING))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('holds one row per operator per cycle and refuses a second', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'ROSTER'), BEFORE_ANYTHING));
    const aco = newId();

    const joined = await inA(() =>
      addParticipation(cycle.id, { acoOrgId: aco, airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
    );
    expect(joined.sampling.minimumSamplingSize).toBe(5);
    expect(joined.state).toBe('INVITED');

    await expect(
      inA(() =>
        addParticipation(cycle.id, { acoOrgId: aco, airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('lets one operator take part in two cycles at once', async () => {
    const programId = await inA(() => makeProgram());
    const first = await inA(() => createCycle(draft(programId, 'C1'), BEFORE_ANYTHING));
    const second = await inA(() => createCycle(draft(programId, 'C2'), BEFORE_ANYTHING));
    const aco = newId();

    await inA(() => addParticipation(first.id, { acoOrgId: aco, airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING));
    const other = await inA(() =>
      addParticipation(second.id, { acoOrgId: aco, airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
    );

    expect(other.cycleId).toBe(second.id);
  });

  it('stops removing an operator once invitations have gone out, and withdraws instead', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'WD'), BEFORE_ANYTHING));
    const joined = await inA(() =>
      addParticipation(cycle.id, { acoOrgId: newId(), airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
    );
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));
    await inA(() => advanceCycle(cycle.id, SAMPLING_ONLY, driver));

    await expect(inA(() => removeParticipation(cycle.id, joined.id))).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const withdrawn = await inA(() =>
      withdrawParticipation(cycle.id, joined.id, 'Terminal sold', SAMPLING_ONLY),
    );
    expect(withdrawn.state).toBe('WITHDRAWN');
    expect(withdrawn.withdrawnReason).toBe('Terminal sold');
  });

  it('applies the sampling gate from core when a batch is locked', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'LOCK'), BEFORE_ANYTHING));
    const joined = await inA(() =>
      addParticipation(cycle.id, { acoOrgId: newId(), airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
    );
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));
    await inA(() => advanceCycle(cycle.id, SAMPLING_ONLY, driver));

    await expect(
      inA(() =>
        recordSamplingLock({
          cycleId: cycle.id,
          participationId: joined.id,
          eligibleCount: 20,
          selectedCount: 3,
          now: SAMPLING_ONLY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SAMPLING_BELOW_MINIMUM' });

    const locked = await inA(() =>
      recordSamplingLock({
        cycleId: cycle.id,
        participationId: joined.id,
        eligibleCount: 20,
        selectedCount: 8,
        now: SAMPLING_ONLY,
      }),
    );
    expect(locked.sampling.state).toBe('LOCKED');
    expect(locked.sampling.lockedCount).toBe(8);
    expect(locked.sampling.shortfall).toBe(0);
    expect(locked.state).toBe('ACTIVE');

    await expect(
      inA(() =>
        recordSamplingLock({
          cycleId: cycle.id,
          participationId: joined.id,
          eligibleCount: 20,
          selectedCount: 8,
          now: SAMPLING_ONLY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BATCH_ALREADY_LOCKED' });
  });

  it('records the shortfall when an operator has fewer customers than the minimum', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'SHORT'), BEFORE_ANYTHING));
    const joined = await inA(() =>
      addParticipation(cycle.id, { acoOrgId: newId(), airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
    );
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));
    await inA(() => advanceCycle(cycle.id, SAMPLING_ONLY, driver));

    await expect(
      inA(() =>
        recordSamplingLock({
          cycleId: cycle.id,
          participationId: joined.id,
          eligibleCount: 3,
          selectedCount: 2,
          now: SAMPLING_ONLY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SAMPLING_BELOW_MINIMUM' });

    const locked = await inA(() =>
      recordSamplingLock({
        cycleId: cycle.id,
        participationId: joined.id,
        eligibleCount: 3,
        selectedCount: 3,
        now: SAMPLING_ONLY,
      }),
    );
    expect(locked.sampling.shortfall).toBe(2);
  });

  it('refuses a lock outside the sampling window', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'CLOSEDLOCK'), BEFORE_ANYTHING));
    const joined = await inA(() =>
      addParticipation(cycle.id, { acoOrgId: newId(), airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
    );
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));

    await expect(
      inA(() =>
        recordSamplingLock({
          cycleId: cycle.id,
          participationId: joined.id,
          eligibleCount: 20,
          selectedCount: 8,
          now: BEFORE_ANYTHING,
        }),
      ),
    ).rejects.toMatchObject({ code: 'WINDOW_NOT_OPEN' });
  });

  it('scores and then publishes, and stops there', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'PUB'), BEFORE_ANYTHING));
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));
    await inA(() => advanceCycle(cycle.id, AFTER_EVERYTHING, driver));

    await expect(inA(() => publishCycle(cycle.id, AFTER_EVERYTHING, actor))).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const scored = await inA(() => scoreCycle(cycle.id, AFTER_EVERYTHING, actor));
    expect(scored.state).toBe('SCORED');
    expect(scored.freezes.scoresFrozenAt).not.toBeNull();

    const published = await inA(() => publishCycle(cycle.id, AFTER_EVERYTHING, actor));
    expect(published.state).toBe('PUBLISHED');
    expect(published.nextTransition).toBeNull();

    await expect(inA(() => advanceCycle(cycle.id, AFTER_EVERYTHING, actor))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('closes the roster once the assessment window has closed', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'SHUT'), BEFORE_ANYTHING));

    await expect(
      inA(() =>
        addParticipation(
          cycle.id,
          { acoOrgId: newId(), airportId: null, minimumSamplingSize: null },
          AFTER_EVERYTHING,
        ),
      ),
    ).rejects.toMatchObject({ code: 'WINDOW_CLOSED' });
  });

  it('lets an operator join after the assessment window has opened', async () => {
    const programId = await inA(() => makeProgram());
    const cycle = await inA(() => createCycle(draft(programId, 'LATEJOIN'), BEFORE_ANYTHING));
    await inA(() => scheduleCycle(cycle.id, BEFORE_ANYTHING, actor));
    await inA(() => advanceCycle(cycle.id, BOTH_OPEN, driver));

    const joined = await inA(() =>
      addParticipation(cycle.id, { acoOrgId: newId(), airportId: null, minimumSamplingSize: 9 }, BOTH_OPEN),
    );
    expect(joined.sampling.minimumSamplingSize).toBe(9);
  });
});

const ORG_TASKS = newId();

const taskPerson: Principal = {
  userId: 'ops',
  subject: 'sub-ops',
  email: null,
  displayName: 'ops',
  memberships: [{ orgId: ORG_TASKS, roles: ['ADMIN'], capabilities: [], active: true }],
};

function inTaskOrg<T>(fn: () => T): T {
  return runAsPrincipal({ requestId: newId(), principal: taskPerson, orgId: ORG_TASKS }, fn);
}

const SAMPLING_OPENS_AT = new Date('2026-03-31T18:30:00Z');
const REMINDER_AT = new Date('2026-05-24T03:30:00.000Z');

async function scheduledCycle(code: string, withReminder = false): Promise<string> {
  const program = await createProgram({
    code: `P-${code}`,
    name: 'Programme',
    description: null,
    formScope: 'INTERNATIONAL',
    defaultTimezone: TZ,
    defaultMinimumSamplingSize: 5,
  });
  const cycle = await createCycle(
    {
      programId: program.id,
      code,
      name: `Cycle ${code}`,
      windows: { ...WINDOWS },
      minimumSamplingSize: null,
      reminders: withReminder
        ? [{ label: 'One week left', audience: 'CUSTOMER', at: { wall: '2026-05-24T09:00', tz: TZ } }]
        : [],
    },
    BEFORE_ANYTHING,
  );
  await scheduleCycle(cycle.id, BEFORE_ANYTHING, actor);
  return cycle.id;
}

describe('the scheduled task runner', () => {
  it('gives one due task to exactly one runner', async () => {
    await inTaskOrg(() => scheduledCycle('CLAIM'));

    const first = await inTaskOrg(() =>
      claimDueTask({ now: SAMPLING_OPENS_AT, workerId: 'worker-1', leaseMs: 60_000 }),
    );
    const second = await inTaskOrg(() =>
      claimDueTask({ now: SAMPLING_OPENS_AT, workerId: 'worker-2', leaseMs: 60_000 }),
    );

    expect(first?.transition).toBe('OPEN_SAMPLING');
    expect(first?.leaseOwner).toBe('worker-1');
    expect(first?.attempts).toBe(1);
    // only the OPEN_SAMPLING boundary has passed, and worker-1 holds it
    expect(second).toBeNull();
  });

  it('does not claim work that is not due yet', async () => {
    await inTaskOrg(() => scheduledCycle('EARLY'));

    const claimed = await inTaskOrg(() =>
      claimDueTask({
        now: new Date(SAMPLING_OPENS_AT.getTime() - 1000),
        workerId: 'worker-1',
        leaseMs: 60_000,
      }),
    );
    expect(claimed).toBeNull();
  });

  it('lets another runner take over once a lease has expired, carrying the attempt count', async () => {
    await inTaskOrg(() => scheduledCycle('LEASE'));

    const first = await inTaskOrg(() =>
      claimDueTask({ now: SAMPLING_OPENS_AT, workerId: 'worker-1', leaseMs: 60_000 }),
    );
    const afterExpiry = new Date(SAMPLING_OPENS_AT.getTime() + 61_000);
    const second = await inTaskOrg(() =>
      claimDueTask({ now: afterExpiry, workerId: 'worker-2', leaseMs: 60_000 }),
    );

    expect(second?._id).toBe(first?._id);
    expect(second?.leaseOwner).toBe('worker-2');
    // the count carries over, so a task that kills its runner every time still dies
    expect(second?.attempts).toBe(2);
  });

  it('will not let a runner report on work it no longer holds', async () => {
    await inTaskOrg(() => scheduledCycle('LOST'));
    const task = await inTaskOrg(() =>
      claimDueTask({ now: SAMPLING_OPENS_AT, workerId: 'worker-1', leaseMs: 60_000 }),
    );

    expect(await inTaskOrg(() => completeTask(task!._id, 'worker-2', SAMPLING_OPENS_AT, 'done'))).toBe(
      false,
    );
    expect(await inTaskOrg(() => completeTask(task!._id, 'worker-1', SAMPLING_OPENS_AT, 'done'))).toBe(
      true,
    );
    expect(await inTaskOrg(() => completeTask(task!._id, 'worker-1', SAMPLING_OPENS_AT, 'again'))).toBe(
      false,
    );
  });

  it('retries a failure on a growing delay, then retires it', async () => {
    await inTaskOrg(() => scheduledCycle('RETRY'));

    let outcome: string = 'RETRY';
    let attempts = 0;
    let now = SAMPLING_OPENS_AT;

    while (outcome === 'RETRY' && attempts < 10) {
      const claimed = await inTaskOrg(() => claimDueTask({ now, workerId: 'w', leaseMs: 1000 }));
      if (!claimed) break;
      outcome = await inTaskOrg(() => failTask(claimed._id, 'w', now, 'boom'));
      attempts += 1;
      now = new Date(now.getTime() + 24 * 3600 * 1000);
    }

    expect(outcome).toBe('DEAD');
    expect(attempts).toBe(5);

    const cycleId = await currentCycleId();
    const tasks = await inTaskOrg(() => listCycleTasks(cycleId!));
    const dead = tasks.find((t) => t.state === 'DEAD');
    expect(dead?.lastError).toContain('boom');
  });

  it('backs off exponentially up to a ceiling', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(20)).toBe(3_600_000);
  });

  it('advances a cycle when the drain reaches its boundary, once and only once', async () => {
    const cycleId = await inTaskOrg(() => scheduledCycle('DRAIN'));

    const first = await drainDueTasks({
      now: SAMPLING_OPENS_AT,
      workerId: 'worker-1',
      log: silentLog,
    });
    expect(first.claimed).toBe(1);
    expect(first.completed).toBe(1);

    const stored = await inTaskOrg(() => CycleModel.findOne({ _id: cycleId }).lean().exec());
    expect(stored?.state).toBe('SAMPLING_OPEN');
    expect(stored?.transitions.filter((t) => t.name === 'OPEN_SAMPLING')).toHaveLength(1);

    // nothing else is due at that instant, so a second drain is a no-op
    const second = await drainDueTasks({
      now: SAMPLING_OPENS_AT,
      workerId: 'worker-2',
      log: silentLog,
    });
    expect(second.claimed).toBe(0);
  });

  it('records the driver rather than a taskPerson on an automatic transition', async () => {
    const cycleId = await inTaskOrg(() => scheduledCycle('WHO'));
    await drainDueTasks({ now: SAMPLING_OPENS_AT, workerId: 'worker-1', log: silentLog });

    const stored = await inTaskOrg(() => CycleModel.findOne({ _id: cycleId }).lean().exec());
    const opened = stored?.transitions.find((t) => t.name === 'OPEN_SAMPLING');
    expect(opened?.automatic).toBe(true);
    expect(opened?.actorUserId).toBeNull();
  });

  it('completes an advance task for a cycle that was unscheduled instead of failing forever', async () => {
    const cycleId = await inTaskOrg(() => scheduledCycle('UNDONE'));
    await inTaskOrg(() => unscheduleCycle(cycleId, BEFORE_ANYTHING, actor));

    // the pending tasks are withdrawn on unschedule, so re-enqueue one by hand
    // to stand in for a task that was already claimed when that happened
    await inTaskOrg(() =>
      ScheduledTaskModel.create({
        orgId: ORG_TASKS,
        kind: 'CYCLE_ADVANCE',
        cycleId,
        reminderId: null,
        transition: 'OPEN_SAMPLING',
        runAt: SAMPLING_OPENS_AT,
        state: 'PENDING',
        dedupeKey: `orphan:${cycleId}`,
        attempts: 0,
        maxAttempts: 5,
      }),
    );

    const report = await drainDueTasks({
      now: SAMPLING_OPENS_AT,
      workerId: 'worker-1',
      log: silentLog,
    });
    expect(report.completed).toBe(1);
    expect(report.dead).toBe(0);

    const tasks = await inTaskOrg(() => listCycleTasks(cycleId));
    expect(tasks[0]?.state).toBe('DONE');
  });

  it('resolves reminder recipients at send time and writes one dispatch each', async () => {
    const cycleId = await inTaskOrg(() => scheduledCycle('REMIND', true));
    await inTaskOrg(() => advanceCycle(cycleId, REMINDER_AT, { userId: 'ops', automatic: false }));

    const done = await inTaskOrg(() =>
      addParticipation(cycleId, { acoOrgId: newId(), airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
    );
    const outstanding = await inTaskOrg(() =>
      addParticipation(cycleId, { acoOrgId: newId(), airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
    );
    const gone = await inTaskOrg(() =>
      addParticipation(cycleId, { acoOrgId: newId(), airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
    );

    await inTaskOrg(() =>
      recordParticipationProgress(cycleId, done.id, { customerInvited: 5, customerSubmitted: 5 }, BEFORE_ANYTHING),
    );
    await inTaskOrg(() =>
      recordParticipationProgress(
        cycleId,
        outstanding.id,
        { customerInvited: 5, customerSubmitted: 2 },
        BEFORE_ANYTHING,
      ),
    );
    await inTaskOrg(() =>
      recordParticipationProgress(cycleId, gone.id, { customerInvited: 5, customerSubmitted: 0 }, BEFORE_ANYTHING),
    );
    await inTaskOrg(() => withdrawParticipation(cycleId, gone.id, 'Left the programme', BEFORE_ANYTHING));

    const report = await drainDueTasks({ now: REMINDER_AT, workerId: 'worker-1', log: silentLog });
    expect(report.completed).toBeGreaterThan(0);

    const dispatches = await inTaskOrg(() => ReminderDispatchModel.find({}).lean().exec());
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.participationId).toBe(outstanding.id);
    expect(dispatches[0]?.reason).toContain('3 sampled customers');
  });

  it('cannot send the same reminder to the same recipient twice', async () => {
    const cycleId = await inTaskOrg(() => scheduledCycle('ONCE', true));
    await inTaskOrg(() => advanceCycle(cycleId, REMINDER_AT, { userId: 'ops', automatic: false }));
    const joined = await inTaskOrg(() =>
      addParticipation(cycleId, { acoOrgId: newId(), airportId: null, minimumSamplingSize: null }, BEFORE_ANYTHING),
    );
    await inTaskOrg(() =>
      recordParticipationProgress(cycleId, joined.id, { customerInvited: 4, customerSubmitted: 0 }, BEFORE_ANYTHING),
    );

    await drainDueTasks({ now: REMINDER_AT, workerId: 'worker-1', log: silentLog });
    expect(await inTaskOrg(() => ReminderDispatchModel.countDocuments({}).exec())).toBe(1);

    // put the reminder task back as if the runner had died after writing the row
    await inTaskOrg(() =>
      ScheduledTaskModel.updateMany(
        { cycleId, kind: 'CYCLE_REMINDER' },
        { $set: { state: 'PENDING', leaseOwner: null, leaseExpiresAt: null } },
      ).exec(),
    );

    await drainDueTasks({ now: REMINDER_AT, workerId: 'worker-2', log: silentLog });
    expect(await inTaskOrg(() => ReminderDispatchModel.countDocuments({}).exec())).toBe(1);
  });
});

async function currentCycleId(): Promise<string | undefined> {
  const found = await inTaskOrg(() => CycleModel.findOne({}).lean().exec());
  return found?._id;
}


describe('the module definition', () => {
  it('passes the boot time route policy check', () => {
    expect(() => checkModule(cyclesModule)).not.toThrow();
  });

  it('builds a router, so no two routes claim the same method and path', () => {
    const pass: RequestHandler = (_req, _res, next) => next();
    expect(() =>
      mountModules([cyclesModule], {
        authenticate: pass,
        enterOrgScope: pass,
        enterSelfScope: pass,
        log: silentLog,
      }),
    ).not.toThrow();
  });

  it('guards every route with a capability it declares, inside an organisation', () => {
    const declared = new Set(cyclesModule.capabilities);

    for (const route of cyclesModule.routes) {
      expect(route.policy.tenancy).toBe('ORG');
      expect(route.policy.requiredCapability).not.toBeNull();
      expect(declared.has(route.policy.requiredCapability ?? '')).toBe(true);
    }
  });

  it('registers the literal programme paths before the cycle id pattern', () => {
    const paths = cyclesModule.routes.map((r) => r.path);

    expect(paths.indexOf('/programs')).toBeLessThan(paths.indexOf('/:cycleId'));
    expect(paths.indexOf('/programs/:programId')).toBeLessThan(paths.indexOf('/:cycleId'));
  });

  it('needs a different authority to schedule, run, score and publish', () => {
    const capabilityFor = (path: string): string | null =>
      cyclesModule.routes.find((r) => r.path === path && r.method === 'post')?.policy
        .requiredCapability ?? null;

    const authorities = [
      capabilityFor('/:cycleId/schedule'),
      capabilityFor('/:cycleId/advance'),
      capabilityFor('/:cycleId/score'),
      capabilityFor('/:cycleId/publish'),
    ];
    expect(new Set(authorities).size).toBe(4);
    expect(authorities.every((c) => c !== null)).toBe(true);
  });
});
