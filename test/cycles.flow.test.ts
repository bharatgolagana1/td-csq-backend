// The cycle clock: the two scheduler jobs driven with a fake `now` against a
// published cycle — window instants move the status (trigger CLOCK, one
// `once()` slot per cycle + status + instant, catch-up after downtime, never
// past ASSESSMENT_CLOSED) and sampling reminders go out on the derived
// schedule, idempotently, to operators that have not locked.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemContext } from '../src/core/auth/system.js';
import { clearEventHandlers, emit, on, type Events } from '../src/core/events.js';
import { idString } from '../src/core/ids.js';
import { JobModel } from '../src/core/jobs.model.js';
import { logger } from '../src/core/logger.js';
import { cyclesSamplingReminders, cyclesTransitions } from '../src/jobs/cycles.jobs.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { registerCycleHandlers } from '../src/modules/cycles/cycles.handlers.js';
import { getCycle, getParticipant, isMarketShareFrozen, setParticipantSampling, transition } from '../src/modules/cycles/cycles.service.js';
import { addCalendarDays } from '../src/modules/cycles/domain/derive.js';
import { fromInstant, toInstant } from '../src/modules/cycles/domain/windows.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';
import { seedSurveys } from '../src/seed/surveys.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, createTestOperator, expectError } from './helpers/fixtures.js';

const TZ = 'Asia/Kolkata';
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

let t: TestApp;
let superAdmin: TestUser;
let del: string;
let acoP: string;
let acoQ: string;
let cycleId: string;
let initiationDate: string;
let samplingStart: Date;
let assessmentEnd: Date;
const transitioned: Events['cycle.transitioned'][] = [];
const ctx = systemContext('test: cycle clock');

function at(date: string, time: string): Date {
  return toInstant({ wall: `${date}T${time}`, tz: TZ });
}

async function tick(now: Date): Promise<void> {
  await cyclesTransitions({ now, log: logger });
}

async function remind(now: Date): Promise<void> {
  await cyclesSamplingReminders({ now, log: logger });
}

function jobs(type: string) {
  return JobModel.find({ type }).sort({ ranAt: 1, slot: 1 }).lean();
}

beforeAll(async () => {
  t = await createTestApp();
  clearEventHandlers();
  registerCycleHandlers();
  on('cycle.transitioned', 'test.flow.recordTransitioned', async (payload) => {
    transitioned.push(payload);
  });

  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  del = await airportIdByIata('DEL');
  acoP = idString((await createTestOperator({ code: 'FL-P', name: 'Papa Cargo', airportIata: 'DEL' }))._id);
  acoQ = idString((await createTestOperator({ code: 'FL-Q', name: 'Quebec Cargo', airportIata: 'DEL' }))._id);
  await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: acoP, email: 'admin@papa.test', name: 'Priya Papa' });
  await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: acoQ, email: 'admin@quebec.test', name: 'Qadir Quebec' });
  await superAdmin.put(`/api/v1/airports/${del}/market-share`).send({ entries: [{ acoId: acoP, sharePct: 50 }, { acoId: acoQ, sharePct: 50 }] });
  await seedSurveys();

  initiationDate = fromInstant(new Date(Date.now() + 2 * DAY), TZ).slice(0, 10);
  const created = await superAdmin.post('/api/v1/cycles').send({
    name: 'Clock cycle',
    code: 'CSQ-CLOCK',
    type: 'DOMESTIC',
    initiationDate,
    minSampleSize: 5,
    reminders: { sampling: { count: 3, everyDays: 3 }, assessment: { count: 2, everyDays: 7 } },
    participatingAirportIds: [del],
    participatingAcoIds: [acoP, acoQ],
  });
  cycleId = created.body.data.id;
  const publish = await superAdmin.post(`/api/v1/cycles/${cycleId}/publish`);
  expect(publish.status).toBe(200);
  expect(publish.body.data.status).toBe('PUBLISHED');
  samplingStart = new Date(publish.body.data.sampling.start.utc);
  assessmentEnd = new Date(publish.body.data.assessment.end.utc);
  transitioned.length = 0;
});
afterAll(() => t.close());

describe('cycles.transitions', () => {
  it('does nothing before the window instant', async () => {
    await tick(new Date(samplingStart.getTime() - MINUTE));
    expect((await getCycle(ctx, cycleId)).status).toBe('PUBLISHED');
    expect(await jobs('cycles.transitions')).toEqual([]);
    expect(transitioned).toEqual([]);
  });

  it('opens sampling at sampling.start: trigger CLOCK, one DONE slot, system audit row, admins mailed', async () => {
    const now = new Date(samplingStart.getTime() + MINUTE);
    await tick(now);
    expect((await getCycle(ctx, cycleId)).status).toBe('SAMPLING_OPEN');
    expect(transitioned).toEqual([{ cycleId, from: 'PUBLISHED', to: 'SAMPLING_OPEN', trigger: 'CLOCK' }]);

    const rows = await jobs('cycles.transitions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refId: cycleId, slot: `SAMPLING_OPEN@${samplingStart.toISOString()}`, status: 'DONE', detail: 'PUBLISHED → SAMPLING_OPEN' });

    const audit = await AuditModel.findOne({ action: 'cycle.transitioned', entityId: cycleId }).lean();
    expect(audit).toMatchObject({ actorUserId: null, actorEmail: null, before: { status: 'PUBLISHED' }, after: { status: 'SAMPLING_OPEN', trigger: 'CLOCK' } });
    expect((audit!.after as { reason: string }).reason).toContain('SAMPLING_START');

    const mails = await NotificationModel.find({ template: 'cycle-published', 'refs.cycleId': cycleId, subject: /^Sampling is open/ }).lean();
    expect(mails.map((mail) => mail.to).sort()).toEqual(['admin@papa.test', 'admin@quebec.test']);

    // The same tick again is a no-op: the slot is taken.
    await tick(now);
    await tick(new Date(now.getTime() + 5 * MINUTE));
    expect(await jobs('cycles.transitions')).toHaveLength(1);
    expect(transitioned).toHaveLength(1);
  });
});

describe('cycles.samplingReminders', () => {
  it('sends reminder 1 on its day to every unlocked participant, once', async () => {
    const now = at(addCalendarDays(initiationDate, 3), '09:30');
    await remind(now);
    const mails = await NotificationModel.find({ template: 'sampling-reminder', 'refs.cycleId': cycleId }).lean();
    expect(mails.map((mail) => mail.to).sort()).toEqual(['admin@papa.test', 'admin@quebec.test']);
    expect(mails[0]!.subject).toBe('Sampling closes in 7 days · 0 / 5 selected · Clock cycle');
    expect(mails[0]!.vars).toMatchObject({ closesInDays: 7, required: 5, selected: 0, tz: TZ });

    const rows = await jobs('cycles.samplingReminders');
    expect(rows.map((row) => [row.refId, row.slot, row.status]).sort()).toEqual([
      [`${cycleId}:${acoP}`, '0', 'DONE'],
      [`${cycleId}:${acoQ}`, '0', 'DONE'],
    ]);
    expect((await getParticipant(cycleId, acoP))?.reminders).toMatchObject({ sent: 1, lastAt: now.toISOString() });

    await remind(now);
    await remind(new Date(now.getTime() + 60 * MINUTE));
    expect(await NotificationModel.countDocuments({ template: 'sampling-reminder', 'refs.cycleId': cycleId })).toBe(2);
    expect(await jobs('cycles.samplingReminders')).toHaveLength(2);
  });

  it('stops for a locked participant; after downtime only the latest overdue reminder goes out', async () => {
    await setParticipantSampling(cycleId, acoP, { status: 'LOCKED', selectedCount: 5, lockedAt: new Date(), lockedBy: idString(superAdmin.user._id) });
    // Reminders 2 (day 6) and 3 (day 9) are both overdue on day 9 at 10:00.
    await remind(at(addCalendarDays(initiationDate, 9), '10:00'));
    const quebec = await NotificationModel.find({ template: 'sampling-reminder', 'refs.cycleId': cycleId, to: 'admin@quebec.test' }).sort({ createdAt: 1 }).lean();
    expect(quebec).toHaveLength(2);
    expect(quebec[1]!.subject).toBe('Sampling closes in 1 day · 0 / 5 selected · Clock cycle');
    expect(await NotificationModel.countDocuments({ template: 'sampling-reminder', 'refs.cycleId': cycleId, to: 'admin@papa.test' })).toBe(1);

    const rows = await jobs('cycles.samplingReminders');
    expect(rows.map((row) => [row.refId, row.slot]).sort()).toEqual([
      [`${cycleId}:${acoP}`, '0'],
      [`${cycleId}:${acoQ}`, '0'],
      [`${cycleId}:${acoQ}`, '2'],
    ]);
    expect((await getParticipant(cycleId, acoQ))?.reminders.sent).toBe(3);
    expect((await getParticipant(cycleId, acoP))?.reminders.sent).toBe(1);

    await remind(at(addCalendarDays(initiationDate, 9), '12:00'));
    expect(await jobs('cycles.samplingReminders')).toHaveLength(3);
  });
});

describe('catch-up and scoring', () => {
  it('after downtime the clock takes every due step in order and stops at ASSESSMENT_CLOSED', async () => {
    const now = new Date(assessmentEnd.getTime() + MINUTE);
    const before = transitioned.length;
    await tick(now);
    const cycle = await getCycle(ctx, cycleId);
    expect(cycle.status).toBe('ASSESSMENT_CLOSED');
    expect(cycle.marketShareFrozen).toBe(true);
    expect(await isMarketShareFrozen(cycleId)).toBe(true);
    expect(transitioned.slice(before).map((e) => [e.from, e.to, e.trigger])).toEqual([
      ['SAMPLING_OPEN', 'SAMPLING_CLOSED', 'CLOCK'],
      ['SAMPLING_CLOSED', 'ASSESSMENT_OPEN', 'CLOCK'],
      ['ASSESSMENT_OPEN', 'ASSESSMENT_CLOSED', 'CLOCK'],
    ]);
    expect((await jobs('cycles.transitions')).map((row) => row.slot.split('@')[0])).toEqual(['SAMPLING_OPEN', 'SAMPLING_CLOSED', 'ASSESSMENT_OPEN', 'ASSESSMENT_CLOSED']);

    // Sampling closed with Quebec unlocked: its admin is told; Papa (locked) is not.
    const closed = await NotificationModel.find({ template: 'sampling-closed', 'refs.cycleId': cycleId }).lean();
    expect(closed.map((mail) => mail.to)).toEqual(['admin@quebec.test']);
    expect(closed[0]!.body).toContain('0 of 5 selected');

    // No reminders once sampling is over.
    await remind(now);
    expect(await jobs('cycles.samplingReminders')).toHaveLength(3);
  });

  it('SCORED comes from scoring.completed (not provisional), then the clock has nothing left to do', async () => {
    await emit('scoring.completed', { cycleId, provisional: true }, { ctx });
    expect((await getCycle(ctx, cycleId)).status).toBe('ASSESSMENT_CLOSED');
    await emit('scoring.completed', { cycleId, provisional: false }, { ctx });
    const scored = await getCycle(ctx, cycleId);
    expect(scored.status).toBe('SCORED');
    expect(scored.scoredAt).toBeTruthy();
    expect(transitioned.at(-1)).toEqual({ cycleId, from: 'ASSESSMENT_CLOSED', to: 'SCORED', trigger: 'CLOCK' });

    const before = transitioned.length;
    await tick(new Date(assessmentEnd.getTime() + DAY));
    expect(transitioned).toHaveLength(before);
    expect(await jobs('cycles.transitions')).toHaveLength(4);

    // The exported transition() under a system context defaults to CLOCK and only takes AUTO edges.
    await expect(transition(ctx, cycleId, 'ARCHIVED', 'clock cannot archive')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const archived = await superAdmin.post(`/api/v1/cycles/${cycleId}/transition`).send({ to: 'ARCHIVED', reason: 'Done' });
    expect(archived.body.data.status).toBe('ARCHIVED');
    expectError(await superAdmin.post(`/api/v1/cycles/${cycleId}/publish`), 412, 'PRECONDITION_FAILED');
  });
});
