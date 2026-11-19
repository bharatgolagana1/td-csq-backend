import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { idString } from '../src/core/ids.js';
import { JobModel } from '../src/core/jobs.model.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { CycleParticipantModel } from '../src/modules/cycles/cycle-participants.model.js';
import { CycleModel } from '../src/modules/cycles/cycles.model.js';
import { fromInstant } from '../src/modules/cycles/domain/windows.js';
import { runSamplingReminders, SAMPLING_REMINDER_JOB } from '../src/modules/cycles/reminders.service.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';
import { configureNotifications } from '../src/modules/notifications/notifications.service.js';
import { seedSurveys } from '../src/seed/surveys.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, createTestOperator, expectError, grantTasks, revokeTasks } from './helpers/fixtures.js';

let t: TestApp;
let platform: TestUser;
let operator: TestUser;
let other: TestUser;
let cycleId: string;
const DAY = 86_400_000;
const wall = (days: number) => fromInstant(new Date(Date.now() + days * DAY), 'Asia/Kolkata');
const url = () => `/api/v1/cycles/${cycleId}/reminders/send`;
const target = () => idString(operator.org._id);
const configure = (deliver = vi.fn(async () => { /* Successful transport. */ })) => {
  configureNotifications({ transport: { channel: 'LOG', deliver }, from: 'test@csq.local', webUrl: 'http://localhost:5173', brandName: 'CSQ' });
  return deliver;
};
/** A transport that refuses mail to one address and delivers the rest. */
const failFor = (email: string) => {
  configureNotifications({
    transport: { channel: 'LOG', deliver: async (message: { to: string }) => { if (message.to === email) throw new Error('Mailbox unavailable'); } },
    from: 'test@csq.local', webUrl: 'http://localhost:5173', brandName: 'CSQ',
  });
};

beforeAll(async () => {
  t = await createTestApp();
  await seedSurveys();
  platform = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  operator = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'REM-A' });
  other = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'REM-B' });
  const empty = await createTestOperator({ code: 'REM-EMPTY', airportIata: 'DEL' });
  const airportId = await airportIdByIata('DEL');
  expect((await platform.put(`/api/v1/airports/${airportId}/market-share`).send({ entries: [
    { acoId: target(), sharePct: 40 }, { acoId: idString(other.org._id), sharePct: 40 }, { acoId: idString(empty._id), sharePct: 20 },
  ] })).status).toBe(200);
  const created = await platform.post('/api/v1/cycles').send({
    name: 'Reminder checks', code: 'REM-CHECKS', type: 'DOMESTIC', minSampleSize: 1,
    sampling: { start: wall(-1), end: wall(1) }, assessment: { start: wall(2), end: wall(10) },
    participatingAirportIds: [airportId], participatingAcoIds: [target(), idString(other.org._id), idString(empty._id)],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  cycleId = created.body.data.id as string;
  expect((await platform.post(`/api/v1/cycles/${cycleId}/publish`)).status).toBe(200);
});
beforeEach(async () => {
  await JobModel.deleteMany({ type: 'cycles.manualSamplingReminder' });
  await NotificationModel.deleteMany({ template: 'sampling-reminder' });
  await AuditModel.deleteMany({ action: /^sampling\.reminder\./ });
  await CycleParticipantModel.updateMany({ cycleId }, { $set: { 'reminders.manualAt': null, 'reminders.lastAt': null } });
});
afterEach(() => { configure(); });
afterAll(() => t.close());

describe('manual sampling reminders', () => {
  it('targets one of multiple unlocked operators, with history and actor/request audit', async () => {
    const result = await platform.post(url()).send({ kind: 'SAMPLING', acoId: target() });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toEqual({ kind: 'SAMPLING', sent: 1, recipients: [{ acoId: target(), to: [operator.user.email] }] });
    const mails = await NotificationModel.find({ template: 'sampling-reminder' }).lean();
    expect(mails).toHaveLength(1);
    expect(idString(mails[0]!.refs.acoId!)).toBe(target());
    expect(mails[0]!.status).toBe('SENT');
    const record = await AuditModel.findOne({ action: 'sampling.reminder.sent' }).lean();
    expect(record?.actorEmail).toBe(platform.user.email);
    expect(record?.requestId).toBe(result.headers['x-request-id']);
  });

  it('keeps cycle-wide behavior and counts only eligible recipients', async () => {
    const result = await platform.post(url()).send({ kind: 'SAMPLING' });
    expect(result.status).toBe(200);
    expect(result.body.data.sent).toBe(2);
    expect(result.body.data.recipients).toHaveLength(3);
    const empty = await CycleParticipantModel.findOne({ cycleId, acoId: { $nin: [target(), idString(other.org._id)] } }).lean();
    expect(empty?.reminders.manualAt).toBeNull();
  });

  it('atomically suppresses concurrent and repeated sends across clients', async () => {
    const requests = await Promise.all(Array.from({ length: 8 }, () => platform.post(url()).send({ kind: 'SAMPLING', acoId: target() })));
    expect(requests.every((res) => res.status === 200)).toBe(true);
    expect(requests.reduce((sum, res) => sum + (res.body.data.sent as number), 0)).toBe(1);
    const repeated = await platform.post(url()).send({ kind: 'SAMPLING', acoId: target() });
    expect(repeated.body.data).toEqual({ kind: 'SAMPLING', sent: 0, recipients: [{ acoId: target(), to: [] }] });
    expect(await NotificationModel.countDocuments({ template: 'sampling-reminder' })).toBe(1);
  });

  it('records delivery failures, returns a typed refusal and allows a retry', async () => {
    const deliver = configure(vi.fn(async () => { throw new Error('SMTP unavailable'); }));
    expectError(await platform.post(url()).send({ kind: 'SAMPLING', acoId: target() }), 412, 'PRECONDITION_FAILED');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await NotificationModel.countDocuments({ template: 'sampling-reminder', status: 'FAILED' })).toBe(1);
    expect(await AuditModel.countDocuments({ action: 'sampling.reminder.failed' })).toBe(1);
    expect(await AuditModel.countDocuments({ action: 'sampling.reminder.sent' })).toBe(0);
    expect((await CycleParticipantModel.findOne({ cycleId, acoId: target() }).lean())?.reminders.manualAt).toBeNull();
    configure();
    expect((await platform.post(url()).send({ kind: 'SAMPLING', acoId: target() })).body.data.sent).toBe(1);
  });

  it('rejects missing/nonparticipating targets and locked samples', async () => {
    expectError(await platform.post('/api/v1/cycles/0123456789abcdef01234567/reminders/send').send({ kind: 'SAMPLING' }), 404, 'NOT_FOUND');
    expectError(await platform.post(url()).send({ kind: 'SAMPLING', acoId: 'invalid' }), 400, 'VALIDATION');
    const outsider = await createTestOperator({ code: 'REM-OUT', airportIata: 'DEL' });
    for (const acoId of ['0123456789abcdef01234567', idString(outsider._id)]) {
      expectError(await platform.post(url()).send({ kind: 'SAMPLING', acoId }), 404, 'NOT_FOUND');
    }
    await CycleParticipantModel.updateOne({ cycleId, acoId: target() }, { $set: { 'sampling.status': 'LOCKED' } });
    try {
      expectError(await platform.post(url()).send({ kind: 'SAMPLING', acoId: target() }), 412, 'PRECONDITION_FAILED');
    } finally {
      await CycleParticipantModel.updateOne({ cycleId, acoId: target() }, { $set: { 'sampling.status': 'NOT_STARTED' } });
    }
  });

  it('rejects an expired window before the clock closes it, but not one opened early by hand', async () => {
    const cycle = await CycleModel.findById(cycleId).lean();
    await CycleModel.updateOne({ _id: cycleId }, { $set: { 'sampling.end.utc': new Date(Date.now() - DAY) } });
    try {
      const over = await platform.post(url()).send({ kind: 'SAMPLING', acoId: target() });
      expectError(over, 412, 'PRECONDITION_FAILED');
      expect(over.body.error.message).toMatch(/^Sampling is over/);
    } finally {
      await CycleModel.updateOne({ _id: cycleId }, { $set: { sampling: cycle!.sampling } });
    }
    // SAMPLING_OPEN before the window's start: ACFI opened sampling early, so reminders go out.
    await CycleModel.updateOne({ _id: cycleId }, { $set: { 'sampling.start.utc': new Date(Date.now() + DAY / 2) } });
    try {
      expect((await platform.post(url()).send({ kind: 'SAMPLING', acoId: target() })).body.data.sent).toBe(1);
    } finally {
      await CycleModel.updateOne({ _id: cycleId }, { $set: { sampling: cycle!.sampling } });
    }
  });

  it('keeps reminding the other operators when one delivery fails, then retries only that one', async () => {
    failFor(other.user.email);
    const failed = await platform.post(url()).send({ kind: 'SAMPLING' });
    expectError(failed, 412, 'PRECONDITION_FAILED');
    expect(failed.body.error.message).toBe('Could not deliver 1 of 2 sampling reminders (1 sent). See Notifications for the error; sending again retries only the failed ones.');
    expect(failed.body.error.details).toEqual({ sent: 1, failed: [{ acoId: idString(other.org._id), to: other.user.email }] });
    expect(await NotificationModel.countDocuments({ template: 'sampling-reminder', to: operator.user.email, status: 'SENT' })).toBe(1);
    const deliver = configure();
    expect((await platform.post(url()).send({ kind: 'SAMPLING' })).body.data.sent).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await NotificationModel.countDocuments({ template: 'sampling-reminder', to: operator.user.email })).toBe(1);
    expect(await NotificationModel.countDocuments({ template: 'sampling-reminder', to: other.user.email, status: 'SENT' })).toBe(1);
  });

  it('the clock makes one attempt per scheduled reminder: a failed address is not retried every tick', async () => {
    const cycle = await CycleModel.findById(cycleId).lean();
    // One reminder on the day after sampling opened, at 09:00 local; due well before the window ends.
    await CycleModel.updateOne({ _id: cycleId }, { $set: { 'reminders.sampling': { count: 1, everyDays: 1 }, publishedAt: null } });
    await CycleParticipantModel.updateMany({ cycleId }, { $set: { 'reminders.sent': 0 } });
    const now = new Date(cycle!.sampling.end.utc.getTime() - 60_000);
    failFor(other.user.email);
    try {
      await runSamplingReminders(now);
      const rows = await JobModel.find({ type: SAMPLING_REMINDER_JOB }).lean();
      // Three participants (one has no admin to mail); none is left FAILED for the next tick to retry.
      expect(rows.map((row) => row.status)).toEqual(['DONE', 'DONE', 'DONE']);
      expect(await NotificationModel.countDocuments({ template: 'sampling-reminder', to: other.user.email, status: 'FAILED' })).toBe(1);
      await runSamplingReminders(new Date(now.getTime() + 30_000));
      expect(await NotificationModel.countDocuments({ template: 'sampling-reminder' })).toBe(2);
    } finally {
      await JobModel.deleteMany({ type: SAMPLING_REMINDER_JOB });
      await CycleModel.updateOne({ _id: cycleId }, { $set: { reminders: cycle!.reminders, publishedAt: cycle!.publishedAt } });
      await CycleParticipantModel.updateMany({ cycleId }, { $set: { 'reminders.sent': 0 } });
    }
  });

  it('requires authentication, both tasks and platform scope', async () => {
    expectError(await t.anon.post(url()).send({ kind: 'SAMPLING' }), 401, 'UNAUTHENTICATED');
    expectError(await operator.post(url()).send({ kind: 'SAMPLING' }), 403, 'FORBIDDEN');
    await grantTasks('ACO_ADMIN', ['cycles.operate']);
    expectError(await operator.post(url()).send({ kind: 'SAMPLING' }), 403, 'FORBIDDEN');
    await grantTasks('ACO_ADMIN', ['notifications.send']);
    expectError(await operator.post(url()).send({ kind: 'SAMPLING', acoId: idString(other.org._id) }), 403, 'FORBIDDEN');
    await revokeTasks('SUPER_ADMIN', ['notifications.send']);
    try {
      expectError(await platform.post(url()).send({ kind: 'SAMPLING' }), 403, 'FORBIDDEN');
    } finally {
      await grantTasks('SUPER_ADMIN', ['notifications.send']);
    }
  });

  it('retries only the failed recipient after partial delivery to multiple admins', async () => {
    await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: target(), email: 'second-admin@reminder.test' });
    let attempts = 0;
    configure(vi.fn(async () => {
      attempts += 1;
      if (attempts === 2) throw new Error('Second recipient failed');
    }));
    expectError(await platform.post(url()).send({ kind: 'SAMPLING', acoId: target() }), 412, 'PRECONDITION_FAILED');
    expect((await CycleParticipantModel.findOne({ cycleId, acoId: target() }).lean())?.reminders.manualAt).toBeInstanceOf(Date);
    const deliver = configure();
    expect((await platform.post(url()).send({ kind: 'SAMPLING', acoId: target() })).body.data.sent).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await NotificationModel.countDocuments({ template: 'sampling-reminder', status: 'SENT' })).toBe(2);
    expect(await AuditModel.countDocuments({ action: 'sampling.reminder.sent' })).toBe(2);
  });
});
