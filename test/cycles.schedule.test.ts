import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { clearEventHandlers, on } from '../src/core/events.js';
import { idString, newId } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { CycleParticipantModel } from '../src/modules/cycles/cycle-participants.model.js';
import { CycleModel } from '../src/modules/cycles/cycles.model.js';
import { overridePublishedSurveyResolver } from '../src/modules/cycles/cycles.surveys.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';
import { setCurrentShare } from '../src/modules/organisations/market-share.service.js';
import { MarketShareModel } from '../src/modules/organisations/market-shares.model.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { createTestOperator, expectError } from './helpers/fixtures.js';

const URL = '/api/v1/cycles';
let app: TestApp;
let admin: TestUser;
const transitionEvents: string[] = [];
const publishedEvents: string[] = [];
let airportId: string;
let acoId: string;

function wall(day: number): string {
  return new Date(Date.UTC(2040, 0, day)).toISOString().slice(0, 16);
}

function schedule(code: string, start = 10, end = 20, tz = 'UTC') {
  return {
    code, name: `Cycle ${code}`, type: 'DOMESTIC', tz, minSampleSize: 1,
    sampling: { start: wall(start), end: wall(start + 1) },
    assessment: { start: wall(start + 1), end: wall(end) },
  };
}

async function draft(code: string, start = 10, end = 20, tz = 'UTC'): Promise<string> {
  const response = await admin.post(URL).send(schedule(code, start, end, tz));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

/** Stored reservation fixture; publishing itself is exercised with publishableDraft. */
async function reserve(code: string, start = 10, end = 20, tz = 'UTC'): Promise<string> {
  const id = await draft(code, start, end, tz);
  await CycleModel.updateOne({ _id: id }, { $set: { status: 'PUBLISHED' } });
  return id;
}

async function publishableDraft(code: string, start = 10, end = 20): Promise<string> {
  const id = await draft(code, start, end);
  await CycleModel.updateOne({ _id: id }, { $set: { participatingAirportIds: [airportId], participatingAcoIds: [acoId] } });
  return id;
}

beforeAll(async () => {
  app = await createTestApp();
  clearEventHandlers();
  on('cycle.transitioned', 'test.schedule.transitions', async ({ cycleId }) => { transitionEvents.push(cycleId); });
  admin = await app.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  on('cycle.published', 'test.schedule.published', async ({ cycleId }) => { publishedEvents.push(cycleId); });
  const operator = await createTestOperator({ code: 'SCHEDULE-ACO', airportIata: 'DEL' });
  acoId = idString(operator._id);
  airportId = idString(operator.airportId!);
  await setCurrentShare({ airportId: operator.airportId!, acoId: operator._id, sharePct: 100, setBy: admin.user._id });
  const surveyId = idString(newId());
  overridePublishedSurveyResolver(async () => ({ DOMESTIC: surveyId }));
});
beforeEach(async () => {
  transitionEvents.length = 0;
  publishedEvents.length = 0;
  await CycleModel.deleteMany({});
});
afterAll(async () => { overridePublishedSurveyResolver(null); await app.close(); });

describe('complete half-open cycle schedules', () => {
  it('provides calendar reservation data through existing paginated list and detail APIs', async () => {
    const reserved = await reserve('CALENDAR-RESERVED', 10, 20, 'Asia/Kolkata');
    const pending = await draft('CALENDAR-DRAFT', 30, 40);
    const closed = await reserve('CALENDAR-CLOSED', 50, 60);
    await CycleModel.updateOne({ _id: closed }, { $set: { status: 'ASSESSMENT_CLOSED' } });
    const cycles = [];
    for (let page = 1; page <= 3; page++) {
      const response = await admin.get(`${URL}?page=${page}&pageSize=1&sort=code`);
      expect(response.status).toBe(200);
      expect(response.body.meta).toEqual({ page, pageSize: 1, total: 3 });
      cycles.push(...response.body.data);
    }
    expect(cycles.map((cycle) => ({ id: cycle.id, status: cycle.status }))).toEqual([
      { id: closed, status: 'ASSESSMENT_CLOSED' },
      { id: pending, status: 'DRAFT' },
      { id: reserved, status: 'PUBLISHED' },
    ]);
    const summary = cycles.find((cycle) => cycle.id === reserved)!;
    expect(summary).toMatchObject({
      tz: 'Asia/Kolkata',
      sampling: { start: { wall: '2040-01-10T00:00', utc: '2040-01-09T18:30:00.000Z' } },
      assessment: { end: { wall: '2040-01-20T00:00', utc: '2040-01-19T18:30:00.000Z' } },
    });
    const detail = await admin.get(`${URL}/${reserved}`);
    expect(detail.status).toBe(200);
    for (const field of ['id', 'status', 'tz', 'sampling', 'assessment']) {
      expect(detail.body.data[field]).toEqual(summary[field]);
    }
    // Availability reads do not add informational messages or notifications.
    expect(detail.body).not.toHaveProperty('message');
    expect(await NotificationModel.countDocuments({})).toBe(0);
  });

  it.each([
    ['identical', 10, 20], ['overlaps the beginning', 5, 15],
    ['overlaps the end', 15, 25], ['contains existing', 5, 25],
    ['contained by existing', 12, 18],
  ])('rejects %s schedules without changing stored data', async (_label, start, end) => {
    const id = await reserve('EXISTING');
    const before = await CycleModel.findById(id).lean();
    const auditCount = await AuditModel.countDocuments({});
    const response = await admin.post(URL).send(schedule('CONFLICT', start, end));
    const error = expectError(response, 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect(error.details).toEqual({ conflicts: [{ id, code: 'EXISTING', name: 'Cycle EXISTING', tz: 'UTC', endsAt: '2040-01-20T00:00:00.000Z' }] });
    expect(error.message).toBe('Another cycle is already scheduled during these dates');
    expect(await CycleModel.countDocuments({})).toBe(1);
    expect(await CycleModel.findById(id).lean()).toEqual(before);
    expect(await AuditModel.countDocuments({})).toBe(auditCount);
  });

  it('permits both exact boundaries and nonoverlapping schedules', async () => {
    await reserve('MIDDLE');
    await reserve('BEFORE', 1, 10);
    await reserve('AFTER', 20, 30);
    expect(await CycleModel.countDocuments({})).toBe(3);
  });

  it('returns every reserved conflict with a direct validation error', async () => {
    const first = await reserve('PUBLISHED', 1, 10);
    const ignoredDraft = await draft('IGNORED-DRAFT', 10, 20);
    expect((await CycleModel.findById(ignoredDraft).lean())!.status).toBe('DRAFT');
    const historical = await reserve('HISTORY', 20, 30);
    await CycleModel.updateOne({ _id: historical }, { $set: { status: 'SAMPLING_CLOSED' } });
    const response = await admin.post(URL).send(schedule('SPANNING', 5, 25));
    expect(expectError(response, 409, 'CYCLE_SCHEDULE_OVERLAP').details).toEqual({ conflicts: [
      { id: first, code: 'PUBLISHED', name: 'Cycle PUBLISHED', tz: 'UTC', endsAt: '2040-01-10T00:00:00.000Z' },
      { id: historical, code: 'HISTORY', name: 'Cycle HISTORY', tz: 'UTC', endsAt: '2040-01-30T00:00:00.000Z' },
    ] });
    expect(response.body.error.message).toBe('Another cycle is already scheduled during these dates');
    await CycleModel.deleteOne({ _id: first });
    await reserve('REPLACEMENT', 1, 10);
  });

  it.each(['DRAFT', 'ASSESSMENT_CLOSED', 'SCORED', 'ARCHIVED'] as const)('%s cycles no longer reserve their stored dates', async (status) => {
    const id = await reserve('RELEASED');
    await CycleModel.updateOne({ _id: id }, { $set: { status } });
    const original = await CycleModel.findById(id).lean();
    await reserve('REPLACEMENT');
    expect(await CycleModel.findById(id).lean()).toEqual(original);
  });

  it.each(['PUBLISHED', 'SAMPLING_OPEN', 'SAMPLING_CLOSED', 'ASSESSMENT_OPEN'] as const)('%s cycles still reserve their full period', async (status) => {
    const id = await reserve('RESERVED');
    await CycleModel.updateOne({ _id: id }, { $set: { status } });
    expectError(await admin.post(URL).send(schedule('BLOCKED')), 409, 'CYCLE_SCHEDULE_OVERLAP');
  });

  it('releases dates immediately after early assessment closure without changing the schedule', async () => {
    const id = await reserve('EARLY');
    await CycleModel.updateOne({ _id: id }, { $set: { status: 'ASSESSMENT_OPEN' } });
    const original = await CycleModel.findById(id).lean();
    expectError(await admin.post(URL).send(schedule('TOO-SOON')), 409, 'CYCLE_SCHEDULE_OVERLAP');
    const response = await admin.post(`${URL}/${id}/transition`).send({ to: 'ASSESSMENT_CLOSED', reason: 'Close assessment early' });
    expect(response.status).toBe(200);
    const closed = await CycleModel.findById(id).lean();
    expect(closed!.sampling).toEqual(original!.sampling);
    expect(closed!.assessment).toEqual(original!.assessment);
    expect(transitionEvents).toEqual([id]);
    expect(await AuditModel.countDocuments({ entityId: id, action: 'cycle.transitioned' })).toBe(1);
    await reserve('AVAILABLE-NOW');
  });

  it('keeps dates reserved after sampling is closed early', async () => {
    const id = await reserve('SAMPLING');
    await CycleModel.updateOne({ _id: id }, { $set: { status: 'SAMPLING_OPEN' } });
    expect((await admin.post(`${URL}/${id}/transition`).send({ to: 'SAMPLING_CLOSED', reason: 'Sampling complete early' })).status).toBe(200);
    expectError(await admin.post(URL).send(schedule('BLOCKED')), 409, 'CYCLE_SCHEDULE_OVERLAP');
  });

  it('reopens its own assessment when its schedule is still available', async () => {
    const id = await reserve('REOPEN');
    await CycleModel.updateOne({ _id: id }, { $set: { status: 'ASSESSMENT_CLOSED' } });
    const original = await CycleModel.findById(id).lean();
    const response = await admin.post(`${URL}/${id}/transition`).send({ to: 'ASSESSMENT_OPEN', reason: 'Reopen assessment' });
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ASSESSMENT_OPEN');
    const reopened = await CycleModel.findById(id).lean();
    expect(reopened!.assessment).toEqual(original!.assessment);
    expect(transitionEvents).toEqual([id]);
    expect(await AuditModel.countDocuments({ entityId: id, action: 'cycle.transitioned' })).toBe(1);
  });

  it('rejects reopening into a new reservation before changing data, auditing or emitting events', async () => {
    const id = await reserve('CLOSED');
    await CycleModel.updateOne({ _id: id }, { $set: { status: 'ASSESSMENT_CLOSED' } });
    const replacement = await reserve('NEW-RESERVATION');
    const before = await CycleModel.findById(id).lean();
    const counts = await Promise.all([AuditModel.countDocuments({}), NotificationModel.countDocuments({})]);
    const response = await admin.post(`${URL}/${id}/transition`).send({ to: 'ASSESSMENT_OPEN', reason: 'Try reopening' });
    expect(expectError(response, 409, 'CYCLE_SCHEDULE_OVERLAP').details).toMatchObject({ conflicts: [{ id: replacement }] });
    expect(await CycleModel.findById(id).lean()).toEqual(before);
    expect(await Promise.all([AuditModel.countDocuments({}), NotificationModel.countDocuments({})])).toEqual(counts);
    expect(transitionEvents).toEqual([]);
  });

  it('rechecks reservations before reopening sampling too', async () => {
    const id = await reserve('SAMPLING-REOPEN');
    await CycleModel.updateOne({ _id: id }, { $set: { status: 'SAMPLING_CLOSED' } });
    const before = await CycleModel.findById(id).lean();
    await CycleModel.collection.insertOne({ ...before!, _id: newId(), code: 'LEGACY-CONFLICT' });
    expectError(await admin.post(`${URL}/${id}/transition`).send({ to: 'SAMPLING_OPEN', reason: 'Reopen sampling' }), 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect(await CycleModel.findById(id).lean()).toEqual(before);
    expect(transitionEvents).toEqual([]);
  });

  it('preserves conflicting UTC ends and time zones without scheduling advice', async () => {
    await reserve('LONG', 1, 30, 'Asia/Kolkata');
    // Legacy overlapping reservation: starts later but finishes earlier in UTC.
    const original = await CycleModel.findOne({ code: 'LONG' }).lean();
    await CycleModel.collection.insertOne({ ...original!, _id: newId(), code: 'SHORT',
      sampling: { start: { wall: wall(10), utc: new Date('2040-01-10T00:00:00Z') }, end: { wall: wall(11), utc: new Date('2040-01-11T00:00:00Z') } },
      assessment: { start: { wall: wall(11), utc: new Date('2040-01-11T00:00:00Z') }, end: { wall: wall(20), utc: new Date('2040-01-20T00:00:00Z') } }, tz: 'UTC' });
    const response = await admin.post(URL).send(schedule('CONFLICT', 5, 25));
    const error = expectError(response, 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect(error.message).toBe('Another cycle is already scheduled during these dates');
    expect(response.body.error.details.conflicts).toHaveLength(2);
    expect(response.body.error.details.conflicts[0].endsAt).toBe('2040-01-29T18:30:00.000Z');
  });

  it('serializes reopening against simultaneous overlapping publishing', async () => {
    const id = await reserve('REOPEN-RACE');
    await CycleModel.updateOne({ _id: id }, { $set: { status: 'ASSESSMENT_CLOSED' } });
    const pending = await publishableDraft('PUBLISH-RACE');
    const [reopen, publishing] = await Promise.all([
      admin.post(`${URL}/${id}/transition`).send({ to: 'ASSESSMENT_OPEN', reason: 'Reopen during creation' }),
      admin.post(`${URL}/${pending}/publish`),
    ]);
    expect([reopen.status, publishing.status]).toEqual(reopen.status === 200 ? [200, 409] : [409, 200]);
    expectError(reopen.status === 409 ? reopen : publishing, 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect((await CycleModel.findById(id).lean())!.status).toBe(reopen.status === 200 ? 'ASSESSMENT_OPEN' : 'ASSESSMENT_CLOSED');
    expect(transitionEvents).toEqual(reopen.status === 200 ? [id] : [pending]);
  });

  it('allows only one of simultaneous reopenings of overlapping closed cycles', async () => {
    const first = await reserve('CLOSED-A');
    await CycleModel.updateOne({ _id: first }, { $set: { status: 'ASSESSMENT_CLOSED' } });
    const second = await reserve('CLOSED-B');
    await CycleModel.updateOne({ _id: second }, { $set: { status: 'ASSESSMENT_CLOSED' } });
    const responses = await Promise.all([first, second].map((id) => admin.post(`${URL}/${id}/transition`).send({ to: 'ASSESSMENT_OPEN', reason: 'Concurrent reopening' })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expectError(responses.find((response) => response.status === 409)!, 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect(await CycleModel.countDocuments({ status: 'ASSESSMENT_OPEN' })).toBe(1);
    expect(transitionEvents).toHaveLength(1);
  });

  it('publishes a draft despite overlapping drafts, then rejects publishing another into that reservation', async () => {
    const first = await publishableDraft('DRAFT-FIRST');
    const second = await publishableDraft('DRAFT-SECOND');
    const before = await CycleModel.findById(second).lean();
    expect((await admin.post(`${URL}/${first}/publish`)).status).toBe(200);
    const response = await admin.post(`${URL}/${second}/publish`);
    expect(expectError(response, 409, 'CYCLE_SCHEDULE_OVERLAP').details).toMatchObject({ conflicts: [{ id: first }] });
    expect(await CycleModel.findById(second).lean()).toEqual(before);
    expect(await CycleParticipantModel.countDocuments({ cycleId: second })).toBe(0);
    expect(await MarketShareModel.countDocuments({ cycleId: second })).toBe(0);
    expect(await AuditModel.countDocuments({ action: 'cycle.published', entityId: second })).toBe(0);
    expect(publishedEvents).toEqual([first]);
  });

  it('atomically allows only one of concurrent overlapping draft publications', async () => {
    const ids = await Promise.all(['PUBLISH-A', 'PUBLISH-B', 'PUBLISH-C'].map((code) => publishableDraft(code)));
    await CycleModel.db.collection('cycle_schedule_locks').deleteMany({});
    const responses = await Promise.all(ids.map((id) => admin.post(`${URL}/${id}/publish`)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409]);
    const winner = ids[responses.findIndex((response) => response.status === 200)]!;
    expect(publishedEvents).toEqual([winner]);
    expect(transitionEvents).toEqual([winner]);
    expect(await CycleModel.countDocuments({ status: 'PUBLISHED' })).toBe(1);
    for (const [index, response] of responses.entries()) {
      if (response.status === 200) continue;
      const id = ids[index]!;
      expect(expectError(response, 409, 'CYCLE_SCHEDULE_OVERLAP').details).toMatchObject({ conflicts: [{ id: winner }] });
      expect((await CycleModel.findById(id).lean())!.status).toBe('DRAFT');
      expect(await CycleParticipantModel.countDocuments({ cycleId: id })).toBe(0);
      expect(await MarketShareModel.countDocuments({ cycleId: id })).toBe(0);
      expect(await AuditModel.countDocuments({ action: 'cycle.published', entityId: id })).toBe(0);
      expect(await NotificationModel.countDocuments({ 'refs.cycleId': id })).toBe(0);
    }
  });

  it('does not let an overlapping draft block reopening', async () => {
    const id = await reserve('REOPEN-WITH-DRAFT');
    await CycleModel.updateOne({ _id: id }, { $set: { status: 'ASSESSMENT_CLOSED' } });
    const pending = await draft('IGNORED-DRAFT');
    expect((await admin.post(`${URL}/${id}/transition`).send({ to: 'ASSESSMENT_OPEN', reason: 'Reopen with draft present' })).status).toBe(200);
    expect((await CycleModel.findById(pending).lean())!.status).toBe('DRAFT');
  });

  it('preserves window-order validation for explicitly selected windows on drafts', async () => {
    const invalid = schedule('BAD-ORDER');
    invalid.assessment.start = wall(10);
    expectError(await admin.post(URL).send(invalid), 400, 'VALIDATION');
    const id = await draft('VALID-DRAFT');
    const before = await CycleModel.findById(id).lean();
    expectError(await admin.patch(`${URL}/${id}`).send({ assessment: { start: wall(10) } }), 400, 'VALIDATION');
    expect(await CycleModel.findById(id).lean()).toEqual(before);
  });

  it.each([null, new Date('2026-01-01T00:00:00.000Z')])('CSQ-26Q3 DRAFT never blocks Q4 create, edit or publish, even with stale publishedAt=%j', async (publishedAt) => {
    const q3Input = {
      code: 'CSQ-26Q3', name: 'CSQ 2026 Q3', type: 'DOMESTIC', tz: 'Asia/Kolkata', minSampleSize: 1,
      sampling: { start: '2026-12-26T00:00', end: '2026-12-27T00:00' },
      assessment: { start: '2026-12-27T00:00', end: '2026-12-28T00:00' },
      participatingAirportIds: [airportId], participatingAcoIds: [acoId],
    };
    const q3 = await admin.post(URL).send(q3Input);
    expect(q3.status).toBe(201);
    const q3Id = q3.body.data.id as string;
    await CycleModel.updateOne({ _id: q3Id }, { $set: { publishedAt } });
    const originalQ3 = await CycleModel.findById(q3Id).lean();
    expect(originalQ3!.status).toBe('DRAFT');
    expect(originalQ3!.sampling.start.utc.toISOString()).toBe('2026-12-25T18:30:00.000Z');
    expect(originalQ3!.assessment.end.utc.toISOString()).toBe('2026-12-27T18:30:00.000Z');

    // Saving Q4 with exactly the same dates must succeed.
    const q4Input = { ...q3Input, code: 'CSQ-26Q4', name: 'CSQ 2026 Q4' };
    const q4 = await admin.post(URL).send(q4Input);
    expect(q4.status, JSON.stringify(q4.body)).toBe(201);
    const q4Id = q4.body.data.id as string;
    // Reproduce the existing Q4's original 28 December start, then move it back.
    expect((await admin.patch(`${URL}/${q4Id}`).send({
      sampling: { start: '2026-12-28T00:00', end: '2027-01-07T00:00' },
      assessment: { start: '2027-01-07T00:00', end: '2027-02-06T00:00' },
    })).status).toBe(200);
    const edited = await admin.patch(`${URL}/${q4Id}`).send({ sampling: { start: '2026-12-26T00:00' } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data.sampling.start.utc).toBe('2026-12-25T18:30:00.000Z');
    expect((await admin.post(`${URL}/${q4Id}/publish`)).status).toBe(200);

    // The now-published Q4 genuinely blocks overlaps; Q3 still must not appear.
    const conflict = await admin.post(URL).send({ ...q4Input, code: 'CSQ-26Q4-CONFLICT' });
    const error = expectError(conflict, 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect(error.details).toEqual({ conflicts: [{ id: q4Id, code: 'CSQ-26Q4', name: 'CSQ 2026 Q4', tz: 'Asia/Kolkata', endsAt: '2027-02-05T18:30:00.000Z' }] });
    const publishQ3 = await admin.post(`${URL}/${q3Id}/publish`);
    expect(expectError(publishQ3, 409, 'CYCLE_SCHEDULE_OVERLAP').details).toEqual(error.details);
    expect(await CycleModel.findById(q3Id).lean()).toEqual(originalQ3);
  });

  it('compares UTC instants rather than the displayed calendar dates', async () => {
    await reserve('INDIA', 10, 20, 'Asia/Kolkata');
    // Same displayed boundary, but starts 5.5 hours before INDIA finishes.
    expectError(await admin.post(URL).send(schedule('TOKYO', 20, 25, 'Asia/Tokyo')), 409, 'CYCLE_SCHEDULE_OVERLAP');
    // UTC midnight is after INDIA finishes at 18:30Z on the previous day.
    await reserve('UTC-AFTER', 20, 25);
  });

  it('excludes the edited cycle and merges partial updates before checking', async () => {
    const first = await draft('FIRST', 1, 10);
    const second = await reserve('SECOND', 20, 30);
    expect((await admin.patch(`${URL}/${first}`).send({ sampling: { start: wall(1).replace('00:00', '01:00') } })).status).toBe(200);
    const before = await CycleModel.findById(first).lean();
    expectError(await admin.patch(`${URL}/${first}`).send({ assessment: { end: wall(21) }, name: 'Rejected rename' }), 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect(await CycleModel.findById(first).lean()).toEqual(before);
    expect((await admin.patch(`${URL}/${first}`).send({ assessment: { end: wall(20) } })).status).toBe(200);
    expect((await admin.get(`${URL}/${second}`)).status).toBe(200);
  });

  it('checks time-zone-only changes after resolving all existing wall clocks', async () => {
    await reserve('FIRST', 1, 10);
    const second = await draft('SECOND', 10, 20);
    const before = await CycleModel.findById(second).lean();
    expectError(await admin.patch(`${URL}/${second}`).send({ tz: 'Asia/Kolkata' }), 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect(await CycleModel.findById(second).lean()).toEqual(before);
  });

  it('checks automatically derived schedules on create and initiation-date updates', async () => {
    await reserve('BLOCKER', 20, 30);
    expectError(await admin.post(URL).send({ code: 'DERIVED', name: 'Derived', type: 'BOTH', initiationDate: '2040-01-01', tz: 'UTC', minSampleSize: 1 }), 409, 'CYCLE_SCHEDULE_OVERLAP');
    const id = await draft('EDIT', 50, 60);
    const before = await CycleModel.findById(id).lean();
    expectError(await admin.patch(`${URL}/${id}`).send({ initiationDate: '2040-01-01' }), 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect(await CycleModel.findById(id).lean()).toEqual(before);
  });

  it('checks published deadline extensions and permits an exact boundary', async () => {
    const id = await reserve('EXTEND', 1, 10);
    await reserve('NEXT', 20, 30);
    await CycleModel.updateOne({ _id: id }, { $set: { status: 'PUBLISHED' } });
    const before = await CycleModel.findById(id).lean();
    expectError(await admin.patch(`${URL}/${id}`).send({ assessment: { end: wall(21) } }), 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect(await CycleModel.findById(id).lean()).toEqual(before);
    expect((await admin.patch(`${URL}/${id}`).send({ assessment: { end: wall(20) } })).status).toBe(200);
    expectError(await admin.patch(`${URL}/${id}`).send({ assessment: { end: wall(19) } }), 400, 'VALIDATION');
  });

  it('rejects publishing legacy overlaps before snapshots, participants, audit or notifications', async () => {
    const id = await draft('PUBLISH');
    // Represent a legacy overlap stored before this rule existed.
    const original = await CycleModel.findById(id).lean();
    await CycleModel.collection.insertOne({ ...original!, _id: newId(), code: 'LEGACY', name: 'Legacy', status: 'PUBLISHED' });
    const counts = await Promise.all([MarketShareModel.countDocuments({}), CycleParticipantModel.countDocuments({}), AuditModel.countDocuments({}), NotificationModel.countDocuments({})]);
    expectError(await admin.post(`${URL}/${id}/publish`), 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect(await CycleModel.findById(id).lean()).toEqual(original);
    expect(await Promise.all([MarketShareModel.countDocuments({}), CycleParticipantModel.countDocuments({}), AuditModel.countDocuments({}), NotificationModel.countDocuments({})])).toEqual(counts);
  });

  it('allows simultaneous overlapping draft creations without reserving dates', async () => {
    await CycleModel.db.collection('cycle_schedule_locks').deleteMany({});
    const responses = await Promise.all(['RACE-A', 'RACE-B', 'RACE-C'].map((code) => admin.post(URL).send(schedule(code))));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 201, 201]);
    expect(await CycleModel.countDocuments({ status: 'DRAFT' })).toBe(3);
  });

  it('reserves the gap between sampling and assessment too', async () => {
    const input = schedule('GAP', 1, 20);
    input.assessment.start = wall(15);
    const response = await admin.post(URL).send(input);
    expect(response.status).toBe(201);
    await CycleModel.updateOne({ _id: response.body.data.id }, { $set: { status: 'PUBLISHED' } });
    expectError(await admin.post(URL).send(schedule('IN-GAP', 5, 10)), 409, 'CYCLE_SCHEDULE_OVERLAP');
  });

  it('serializes an extension racing publishing', async () => {
    const id = await reserve('EXTENSION-RACE', 1, 10);
    await CycleModel.updateOne({ _id: id }, { $set: { status: 'PUBLISHED' } });
    const pending = await publishableDraft('NEW-RACE', 20, 30);
    const [extension, publishing] = await Promise.all([
      admin.patch(`${URL}/${id}`).send({ assessment: { end: wall(25) } }),
      admin.post(`${URL}/${pending}/publish`),
    ]);
    expect([extension.status, publishing.status]).toEqual(extension.status === 200 ? [200, 409] : [409, 200]);
    expectError(extension.status === 409 ? extension : publishing, 409, 'CYCLE_SCHEDULE_OVERLAP');
    expect((await CycleModel.findById(id).lean())!.assessment.end.wall).toBe(wall(extension.status === 200 ? 25 : 10));
  });

  it('merges concurrent partial edits against the latest committed cycle', async () => {
    const id = await draft('MERGE', 1, 10);
    const start = wall(1).replace('00:00', '01:00');
    const responses = await Promise.all([
      admin.patch(`${URL}/${id}`).send({ sampling: { start } }),
      admin.patch(`${URL}/${id}`).send({ assessment: { end: wall(15) } }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const cycle = await CycleModel.findById(id).lean();
    expect(cycle!.sampling.start.wall).toBe(start);
    expect(cycle!.assessment.end.wall).toBe(wall(15));
  });

  it('allows simultaneous overlapping edits of different drafts without reserving dates', async () => {
    const first = await draft('EDIT-A', 1, 10);
    const second = await draft('EDIT-B', 30, 40);
    const patch = { sampling: { start: wall(15), end: wall(16) }, assessment: { start: wall(16), end: wall(25) } };
    const responses = await Promise.all([first, second].map((id) => admin.patch(`${URL}/${id}`).send(patch)));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await CycleModel.countDocuments({ status: 'DRAFT', 'sampling.start.wall': wall(15), 'assessment.end.wall': wall(25) })).toBe(2);
  });
});
