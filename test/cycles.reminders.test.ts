import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { idString } from '../src/core/ids.js';
import { JobModel } from '../src/core/jobs.model.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { CycleParticipantModel } from '../src/modules/cycles/cycle-participants.model.js';
import { CycleModel } from '../src/modules/cycles/cycles.model.js';
import { fromInstant } from '../src/modules/cycles/domain/windows.js';
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

  it('rejects expired or future windows even before the clock updates status', async () => {
    const cycle = await CycleModel.findById(cycleId).lean();
    for (const window of [{ 'sampling.end.utc': new Date(Date.now() - DAY) }, { 'sampling.start.utc': new Date(Date.now() + DAY) }]) {
      await CycleModel.updateOne({ _id: cycleId }, { $set: window });
      try {
        expectError(await platform.post(url()).send({ kind: 'SAMPLING', acoId: target() }), 412, 'PRECONDITION_FAILED');
      } finally {
        await CycleModel.updateOne({ _id: cycleId }, { $set: { sampling: cycle!.sampling } });
      }
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
