// Cycles at the route and service level: create / derive / validate, the
// publish guards and what publishing produces, participants and the
// listeners that feed them, monitoring, manual reminders, ACO visibility,
// `GET /cycles/current` and the manual status machine. The clock (jobs with a
// fake `now`) is in cycles.flow.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemContext } from '../src/core/auth/system.js';
import { clearEventHandlers, emit, on, type Events } from '../src/core/events.js';
import { idString, toId } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { registerCycleHandlers } from '../src/modules/cycles/cycles.handlers.js';
import {
  bumpParticipantStats,
  getCycle,
  getParticipant,
  isMarketShareFrozen,
  listParticipants,
  setParticipantSampling,
} from '../src/modules/cycles/cycles.service.js';
import { overridePublishedSurveyResolver } from '../src/modules/cycles/cycles.surveys.js';
import { fromInstant, toInstant } from '../src/modules/cycles/domain/windows.js';
import { registerAssessmentReminderSender } from '../src/modules/cycles/reminders.service.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';
import { setCurrentShare } from '../src/modules/organisations/market-share.service.js';
import { MarketShareModel } from '../src/modules/organisations/market-shares.model.js';
import { latestPublishedVersionIds } from '../src/modules/surveys/surveys.service.js';
import { seedSurveys } from '../src/seed/surveys.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, createTestOperator, expectError, grantTasks } from './helpers/fixtures.js';

const TZ = 'Asia/Kolkata';
const DAY = 24 * 60 * 60 * 1000;
const CYCLES = '/api/v1/cycles';

/** `YYYY-MM-DD` in the cycle zone, `days` from now. */
function dateIn(days: number): string {
  return fromInstant(new Date(Date.now() + days * DAY), TZ).slice(0, 10);
}
function wall(days: number, time = '00:00'): string {
  return `${dateIn(days)}T${time}`;
}

let t: TestApp;
let superAdmin: TestUser;
let adminA: TestUser;
let adminB: TestUser;
let adminE: TestUser;
let del: string;
let bom: string;
let hyd: string;
let acoA: string;
let acoB: string;
let acoC: string;
let acoD: string;
let acoE: string;
let cycle1: string;
let cycle2: string;
let domesticCycle: string;
const transitioned: Events['cycle.transitioned'][] = [];
const published: Events['cycle.published'][] = [];

function mailsFor(cycleId: string, template: string) {
  return NotificationModel.find({ template, 'refs.cycleId': cycleId }).sort({ createdAt: 1 }).lean();
}

beforeAll(async () => {
  t = await createTestApp();
  // Only the cycles listeners and this file's recorders: modules above cycles
  // (invitations, scoring) must not act on these transitions.
  clearEventHandlers();
  registerCycleHandlers();
  on('cycle.transitioned', 'test.cycles.recordTransitioned', async (payload) => {
    transitioned.push(payload);
  });
  on('cycle.published', 'test.cycles.recordPublished', async (payload) => {
    published.push(payload);
  });

  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  [del, bom, hyd] = await Promise.all([airportIdByIata('DEL'), airportIdByIata('BOM'), airportIdByIata('HYD')]);
  acoA = idString((await createTestOperator({ code: 'CY-A', name: 'Alpha Cargo', airportIata: 'DEL' }))._id);
  acoB = idString((await createTestOperator({ code: 'CY-B', name: 'Bravo Cargo', airportIata: 'DEL' }))._id);
  acoC = idString((await createTestOperator({ code: 'CY-C', name: 'Charlie Cargo', airportIata: 'BOM' }))._id);
  acoD = idString((await createTestOperator({ code: 'CY-D', name: 'Delta Cargo', airportIata: 'HYD' }))._id);
  acoE = idString((await createTestOperator({ code: 'CY-E', name: 'Echo Cargo', airportIata: 'BLR' }))._id);
  await superAdmin.patch(`/api/v1/operators/${acoB}`).send({ operations: { domestic: true, international: false } });
  await superAdmin.patch(`/api/v1/operators/${acoD}`).send({ operations: { domestic: false, international: true } });
  adminA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: acoA, email: 'admin@alpha.test', name: 'Asha Alpha' });
  adminB = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: acoB, email: 'admin@bravo.test', name: 'Bela Bravo' });
  await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: acoC, email: 'admin@charlie.test', name: 'Chitra Charlie' });
  adminE = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: acoE, email: 'admin@echo.test', name: 'Esha Echo' });
  await seedSurveys();
});
afterAll(() => t.close());

describe('POST /cycles', () => {
  it('derives both windows from initiationDate and settings.defaults, in the default zone, as a DRAFT', async () => {
    const res = await superAdmin.post(CYCLES).send({
      name: 'CSQ 2026 H2',
      code: 'csq-2026-h2',
      type: 'BOTH',
      initiationDate: dateIn(2),
      minSampleSize: 10,
      participatingAirportIds: [del, bom],
      participatingAcoIds: [acoA, acoB, acoC],
    });
    expect(res.status).toBe(201);
    const cycle = res.body.data;
    cycle1 = cycle.id;
    expect(cycle).toMatchObject({
      code: 'CSQ-2026-H2',
      type: 'BOTH',
      status: 'DRAFT',
      tz: TZ,
      minSampleSize: 10,
      reminders: { sampling: { count: 3, everyDays: 3 }, assessment: { count: 10, everyDays: 2 } },
      participants: { airports: 2, operators: 3 },
      progress: { locked: 0, invited: 0, completed: 0 },
      surveyVersions: { DOMESTIC: null, INTERNATIONAL: null },
      marketShareFrozen: false,
      publishedAt: null,
      participantList: [],
    });
    expect(cycle.sampling.start.wall).toBe(wall(2));
    expect(cycle.sampling.end.wall).toBe(wall(12));
    expect(cycle.assessment.start.wall).toBe(wall(12));
    expect(cycle.assessment.end.wall).toBe(wall(42));
    expect(cycle.sampling.start.utc).toBe(toInstant({ wall: wall(2), tz: TZ }).toISOString());
    expect(cycle.createdBy).toBe(idString(superAdmin.user._id));
    expect(await AuditModel.countDocuments({ action: 'cycle.created', entityId: cycle1 })).toBe(1);
  });

  it('rejects unordered windows, a half-given window, no window at all, a bad zone and a duplicate code', async () => {
    const base = { name: 'Bad', type: 'DOMESTIC', minSampleSize: 5, participatingAirportIds: [del], participatingAcoIds: [acoA] };
    const unordered = await superAdmin.post(CYCLES).send({
      ...base,
      code: 'BAD-1',
      sampling: { start: wall(5), end: wall(2) },
      assessment: { start: wall(1), end: wall(30) },
    });
    const issues = expectError(unordered, 400, 'VALIDATION').details as { issues: { code: string; path: string }[] };
    expect(issues.issues.map((issue) => issue.code).sort()).toEqual(['EMPTY_WINDOW', 'OVERLAP']);

    expectError(await superAdmin.post(CYCLES).send({ ...base, code: 'BAD-2', sampling: { start: wall(1), end: wall(5) } }), 400, 'VALIDATION');
    expectError(await superAdmin.post(CYCLES).send({ ...base, code: 'BAD-3' }), 400, 'VALIDATION');
    expectError(await superAdmin.post(CYCLES).send({ ...base, code: 'BAD-4', initiationDate: dateIn(1), tz: 'Mars/Olympus' }), 400, 'VALIDATION');
    expectError(await superAdmin.post(CYCLES).send({ ...base, code: 'csq-2026-h2', initiationDate: dateIn(1) }), 409, 'CONFLICT');
  });

  it('rejects an operator that is not at a participating airport, or unknown', async () => {
    const res = await superAdmin.post(CYCLES).send({
      name: 'Bad',
      code: 'BAD-5',
      type: 'BOTH',
      initiationDate: dateIn(1),
      minSampleSize: 5,
      participatingAirportIds: [del],
      participatingAcoIds: [acoA, acoE, '0123456789abcdef01234567'],
    });
    const details = expectError(res, 400, 'VALIDATION').details as { issues: { path: string; message: string }[] };
    expect(details.issues).toEqual([
      { path: 'participatingAcoIds.1', message: 'Operator CY-E is not at a participating airport' },
      { path: 'participatingAcoIds.2', message: 'Unknown operator 0123456789abcdef01234567' },
    ]);
  });
});

describe('DRAFT: GET and PATCH', () => {
  it('patches fields and re-derives the windows from a new initiationDate; audited', async () => {
    const res = await superAdmin.patch(`${CYCLES}/${cycle1}`).send({ name: 'CSQ 2026 H2 (rev)', minSampleSize: 12, initiationDate: dateIn(3) });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'CSQ 2026 H2 (rev)', minSampleSize: 12, status: 'DRAFT' });
    expect(res.body.data.sampling.start.wall).toBe(wall(3));
    expect(res.body.data.assessment.end.wall).toBe(wall(43));
    const audit = await AuditModel.findOne({ action: 'cycle.updated', entityId: cycle1 }).lean();
    expect((audit?.before as { minSampleSize: number }).minSampleSize).toBe(10);
    expect((audit?.after as { minSampleSize: number }).minSampleSize).toBe(12);
    expectError(await superAdmin.get(`${CYCLES}/0123456789abcdef01234567`), 404, 'NOT_FOUND');
  });
});

describe('POST /cycles/:id/publish', () => {
  it('412 naming the first participating airport whose shares do not total 100', async () => {
    const none = expectError(await superAdmin.post(`${CYCLES}/${cycle1}/publish`), 412, 'PRECONDITION_FAILED');
    expect(none.message).toBe('Market shares at DEL (Indira Gandhi International Airport) total 0, not 100');
    expect(none.details).toMatchObject({ airportId: del, iata: 'DEL', total: 0 });

    await superAdmin.put(`/api/v1/airports/${del}/market-share`).send({ entries: [{ acoId: acoA, sharePct: 60 }, { acoId: acoB, sharePct: 40 }] });
    // A partial total can only come from onboarding / operator creation (the PUT validates the set).
    await setCurrentShare({ airportId: toId(bom), acoId: toId(acoC), sharePct: 90, setBy: null });
    const short = expectError(await superAdmin.post(`${CYCLES}/${cycle1}/publish`), 412, 'PRECONDITION_FAILED');
    expect(short.message).toContain('Market shares at BOM');
    expect(short.details).toMatchObject({ airportId: bom, iata: 'BOM', total: 90 });
    await superAdmin.put(`/api/v1/airports/${bom}/market-share`).send({ entries: [{ acoId: acoC, sharePct: 100 }] });
  });

  it('412 when a survey type the cycle runs has no published version', async () => {
    overridePublishedSurveyResolver(async () => ({ INTERNATIONAL: '0123456789abcdef01234567' }));
    try {
      const res = expectError(await superAdmin.post(`${CYCLES}/${cycle1}/publish`), 412, 'PRECONDITION_FAILED');
      expect(res.message).toContain('No published DOMESTIC survey version');
      expect(res.details).toEqual({ surveyType: 'DOMESTIC' });
    } finally {
      overridePublishedSurveyResolver(null);
    }
    expect(await MarketShareModel.countDocuments({ cycleId: cycle1 })).toBe(0);
  });

  it('412 when the sampling window is already over, and when an operator runs none of the survey types', async () => {
    const past = await superAdmin.post(CYCLES).send({
      name: 'Past',
      code: 'CSQ-PAST',
      type: 'BOTH',
      minSampleSize: 1,
      sampling: { start: wall(-10), end: wall(-2) },
      assessment: { start: wall(-2), end: wall(20) },
      participatingAirportIds: [del],
      participatingAcoIds: [acoA],
    });
    expect(past.status).toBe(201);
    const over = expectError(await superAdmin.post(`${CYCLES}/${past.body.data.id}/publish`), 412, 'PRECONDITION_FAILED');
    expect((over.details as { issues: { code: string }[] }).issues.map((issue) => issue.code)).toEqual(['IN_THE_PAST']);

    const domestic = await superAdmin.post(CYCLES).send({
      name: 'Domestic only',
      code: 'CSQ-DOM',
      type: 'DOMESTIC',
      initiationDate: dateIn(4),
      minSampleSize: 5,
      participatingAirportIds: [hyd],
      participatingAcoIds: [acoD],
    });
    domesticCycle = domestic.body.data.id;
    await superAdmin.put(`/api/v1/airports/${hyd}/market-share`).send({ entries: [{ acoId: acoD, sharePct: 100 }] });
    const nothingToAssess = expectError(await superAdmin.post(`${CYCLES}/${domesticCycle}/publish`), 412, 'PRECONDITION_FAILED');
    expect(nothingToAssess.message).toBe('Operator CY-D runs no domestic services; remove it from the cycle');
    expect(nothingToAssess.details).toEqual({ acoId: acoD, code: 'CY-D' });
  });

  it('publishes: snapshot per airport, survey versions pinned, participants planned, admins mailed, events emitted', async () => {
    const res = await superAdmin.post(`${CYCLES}/${cycle1}/publish`);
    expect(res.status).toBe(200);
    const cycle = res.body.data;
    expect(cycle.status).toBe('PUBLISHED');
    expect(cycle.publishedAt).toBeTruthy();
    expect(cycle.publishedBy).toBe(idString(superAdmin.user._id));
    const latest = await latestPublishedVersionIds();
    expect(cycle.surveyVersions).toEqual({ DOMESTIC: latest.DOMESTIC, INTERNATIONAL: latest.INTERNATIONAL });

    const byCode = Object.fromEntries((cycle.participantList as { operator: { code: string } }[]).map((p) => [p.operator.code, p]));
    expect(Object.keys(byCode).sort()).toEqual(['CY-A', 'CY-B', 'CY-C']);
    expect(byCode['CY-A']).toMatchObject({
      cycleId: cycle1,
      acoId: acoA,
      airportId: del,
      operator: { id: acoA, code: 'CY-A', name: 'Alpha Cargo' },
      airport: { id: del, iata: 'DEL' },
      surveyTypes: ['DOMESTIC', 'INTERNATIONAL'],
      requiredSampleSize: 12,
      sampling: { status: 'NOT_STARTED', selectedCount: 0, lockedAt: null, lockedBy: null, unlockedAt: null, unlockedBy: null, unlockReason: null },
      stats: { invited: 0, started: 0, completed: 0 },
      selfAssessment: { DOMESTIC: 'NOT_STARTED', INTERNATIONAL: 'NOT_STARTED' },
      reminders: { sent: 0, lastAt: null },
    });
    expect(byCode['CY-B']).toMatchObject({ surveyTypes: ['DOMESTIC'], selfAssessment: { DOMESTIC: 'NOT_STARTED', INTERNATIONAL: null } });
    expect(byCode['CY-C']).toMatchObject({ airport: { iata: 'BOM' }, surveyTypes: ['DOMESTIC', 'INTERNATIONAL'] });

    // The snapshot is the current set copied under the cycle id, through organisations.
    const snapshot = await superAdmin.get(`/api/v1/airports/${del}/market-share?cycleId=${cycle1}`);
    expect(snapshot.body.data).toMatchObject({ cycleId: cycle1, total: 100, frozen: false });
    expect((snapshot.body.data.entries as { code: string; sharePct: number }[]).map((e) => [e.code, e.sharePct])).toEqual([['CY-A', 60], ['CY-B', 40]]);
    expect(await MarketShareModel.countDocuments({ cycleId: cycle1 })).toBe(3);

    const mails = await mailsFor(cycle1, 'cycle-published');
    expect(mails.map((mail) => mail.to).sort()).toEqual(['admin@alpha.test', 'admin@bravo.test', 'admin@charlie.test']);
    expect(mails[0]!.subject).toBe('Commencement of assessment cycle: CSQ 2026 H2 (rev)');
    expect(mails[0]!.body).toContain('Minimum sample size: 12');
    expect(mails.every((mail) => mail.status === 'SENT')).toBe(true);
    const bravo = mails.find((mail) => mail.to === 'admin@bravo.test')!;
    expect((bravo.vars as { surveyTypes: string }).surveyTypes).toBe('Domestic');
    expect(idString(bravo.refs.acoId!)).toBe(acoB);

    expect(published).toEqual([{ cycleId: cycle1 }]);
    expect(transitioned).toEqual([{ cycleId: cycle1, from: 'DRAFT', to: 'PUBLISHED', trigger: 'MANUAL' }]);
    const audit = await AuditModel.findOne({ action: 'cycle.published', entityId: cycle1 }).lean();
    expect(audit?.after).toMatchObject({ status: 'PUBLISHED', participants: 3 });
    expect(await AuditModel.countDocuments({ action: 'marketshare.updated', entityId: `${del}:${cycle1}` })).toBe(1);

    expectError(await superAdmin.post(`${CYCLES}/${cycle1}/publish`), 412, 'PRECONDITION_FAILED');
  });

  it('lands on SAMPLING_OPEN when the sampling window has already started, with the "sampling is open" wording', async () => {
    const res = await superAdmin.post(CYCLES).send({
      name: 'CSQ live',
      code: 'CSQ-LIVE',
      type: 'BOTH',
      minSampleSize: 10,
      sampling: { start: wall(-1), end: wall(5) },
      assessment: { start: wall(5), end: wall(35) },
      participatingAirportIds: [del, bom],
      participatingAcoIds: [acoA, acoB, acoC],
    });
    cycle2 = res.body.data.id;
    const publish = await superAdmin.post(`${CYCLES}/${cycle2}/publish`);
    expect(publish.status).toBe(200);
    expect(publish.body.data.status).toBe('SAMPLING_OPEN');
    const mails = await mailsFor(cycle2, 'cycle-published');
    expect(mails).toHaveLength(3);
    expect(mails[0]!.subject).toBe('Sampling is open: CSQ live');
    expect(transitioned.at(-1)).toEqual({ cycleId: cycle2, from: 'DRAFT', to: 'SAMPLING_OPEN', trigger: 'MANUAL' });
  });
});

describe('PATCH after publishing', () => {
  it('allows end-date extensions and reminders only', async () => {
    const name = expectError(await superAdmin.patch(`${CYCLES}/${cycle1}`).send({ name: 'Renamed' }), 400, 'VALIDATION');
    expect(name.details).toMatchObject({ offending: ['name'] });
    const start = expectError(await superAdmin.patch(`${CYCLES}/${cycle1}`).send({ sampling: { start: wall(4) } }), 400, 'VALIDATION');
    expect(start.details).toMatchObject({ offending: ['sampling.start'] });
    const shorter = expectError(await superAdmin.patch(`${CYCLES}/${cycle1}`).send({ sampling: { end: wall(11) } }), 400, 'VALIDATION');
    expect(shorter.message).toContain('can only be extended');

    const extended = await superAdmin.patch(`${CYCLES}/${cycle1}`).send({ sampling: { end: wall(14) }, reminders: { sampling: { count: 2, everyDays: 4 }, assessment: { count: 5, everyDays: 3 } } });
    expect(extended.status).toBe(200);
    expect(extended.body.data.sampling.end.wall).toBe(wall(14));
    expect(extended.body.data.assessment.start.wall).toBe(wall(13));
    expect(extended.body.data.reminders.sampling).toEqual({ count: 2, everyDays: 4 });
    expect(await AuditModel.countDocuments({ action: 'cycle.updated', entityId: cycle1 })).toBe(2);
  });
});

describe('participants, listeners and monitoring', () => {
  it('exported writes: setParticipantSampling, bumpParticipantStats (never below zero), getParticipant, listParticipants', async () => {
    const lockedAt = new Date();
    const locked = await setParticipantSampling(cycle2, acoA, { status: 'LOCKED', selectedCount: 12, lockedAt, lockedBy: idString(adminA.user._id) });
    expect(locked.sampling).toMatchObject({ status: 'LOCKED', selectedCount: 12, lockedAt: lockedAt.toISOString(), lockedBy: idString(adminA.user._id) });
    expect((await bumpParticipantStats(cycle2, acoB, 'started', 2)).stats.started).toBe(2);
    expect((await bumpParticipantStats(cycle2, acoC, 'completed', -5)).stats.completed).toBe(0);
    expect(await getParticipant(cycle2, acoE)).toBeNull();
    expect((await listParticipants(cycle2)).map((p) => p.operator.code)).toEqual(['CY-A', 'CY-B', 'CY-C']);
    await expect(setParticipantSampling(cycle2, acoE, { status: 'LOCKED' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('invitation.sent and assessment.submitted feed the participant; an unknown participant is tolerated', async () => {
    const ctx = systemContext('test: cycles listeners');
    await emit('invitation.sent', { invitationId: '0123456789abcdef01234567', cycleId: cycle2, acoId: acoA }, { ctx });
    await emit('assessment.submitted', { assessmentId: 'a1', cycleId: cycle2, acoId: acoA, kind: 'CUSTOMER', surveyType: 'DOMESTIC' }, { ctx });
    await emit('assessment.submitted', { assessmentId: 'a2', cycleId: cycle2, acoId: acoA, kind: 'SELF', surveyType: 'INTERNATIONAL' }, { ctx });
    await emit('invitation.sent', { invitationId: '0123456789abcdef01234567', cycleId: cycle2, acoId: acoE }, { ctx });
    const a = await getParticipant(cycle2, acoA);
    expect(a?.stats).toEqual({ invited: 1, started: 0, completed: 1 });
    expect(a?.selfAssessment).toEqual({ DOMESTIC: 'NOT_STARTED', INTERNATIONAL: 'SUBMITTED' });
  });

  it('GET /cycles/:id/participants filters by airport, sampling status and operator search', async () => {
    const all = await superAdmin.get(`${CYCLES}/${cycle2}/participants`);
    expect(all.body.meta.total).toBe(3);
    const locked = await superAdmin.get(`${CYCLES}/${cycle2}/participants?samplingStatus=LOCKED`);
    expect(locked.body.data.map((p: { operator: { code: string } }) => p.operator.code)).toEqual(['CY-A']);
    const atBom = await superAdmin.get(`${CYCLES}/${cycle2}/participants?airportId=${bom}`);
    expect(atBom.body.data.map((p: { operator: { code: string } }) => p.operator.code)).toEqual(['CY-C']);
    const search = await superAdmin.get(`${CYCLES}/${cycle2}/participants?q=bravo`);
    expect(search.body.data.map((p: { operator: { code: string } }) => p.operator.code)).toEqual(['CY-B']);
  });

  it('GET /cycles/:id/monitoring totals and the Airport → ACO drill-down; GET /cycles carries progress', async () => {
    const res = await superAdmin.get(`${CYCLES}/${cycle2}/monitoring`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      cycleId: cycle2,
      status: 'SAMPLING_OPEN',
      sampling: { airports: 2, operators: 3, sampleRequired: 30, sampleLocked: 12, lockedOperators: 1 },
      assessment: { invited: 1, started: 2, completed: 1, pending: 0, completionRate: 100 },
    });
    expect(res.body.data.byAirport.map((a: { iata: string; operators: { code: string }[] }) => [a.iata, a.operators.map((o) => o.code)])).toEqual([
      ['DEL', ['CY-A', 'CY-B']],
      ['BOM', ['CY-C']],
    ]);
    expect(res.body.data.byAirport[0].operators[0]).toMatchObject({ acoId: acoA, sampling: { status: 'LOCKED', selectedCount: 12, required: 10 }, invited: 1, completed: 1 });

    const list = await superAdmin.get(`${CYCLES}?q=live`);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ code: 'CSQ-LIVE', progress: { locked: 1, invited: 1, completed: 1 }, participants: { airports: 2, operators: 3 } });
    expect((await superAdmin.get(`${CYCLES}?status=DRAFT`)).body.meta.total).toBe(2);
  });

  it('POST /cycles/:id/reminders/send: SAMPLING to unlocked operators only; ASSESSMENT through the registered sender', async () => {
    const run = await superAdmin.post(`${CYCLES}/${cycle2}/reminders/send`).send({ kind: 'SAMPLING' });
    expect(run.status).toBe(200);
    expect(run.body.data).toEqual({
      kind: 'SAMPLING',
      sent: 2,
      recipients: [
        { acoId: acoB, to: ['admin@bravo.test'] },
        { acoId: acoC, to: ['admin@charlie.test'] },
      ],
    });
    const mails = await mailsFor(cycle2, 'sampling-reminder');
    expect(mails).toHaveLength(2);
    expect(mails[0]!.subject).toMatch(/^Sampling closes in 5 days · 0 \/ 10 selected · CSQ live$/);
    expect((await getParticipant(cycle2, acoB))?.reminders.lastAt).toBeTruthy();
    expect((await getParticipant(cycle2, acoA))?.reminders.lastAt).toBeNull();

    expectError(await superAdmin.post(`${CYCLES}/${cycle2}/reminders/send`).send({ kind: 'SAMPLING', acoId: acoA }), 412, 'PRECONDITION_FAILED');
    expectError(await superAdmin.post(`${CYCLES}/${cycle2}/reminders/send`).send({ kind: 'SAMPLING', acoId: acoE }), 404, 'NOT_FOUND');
    expectError(await superAdmin.post(`${CYCLES}/${cycle1}/reminders/send`).send({ kind: 'SAMPLING' }), 412, 'PRECONDITION_FAILED');

    // ASSESSMENT reminders belong to invitations: 412 until it registers a sender, forwarded once it has.
    const calls: unknown[] = [];
    const registered = registerAssessmentReminderSender(null);
    try {
      expectError(await superAdmin.post(`${CYCLES}/${cycle2}/reminders/send`).send({ kind: 'ASSESSMENT' }), 412, 'PRECONDITION_FAILED');
      registerAssessmentReminderSender(async (cycleId, _now, acoId) => {
        calls.push([cycleId, acoId]);
        return { sent: 7 };
      });
      const forwarded = await superAdmin.post(`${CYCLES}/${cycle2}/reminders/send`).send({ kind: 'ASSESSMENT', acoId: acoB });
      expect(forwarded.body.data).toEqual({ kind: 'ASSESSMENT', sent: 7, recipients: [] });
      expect(calls).toEqual([[cycle2, acoB]]);
    } finally {
      registerAssessmentReminderSender(registered);
    }
  });
});

describe('ACO visibility and GET /cycles/current', () => {
  beforeAll(async () => {
    await grantTasks('ACO_ADMIN', ['cycles.view', 'monitoring.view']);
  });

  it('an operator lists only the published cycles it takes part in, with its own participant and progress', async () => {
    const list = await adminA.get(CYCLES);
    expect(list.status).toBe(200);
    expect(list.body.data.map((c: { code: string }) => c.code)).toEqual(['CSQ-2026-H2', 'CSQ-LIVE']);
    expect(list.body.data[1].progress).toEqual({ locked: 1, invited: 1, completed: 1 });

    const detail = await adminA.get(`${CYCLES}/${cycle2}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.participantList.map((p: { acoId: string }) => p.acoId)).toEqual([acoA]);
    expect((await adminA.get(`${CYCLES}/${cycle2}/participants`)).body.meta.total).toBe(1);
    const monitoring = await adminA.get(`${CYCLES}/${cycle2}/monitoring`);
    expect(monitoring.body.data.sampling).toMatchObject({ airports: 1, operators: 1, lockedOperators: 1 });
    expect(monitoring.body.data.byAirport.map((a: { iata: string; operators: { code: string }[] }) => [a.iata, a.operators.map((o) => o.code)])).toEqual([['DEL', ['CY-A']]]);
    // Bravo's reminder count is nobody else's business.
    expect((await adminB.get(`${CYCLES}/${cycle2}/participants`)).body.data.map((p: { acoId: string }) => p.acoId)).toEqual([acoB]);
  });

  it('a non-participating operator sees nothing: empty list, 404 everywhere, and 403 only for a missing task', async () => {
    expect((await adminE.get(CYCLES)).body.data).toEqual([]);
    expectError(await adminE.get(`${CYCLES}/${cycle2}`), 404, 'NOT_FOUND');
    expectError(await adminE.get(`${CYCLES}/${cycle2}/participants`), 404, 'NOT_FOUND');
    expectError(await adminE.get(`${CYCLES}/${cycle2}/monitoring`), 404, 'NOT_FOUND');
    expect((await adminE.get(`${CYCLES}/current`)).body.data).toEqual([]);
    // Drafts stay invisible to operators even when they are listed as participants.
    expectError(await adminA.get(`${CYCLES}/${domesticCycle}`), 404, 'NOT_FOUND');
    expectError(await adminA.post(`${CYCLES}/${cycle2}/transition`).send({ to: 'SAMPLING_CLOSED', reason: 'not my call' }), 403, 'FORBIDDEN');
    expectError(await adminA.patch(`${CYCLES}/${cycle2}`).send({ reminders: { sampling: { count: 1, everyDays: 1 }, assessment: { count: 1, everyDays: 1 } } }), 403, 'FORBIDDEN');
  });

  it('GET /cycles/current: the strip, oldest sampling start first, with the next deadline per participant', async () => {
    const res = await adminA.get(`${CYCLES}/current`);
    expect(res.status).toBe(200);
    const [live, upcoming] = res.body.data;
    expect(live.cycle.code).toBe('CSQ-LIVE');
    expect(live.participant).toMatchObject({ acoId: acoA, sampling: { status: 'LOCKED' } });
    expect(live.nextDeadline).toEqual({ kind: 'ASSESSMENT_OPENS', at: live.cycle.assessment.start.utc });
    expect(upcoming.cycle.code).toBe('CSQ-2026-H2');
    expect(upcoming.nextDeadline).toEqual({ kind: 'SAMPLING_OPENS', at: upcoming.cycle.sampling.start.utc });

    const bravo = await adminB.get(`${CYCLES}/current`);
    expect(bravo.body.data[0].nextDeadline).toEqual({ kind: 'SAMPLING_CLOSES', at: live.cycle.sampling.end.utc });

    expectError(await superAdmin.get(`${CYCLES}/current`), 400, 'VALIDATION');
    expect((await superAdmin.get(`${CYCLES}/current?acoId=${acoA}`)).body.data).toHaveLength(2);
    expectError(await adminA.get(`${CYCLES}/current?acoId=${acoB}`), 404, 'NOT_FOUND');
  });
});

describe('POST /cycles/:id/transition (manual override)', () => {
  const url = () => `${CYCLES}/${cycle1}/transition`;

  it('refuses an edge the table does not allow manually, and a reason that is too short', async () => {
    expectError(await superAdmin.post(url()).send({ to: 'ASSESSMENT_OPEN', reason: 'x' }), 400, 'VALIDATION');
    const refused = expectError(await superAdmin.post(url()).send({ to: 'ASSESSMENT_OPEN', reason: 'jump ahead' }), 412, 'PRECONDITION_FAILED');
    expect(refused.message).toBe('Cannot move a PUBLISHED cycle to ASSESSMENT_OPEN');
    expect(refused.details).toMatchObject({ from: 'PUBLISHED', to: 'ASSESSMENT_OPEN', problems: [{ code: 'NOT_ALLOWED' }] });
  });

  it('opens sampling early: audited with the reason, emitted with trigger MANUAL, admins mailed; re-opens after a close', async () => {
    const before = transitioned.length;
    const res = await superAdmin.post(url()).send({ to: 'SAMPLING_OPEN', reason: 'Open early for the demo' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SAMPLING_OPEN');
    expect(transitioned.slice(before)).toEqual([{ cycleId: cycle1, from: 'PUBLISHED', to: 'SAMPLING_OPEN', trigger: 'MANUAL' }]);
    const audit = await AuditModel.findOne({ action: 'cycle.transitioned', entityId: cycle1 }).sort({ at: -1 }).lean();
    expect(audit).toMatchObject({ before: { status: 'PUBLISHED' }, after: { status: 'SAMPLING_OPEN', trigger: 'MANUAL', reason: 'Open early for the demo' } });
    expect(idString(audit!.actorUserId!)).toBe(idString(superAdmin.user._id));
    const open = (await mailsFor(cycle1, 'cycle-published')).filter((mail) => mail.subject.startsWith('Sampling is open'));
    expect(open).toHaveLength(3);

    expect((await superAdmin.post(url()).send({ to: 'SAMPLING_CLOSED', reason: 'Close early' })).body.data.status).toBe('SAMPLING_CLOSED');
    const closed = await mailsFor(cycle1, 'sampling-closed');
    expect(closed.map((mail) => mail.to).sort()).toEqual(['admin@alpha.test', 'admin@bravo.test', 'admin@charlie.test']);
    expect(closed[0]!.subject).toBe('Sampling closed without a locked sample · CSQ 2026 H2 (rev)');

    expect((await superAdmin.post(url()).send({ to: 'SAMPLING_OPEN', reason: 'Re-open: window extended' })).body.data.status).toBe('SAMPLING_OPEN');
    expect((await mailsFor(cycle1, 'cycle-published')).filter((mail) => mail.subject.startsWith('Sampling is open'))).toHaveLength(6);
    expect((await superAdmin.post(url()).send({ to: 'SAMPLING_CLOSED', reason: 'Close again' })).body.data.status).toBe('SAMPLING_CLOSED');
  });

  it('ASSESSMENT_OPEN freezes the market-share snapshot through the organisations hook', async () => {
    const res = await superAdmin.post(url()).send({ to: 'ASSESSMENT_OPEN', reason: 'Activate early' });
    expect(res.body.data).toMatchObject({ status: 'ASSESSMENT_OPEN', marketShareFrozen: true });
    expect(await isMarketShareFrozen(cycle1)).toBe(true);
    expect(await isMarketShareFrozen(cycle2)).toBe(false);
    const frozen = await superAdmin.put(`/api/v1/airports/${del}/market-share`).send({ cycleId: cycle1, entries: [{ acoId: acoA, sharePct: 50 }, { acoId: acoB, sharePct: 50 }] });
    expectError(frozen, 412, 'PRECONDITION_FAILED');
    expect((await superAdmin.get(`/api/v1/airports/${del}/market-share?cycleId=${cycle1}`)).body.data.frozen).toBe(true);
    expect((await superAdmin.get(`/api/v1/airports/${del}/market-share`)).body.data.frozen).toBe(false);
  });

  it('scoring.completed marks SCORED only when not provisional; ARCHIVED is terminal', async () => {
    expect((await superAdmin.post(url()).send({ to: 'ASSESSMENT_CLOSED', reason: 'Close assessment' })).body.data.status).toBe('ASSESSMENT_CLOSED');
    const ctx = systemContext('test: scoring');
    await emit('scoring.completed', { cycleId: cycle1, provisional: true }, { ctx });
    expect((await getCycle(ctx, cycle1)).status).toBe('ASSESSMENT_CLOSED');
    const before = transitioned.length;
    await emit('scoring.completed', { cycleId: cycle1, provisional: false }, { ctx });
    const scored = await getCycle(ctx, cycle1);
    expect(scored.status).toBe('SCORED');
    expect(scored.scoredAt).toBeTruthy();
    expect(transitioned.slice(before)).toEqual([{ cycleId: cycle1, from: 'ASSESSMENT_CLOSED', to: 'SCORED', trigger: 'CLOCK' }]);
    // A second completion for an already scored cycle is ignored.
    await emit('scoring.completed', { cycleId: cycle1, provisional: false }, { ctx });
    expect(transitioned.length).toBe(before + 1);

    expectError(await superAdmin.patch(`${CYCLES}/${cycle1}`).send({ reminders: { sampling: { count: 1, everyDays: 1 }, assessment: { count: 1, everyDays: 1 } } }), 412, 'PRECONDITION_FAILED');
    expect((await superAdmin.post(url()).send({ to: 'ARCHIVED', reason: 'Housekeeping' })).body.data.status).toBe('ARCHIVED');
    expectError(await superAdmin.post(url()).send({ to: 'SAMPLING_OPEN', reason: 'Too late' }), 412, 'PRECONDITION_FAILED');
    expect((await adminA.get(`${CYCLES}/current`)).body.data.map((entry: { cycle: { code: string } }) => entry.cycle.code)).toEqual(['CSQ-LIVE']);
    expect(await AuditModel.countDocuments({ action: 'cycle.transitioned', entityId: cycle1 })).toBe(8);
  });
});
