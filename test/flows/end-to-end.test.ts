// The whole product in one sitting, through the HTTP routes wherever one
// exists — the services only where the brief leaves no route (seeding the
// surveys, ticking the clock with a chosen `now`, reading the score rows) —
// and against its own database (`csq_e2e_test`), so it never collides with a
// module suite running on `csq_test`.
//
// ACFI onboards an operator by link → shares → cycle from an initiation date
// → the operator imports its directory → samples and locks → ACFI opens the
// assessment → three participants complete theirs through the public link
// (OTP revealed, as the demo runs it) → self-assessment → close → scoring →
// dashboards, with the audit trail and the notification log read back at the end.
import Papa from 'papaparse';
import request, { type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { logger } from '../../src/core/logger.js';
import { cyclesTransitions } from '../../src/jobs/cycles.jobs.js';
import { PHASE_I_IATA } from '../../src/modules/airports/airports.regions.js';
import { CUSTOMER_CSV_HEADERS } from '../../src/modules/customers/domain/csvTemplate.js';
import { addCalendarDays } from '../../src/modules/cycles/domain/derive.js';
import { localDateOf, toInstant } from '../../src/modules/cycles/domain/windows.js';
import { sendDueReminders } from '../../src/modules/invitations/invitations.service.js';
import { registrationRateLimit } from '../../src/modules/onboarding/onboarding.ratelimit.js';
import { getScores } from '../../src/modules/scoring/scoring.service.js';
import { seedSurveys } from '../../src/seed/surveys.js';
import { createTestApp, tokenFor, type TestApp, type TestUser } from '../helpers/app.js';
import { airportIdByIata, expectError, operatorPayload } from '../helpers/fixtures.js';
import { answersFor, formQuestionIds } from '../invitations.fixtures.js';

// --- the test's own environment -----------------------------------------------

const E2E_DATABASE = 'csq_e2e_test';
const MONGO = /^(mongodb(?:\+srv)?:\/\/[^/]+)\/([^?]*)(\?.*)?$/;

/** The configured URI with its database swapped for this suite's own. */
function ownDatabase(uri: string): string {
  const match = MONGO.exec(uri);
  if (!match) return uri;
  const [, host, , query = ''] = match;
  return `${host}/${E2E_DATABASE}${query}`;
}

const previousEnv = { MONGO_URI: process.env['MONGO_URI'], DEMO_REVEAL_OTP: process.env['DEMO_REVEAL_OTP'] };

/** Puts the two variables back so a later file in the same worker sees the suite's own environment. */
function restoreEnv(): void {
  if (previousEnv.MONGO_URI === undefined) delete process.env['MONGO_URI'];
  else process.env['MONGO_URI'] = previousEnv.MONGO_URI;
  if (previousEnv.DEMO_REVEAL_OTP === undefined) delete process.env['DEMO_REVEAL_OTP'];
  else process.env['DEMO_REVEAL_OTP'] = previousEnv.DEMO_REVEAL_OTP;
}

// --- constants and shared state -----------------------------------------------

const API = '/api/v1';
const PUBLIC = `${API}/public/assess`;
const LINK_HEADER = 'x-csq-link-token';
const TZ = 'Asia/Kolkata';
const MINUTE = 60_000;
const LINK = /\/assess\/([A-Za-z0-9_-]{43})/;

/** The operator's directory as it fills the CSV template: four domestic-eligible customers and one that is not. */
const DIRECTORY = [
  { name: 'Alpha Freight Forwarders', contact: 'Anita Desai', email: 'anita@alphaff.test', phone: '98450 00001', type: 'FF', surveyType: 'BOTH', tags: 'key-account' },
  { name: 'Bharat Customs House', contact: 'Rahul Verma', email: 'rahul@bharatchb.test', phone: '+91 98450 00002', type: 'CB', surveyType: 'DOMESTIC', tags: '' },
  { name: 'Gamma Logistics', contact: 'Gita Rao', email: 'gita@gamma.test', phone: '98450 00003', type: 'FF', surveyType: 'DOMESTIC', tags: 'small' },
  { name: 'Delta Brokers', contact: 'Deepak Jain', email: 'deepak@delta.test', phone: '98450 00004', type: 'CB', surveyType: 'DOMESTIC', tags: '' },
  { name: 'Overseas Movers', contact: 'Omar Khan', email: 'omar@overseas.test', phone: '98450 00005', type: 'FF', surveyType: 'INTERNATIONAL', tags: '' },
] as const;

const REGISTRATION_FORM = {
  organisation: {
    name: 'Deccan Cargo Handlers',
    legalName: 'Deccan Cargo Handlers Pvt Ltd',
    address: { line1: 'Cargo Terminal 2', city: 'New Delhi', state: 'Delhi', pincode: '110037' },
    contact: { name: 'Shift Desk', email: 'desk@deccan.test', phone: '+91 11 2565 0000' },
  },
  admin: { name: 'Arjun Reddy', email: 'arjun@deccan.test', phone: '+91 90000 00000' },
  operations: { domestic: true, international: true },
  marketSharePct: 60,
};

/** A signed-in client for a user who came through onboarding (not the test fixture's shortcut). */
interface Client {
  get(path: string): Test;
  post(path: string): Test;
  put(path: string): Test;
  patch(path: string): Test;
}

interface MailRow {
  template: string;
  to: string;
  body: string;
  status: string;
  vars: Record<string, unknown>;
}

let t: TestApp;
let superAdmin: TestUser;
let del: string;
let bom: string;
let onboardingToken: string;
let registrationId: string;
let acoA: string;
let acoB: string;
let arjunId: string;
let adminA: Client;
let adminB: Client;
let domesticSurveyId: string;
let cycleId: string;
let samplingEnd: Date;
let assessmentStart: Date;
let questionIds: string[] = [];
let overallMean: number | null = null;
/** e-mail → customer id, link token, link session. */
const customerIds = new Map<string, string>();
const tokens = new Map<string, string>();
const sessions = new Map<string, string>();

function clientFor(token: string, orgId: string): Client {
  const headers = { Authorization: `Bearer ${token}`, 'x-csq-org': orgId };
  const agent = request(t.app);
  return {
    get: (path) => agent.get(path).set(headers),
    post: (path) => agent.post(path).set(headers),
    put: (path) => agent.put(path).set(headers),
    patch: (path) => agent.patch(path).set(headers),
  };
}

const customerId = (email: string): string => {
  const id = customerIds.get(email);
  if (!id) throw new Error(`No customer ${email}`);
  return id;
};

/** The notification log, oldest first, as ACFI reads it. */
async function mailLog(filter = ''): Promise<MailRow[]> {
  const res = await superAdmin.get(`${API}/notifications?sort=createdAt&pageSize=200${filter}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as MailRow[];
}

const recipientsOf = (log: MailRow[], template: string): string[] => log.filter((mail) => mail.template === template).map((mail) => mail.to);

function patchAnswers(token: string, session: string, answers: unknown[]): Test {
  return t.anon.patch(`${PUBLIC}/${token}/answers`).set(LINK_HEADER, session).send({ answers });
}

/** One participant end to end through the link: open, code, verify, form, every answer at `rating`, submit. */
async function completeThroughLink(email: string, rating: number, expectedType: 'FF' | 'CB'): Promise<void> {
  const token = tokens.get(email);
  if (!token) throw new Error(`No link for ${email}`);
  const status = await t.anon.get(`${PUBLIC}/${token}`);
  expect(status.status, JSON.stringify(status.body)).toBe(200);
  expect(status.body.data).toMatchObject({ state: 'OPENED', customer: { type: expectedType } });
  const otp = await t.anon.post(`${PUBLIC}/${token}/otp`);
  expect(otp.status, JSON.stringify(otp.body)).toBe(200);
  const verify = await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp: otp.body.data.devOtp });
  expect(verify.status, JSON.stringify(verify.body)).toBe(200);
  const session = verify.body.data.sessionToken as string;
  const form = await t.anon.get(`${PUBLIC}/${token}/form`).set(LINK_HEADER, session);
  expect(form.status, JSON.stringify(form.body)).toBe(200);
  expect(form.body.data.stakeholderType).toBe(expectedType);
  const saved = await patchAnswers(token, session, answersFor(formQuestionIds(form.body.data), rating));
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.data).toMatchObject({ answered: 23, total: 23, pct: 100 });
  const submit = await t.anon.post(`${PUBLIC}/${token}/submit`).set(LINK_HEADER, session);
  expect(submit.status, JSON.stringify(submit.body)).toBe(200);
  expect(submit.body.data).toMatchObject({ state: 'SUBMITTED', assessment: { status: 'SUBMITTED', customerType: expectedType } });
}

beforeAll(async () => {
  process.env['MONGO_URI'] = ownDatabase(process.env['MONGO_URI'] ?? `mongodb://127.0.0.1:27017/${E2E_DATABASE}?replicaSet=rs0`);
  process.env['DEMO_REVEAL_OTP'] = 'true';
  t = await createTestApp();
  expect(t.env.MONGO_URI).toContain(`/${E2E_DATABASE}`);
  expect(t.env.DEMO_REVEAL_OTP).toBe(true);
  registrationRateLimit.reset();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin', email: 'admin@acfi.test' });
  [del, bom] = await Promise.all([airportIdByIata('DEL'), airportIdByIata('BOM')]);
});
afterAll(async () => {
  await t.close();
  restoreEnv();
});

describe('CSQ end to end: onboarding → cycle → sampling → assessment → scoring → reports', () => {
  it('01 · ACFI mints an onboarding link for an operator at DEL; the applicant can open it', async () => {
    const res = await superAdmin.post(`${API}/onboarding/links`).send({ orgType: 'ACO', airportId: del, expiresInDays: 7, note: 'Deccan Cargo (demo)' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ orgType: 'ACO', airport: { id: del, iata: 'DEL' }, status: 'OPEN' });
    expect(res.body.data.url).toContain(`${t.env.PUBLIC_WEB_URL}/register/`);
    onboardingToken = (res.body.data.url as string).split('/register/')[1]!;

    const page = await t.anon.get(`${API}/public/onboarding/${onboardingToken}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.data).toMatchObject({ orgType: 'ACO', airport: { id: del, iata: 'DEL' }, used: false });
    expectError(await t.anon.get(`${API}/public/onboarding/${'x'.repeat(43)}`), 404, 'NOT_FOUND');
  });

  it('02 · the applicant registers through the public form, asking for a 60 % share; the link is spent', async () => {
    const res = await t.anon.post(`${API}/public/onboarding/${onboardingToken}`).send(REGISTRATION_FORM);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    registrationId = res.body.data.registrationId;

    expect((await t.anon.get(`${API}/public/onboarding/${onboardingToken}`)).body.data.used).toBe(true);
    expectError(await t.anon.post(`${API}/public/onboarding/${onboardingToken}`).send(REGISTRATION_FORM), 409, 'CONFLICT');

    const log = await mailLog();
    expect(log.map((mail) => [mail.template, mail.to])).toEqual([
      ['registration-received', 'arjun@deccan.test'],
      ['generic', 'admin@acfi.test'],
    ]);
  });

  it('03 · ACFI reviews the request with DEL’s share total in view and approves it: organisation ACTIVE, admin INVITED', async () => {
    const pending = await superAdmin.get(`${API}/registrations?status=SUBMITTED`);
    expect((pending.body.data as { id: string }[]).map((row) => row.id)).toEqual([registrationId]);
    const detail = await superAdmin.get(`${API}/registrations/${registrationId}`);
    expect(detail.body.data).toMatchObject({
      status: 'SUBMITTED',
      airport: { iata: 'DEL' },
      marketSharePct: 60,
      marketShare: { entries: [], total: 0, projectedTotal: 60 },
    });

    const approved = await superAdmin.post(`${API}/registrations/${registrationId}/approve`).send({ code: 'DEL-DECCAN', note: 'Welcome aboard' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', reviewNote: 'Welcome aboard', marketShare: { total: 60, projectedTotal: 60 } });
    acoA = approved.body.data.resultOrgId;
    expectError(await superAdmin.post(`${API}/registrations/${registrationId}/approve`).send({ code: 'DEL-DECCAN' }), 409, 'CONFLICT');

    const operators = await superAdmin.get(`${API}/operators?airportId=${del}`);
    expect(operators.body.data).toEqual([
      expect.objectContaining({ id: acoA, code: 'DEL-DECCAN', name: 'Deccan Cargo Handlers', status: 'ACTIVE', createdVia: 'LINK', memberCount: 1, customerCount: 0, currentShare: 60 }),
    ]);
    const users = await superAdmin.get(`${API}/users?q=arjun`);
    expect(users.body.data).toEqual([expect.objectContaining({ email: 'arjun@deccan.test', name: 'Arjun Reddy', status: 'INVITED' })]);
    expect(recipientsOf(await mailLog(), 'registration-approved')).toEqual(['arjun@deccan.test']);
  });

  it('04 · the new admin signs in for the first time, is linked by e-mail and lands in the ACO scope', async () => {
    const token = tokenFor({ sub: 'kc-arjun', email: 'ARJUN@deccan.test', name: 'Arjun Reddy', email_verified: true });
    const me = await t.anon.get(`${API}/me`).set('Authorization', `Bearer ${token}`);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.data.user).toMatchObject({ email: 'arjun@deccan.test', name: 'Arjun Reddy', status: 'ACTIVE' });
    expect(me.body.data.active).toMatchObject({ orgId: acoA, roleCode: 'ACO_ADMIN', scope: { kind: 'ACO', acoId: acoA } });
    expect(me.body.data.active.tasks).toEqual(expect.arrayContaining(['customers.manage', 'sampling.lock', 'assessments.self', 'reports.operator']));
    arjunId = me.body.data.user.id;

    adminA = clientFor(token, acoA);
    expectError(await adminA.get(`${API}/registrations`), 403, 'FORBIDDEN');
    expect((await adminA.get(`${API}/cycles/current`)).body.data).toEqual([]);
  });

  it('05 · ACFI adds a second operator at BOM by hand with its full share; its admin signs in too', async () => {
    const res = await superAdmin.post(`${API}/operators`).send(
      operatorPayload(bom, {
        code: 'BOM-HARBOUR',
        name: 'Harbour Cargo Terminal',
        legalName: 'Harbour Cargo Terminal Ltd',
        contact: { name: 'Ops Desk', email: 'ops@harbour.test', phone: '+91 22 6685 0000' },
        admin: { name: 'Bhavin Shah', email: 'bhavin@harbour.test', phone: '+91 98200 00000' },
        marketSharePct: 100,
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    acoB = res.body.data.id;
    expect(res.body.data).toMatchObject({ code: 'BOM-HARBOUR', airport: { id: bom, iata: 'BOM' }, status: 'ACTIVE', currentShare: 100, memberCount: 1 });

    adminB = clientFor(tokenFor({ sub: 'kc-bhavin', email: 'bhavin@harbour.test', name: 'Bhavin Shah', email_verified: true }), acoB);
    const me = await adminB.get(`${API}/me`);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.data.active).toMatchObject({ orgId: acoB, roleCode: 'ACO_ADMIN', scope: { kind: 'ACO', acoId: acoB } });
    // Operator records are platform business: the seeded matrix gives an ACO admin no `operators.view` at all.
    expect(expectError(await adminB.get(`${API}/operators/${acoA}`), 403, 'FORBIDDEN').details).toEqual({ task: 'operators.view' });
    expect(recipientsOf(await mailLog(), 'account-invited')).toEqual(['bhavin@harbour.test']);
  });

  it('06 · with the ACFI surveys seeded, ACFI drafts a DOMESTIC cycle from an initiation date; the windows come from the defaults', async () => {
    const seeded = await seedSurveys();
    expect(seeded.DOMESTIC).toMatchObject({ version: 1, status: 'PUBLISHED', questions: 23 });
    domesticSurveyId = seeded.DOMESTIC.id;
    const surveys = await superAdmin.get(`${API}/surveys`);
    expect(surveys.status, JSON.stringify(surveys.body)).toBe(200);
    expect(
      (surveys.body.data as { code: string; publishedVersionId: string | null }[]).map((survey) => [survey.code, survey.publishedVersionId !== null]).sort(),
    ).toEqual([
      ['DOMESTIC', true],
      ['INTERNATIONAL', true],
    ]);

    const initiationDate = localDateOf(new Date(), TZ);
    const created = await superAdmin.post(`${API}/cycles`).send({
      name: 'CSQ Demo 2026',
      code: 'CSQ-DEMO-2026',
      type: 'DOMESTIC',
      initiationDate,
      minSampleSize: 3,
      participatingAirportIds: [del, bom],
      participatingAcoIds: [acoA, acoB],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    cycleId = created.body.data.id;
    const samplingEndDate = addCalendarDays(initiationDate, 10);
    expect(created.body.data).toMatchObject({
      status: 'DRAFT',
      tz: TZ,
      sampling: { start: { wall: `${initiationDate}T00:00` }, end: { wall: `${samplingEndDate}T00:00` } },
      assessment: { start: { wall: `${samplingEndDate}T00:00` }, end: { wall: `${addCalendarDays(samplingEndDate, 30)}T00:00` } },
      reminders: { sampling: { count: 3, everyDays: 3 }, assessment: { count: 10, everyDays: 2 } },
      surveyVersions: { DOMESTIC: null, INTERNATIONAL: null },
      participantList: [],
    });
    samplingEnd = new Date(created.body.data.sampling.end.utc);
    assessmentStart = new Date(created.body.data.assessment.start.utc);
    expect(assessmentStart.getTime()).toBe(samplingEnd.getTime());
    // A draft is ACFI's business: the operators do not see it yet.
    expectError(await adminA.get(`${API}/cycles/${cycleId}`), 404, 'NOT_FOUND');
  });

  it('07 · publishing is refused while DEL’s shares total 60; at 100 the cycle opens sampling at once', async () => {
    const refused = expectError(await superAdmin.post(`${API}/cycles/${cycleId}/publish`), 412, 'PRECONDITION_FAILED');
    expect(refused.message).toContain('DEL');
    expect(refused.details).toMatchObject({ airportId: del, iata: 'DEL', total: 60 });

    const shares = await superAdmin.put(`${API}/airports/${del}/market-share`).send({ entries: [{ acoId: acoA, sharePct: 100 }] });
    expect(shares.status, JSON.stringify(shares.body)).toBe(200);
    expect(shares.body.data).toMatchObject({ airportId: del, cycleId: null, total: 100, frozen: false });

    const published = await superAdmin.post(`${API}/cycles/${cycleId}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.data).toMatchObject({ status: 'SAMPLING_OPEN', surveyVersions: { DOMESTIC: domesticSurveyId, INTERNATIONAL: null }, marketShareFrozen: false });
    const participants = published.body.data.participantList as { operator: { code: string }; surveyTypes: string[]; requiredSampleSize: number; sampling: { status: string } }[];
    expect(participants.map((p) => [p.operator.code, p.surveyTypes, p.requiredSampleSize, p.sampling.status]).sort()).toEqual([
      ['BOM-HARBOUR', ['DOMESTIC'], 3, 'NOT_STARTED'],
      ['DEL-DECCAN', ['DOMESTIC'], 3, 'NOT_STARTED'],
    ]);
    expectError(await superAdmin.post(`${API}/cycles/${cycleId}/publish`), 412, 'PRECONDITION_FAILED');

    // The shares were snapshotted under the cycle.
    const snapshot = await superAdmin.get(`${API}/airports/${del}/market-share?cycleId=${cycleId}`);
    expect(snapshot.body.data).toMatchObject({ cycleId, total: 100, frozen: false, entries: [{ acoId: acoA, sharePct: 100 }] });

    // The operator now has a cycle to act on: the strip says when sampling closes.
    const current = await adminA.get(`${API}/cycles/current`);
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(current.body.data).toEqual([
      expect.objectContaining({
        cycle: expect.objectContaining({ id: cycleId, code: 'CSQ-DEMO-2026', status: 'SAMPLING_OPEN' }),
        participant: expect.objectContaining({ acoId: acoA, requiredSampleSize: 3 }),
        nextDeadline: { kind: 'SAMPLING_CLOSES', at: samplingEnd.toISOString() },
      }),
    ]);
    expect(recipientsOf(await mailLog(), 'cycle-published').sort()).toEqual(['arjun@deccan.test', 'bhavin@harbour.test']);
  });

  it('08 · the operator downloads the template, fills it and imports its directory: validate, then commit', async () => {
    const template = await adminA.get(`${API}/customers/import/template`);
    expect(template.status).toBe(200);
    expect(template.text.split('\r\n')[0]).toBe(CUSTOMER_CSV_HEADERS.join(','));

    const csv = Papa.unparse({
      fields: [...CUSTOMER_CSV_HEADERS],
      data: DIRECTORY.map((row) => [row.name, row.contact, row.email, row.phone, row.type, row.surveyType, row.tags]),
    });
    const validated = await adminA.post(`${API}/customers/import/validate?fileName=directory.csv`).set('Content-Type', 'text/csv').send(csv);
    expect(validated.status, JSON.stringify(validated.body)).toBe(201);
    expect(validated.body.data).toMatchObject({ status: 'VALIDATED', fileName: 'directory.csv', rows: 5, accepted: 5, rejected: 0, errors: [] });
    expect((validated.body.data.preview as { action: string }[]).every((row) => row.action === 'CREATE')).toBe(true);

    const importId = validated.body.data.importId as string;
    const committed = await adminA.post(`${API}/customers/import/${importId}/commit`);
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect(committed.body.data).toMatchObject({ status: 'COMMITTED', created: 5, updated: 0 });
    expectError(await adminA.post(`${API}/customers/import/${importId}/commit`), 409, 'CONFLICT');

    const list = await adminA.get(`${API}/customers?pageSize=50`);
    expect(list.body.meta.total).toBe(5);
    for (const row of list.body.data as { id: string; email: string }[]) customerIds.set(row.email, row.id);
    expect([...customerIds.keys()].sort()).toEqual(DIRECTORY.map((row) => row.email).sort());
    expect((await superAdmin.get(`${API}/operators/${acoA}`)).body.data.customerCount).toBe(5);
    // Another operator's directory is empty from here.
    expect((await adminB.get(`${API}/customers`)).body.meta.total).toBe(0);
  });

  it('09 · the sampling page: 3 required, nothing selected, 4 eligible (the international-only customer is not), served expanded and paginated', async () => {
    const state = await adminA.get(`${API}/sampling/cycles/${cycleId}`);
    expect(state.status, JSON.stringify(state.body)).toBe(200);
    expect(state.body.data).toMatchObject({
      cycle: { id: cycleId, code: 'CSQ-DEMO-2026', status: 'SAMPLING_OPEN' },
      participant: { acoId: acoA, surveyTypes: ['DOMESTIC'], requiredSampleSize: 3, sampling: { status: 'NOT_STARTED', selectedCount: 0, lockedBy: null, lockedByUser: null } },
      required: 3,
      selectedCount: 0,
      eligibleCount: 4,
      lockable: false,
      reason: 'NOTHING_SELECTED',
      shortfallRule: null,
      remaining: 3,
      progress: '0 / 3',
      progressPct: 0,
      editable: true,
      selection: [],
    });

    const page1 = await adminA.get(`${API}/customers/eligible?cycleId=${cycleId}&pageSize=3`);
    expect(page1.status, JSON.stringify(page1.body)).toBe(200);
    expect(page1.body.meta).toEqual({ page: 1, pageSize: 3, total: 4 });
    const rows = page1.body.data as { customer: { id: string; name: string }; surveyType: string; key: string }[];
    expect(rows.map((row) => [row.customer.name, row.surveyType])).toEqual([
      ['Alpha Freight Forwarders', 'DOMESTIC'],
      ['Bharat Customs House', 'DOMESTIC'],
      ['Delta Brokers', 'DOMESTIC'],
    ]);
    expect(rows.every((row) => row.key === `${row.customer.id}:DOMESTIC`)).toBe(true);
    const page2 = await adminA.get(`${API}/customers/eligible?cycleId=${cycleId}&pageSize=3&page=2`);
    expect((page2.body.data as { customer: { name: string } }[]).map((row) => row.customer.name)).toEqual(['Gamma Logistics']);
    expect(JSON.stringify(page1.body) + JSON.stringify(page2.body)).not.toContain('Overseas');
  });

  it('10 · two selected is below the minimum: the lock is refused and select-all is not an option', async () => {
    const selected = await adminA.put(`${API}/sampling/cycles/${cycleId}/selection`).send({
      add: [
        { customerId: customerId('anita@alphaff.test'), surveyType: 'DOMESTIC' },
        { customerId: customerId('rahul@bharatchb.test'), surveyType: 'DOMESTIC' },
      ],
    });
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    expect(selected.body.data).toMatchObject({
      rejected: [],
      state: { selectedCount: 2, lockable: false, reason: 'BELOW_MINIMUM', remaining: 1, progress: '2 / 3', participant: { sampling: { status: 'IN_PROGRESS', selectedCount: 2 } } },
    });
    expect(selected.body.data.added).toHaveLength(2);

    const refused = expectError(await adminA.post(`${API}/sampling/cycles/${cycleId}/lock`), 412, 'PRECONDITION_FAILED');
    expect(refused.details).toMatchObject({ reason: 'BELOW_MINIMUM', required: 3, selectedCount: 2, eligibleCount: 4, remaining: 1 });
    expectError(await adminA.post(`${API}/sampling/cycles/${cycleId}/select-all`), 412, 'PRECONDITION_FAILED');

    // A customer who does not run the cycle's survey type is rejected per item, not as a whole.
    const wrong = await adminA.put(`${API}/sampling/cycles/${cycleId}/selection`).send({ add: [{ customerId: customerId('omar@overseas.test'), surveyType: 'INTERNATIONAL' }] });
    expect(wrong.status).toBe(200);
    expect(wrong.body.data.rejected).toEqual([expect.objectContaining({ customerId: customerId('omar@overseas.test'), reason: 'WRONG_SURVEY_TYPE' })]);
    expect(wrong.body.data.state.selectedCount).toBe(2);
  });

  it('11 · a third entry makes the sample lockable; the lock creates PENDING invitations in the same transaction', async () => {
    const more = await adminA.put(`${API}/sampling/cycles/${cycleId}/selection`).send({ add: [{ customerId: customerId('gita@gamma.test'), surveyType: 'DOMESTIC' }] });
    expect(more.status, JSON.stringify(more.body)).toBe(200);
    expect(more.body.data.state).toMatchObject({ selectedCount: 3, lockable: true, reason: null, progressPct: 100 });

    const lock = await adminA.post(`${API}/sampling/cycles/${cycleId}/lock`);
    expect(lock.status, JSON.stringify(lock.body)).toBe(200);
    expect(lock.body.data).toMatchObject({
      lockable: false,
      reason: 'ALREADY_LOCKED',
      editable: false,
      participant: { sampling: { status: 'LOCKED', selectedCount: 3, lockedBy: arjunId, lockedByUser: { id: arjunId, name: 'Arjun Reddy' }, unlockedByUser: null } },
    });
    expect((lock.body.data.selection as { customer: { name: string }; state: string }[]).map((row) => [row.customer.name, row.state])).toEqual([
      ['Alpha Freight Forwarders', 'LOCKED'],
      ['Bharat Customs House', 'LOCKED'],
      ['Gamma Logistics', 'LOCKED'],
    ]);
    expectError(await adminA.post(`${API}/sampling/cycles/${cycleId}/lock`), 412, 'PRECONDITION_FAILED');

    const invitations = await adminA.get(`${API}/invitations?cycleId=${cycleId}`);
    expect(invitations.status, JSON.stringify(invitations.body)).toBe(200);
    expect(invitations.body.meta.total).toBe(3);
    const rows = invitations.body.data as { state: string; emailMasked: string; customer: { type: string } }[];
    expect(rows.every((row) => row.state === 'PENDING' && !row.emailMasked.includes('anita') && !row.emailMasked.includes('rahul'))).toBe(true);
    expect(rows.map((row) => row.customer.type).sort()).toEqual(['CB', 'FF', 'FF']);

    // The cycles module sees the lock: participants, monitoring and the strip.
    const locked = await superAdmin.get(`${API}/cycles/${cycleId}/participants?samplingStatus=LOCKED`);
    expect(locked.body.data).toEqual([expect.objectContaining({ acoId: acoA, sampling: expect.objectContaining({ status: 'LOCKED', selectedCount: 3 }) })]);
    const monitoring = await superAdmin.get(`${API}/cycles/${cycleId}/monitoring`);
    expect(monitoring.body.data.sampling).toMatchObject({ airports: 2, operators: 2, sampleLocked: 3, lockedOperators: 1 });
    expect((await adminA.get(`${API}/cycles/current`)).body.data[0].nextDeadline).toEqual({ kind: 'ASSESSMENT_OPENS', at: assessmentStart.toISOString() });
    expect(recipientsOf(await mailLog(), 'sample-locked')).toEqual(['arjun@deccan.test']);
  });

  it('12 · the clock does nothing before the window end; ACFI closes sampling and opens the assessment by hand, and the invitations go out', async () => {
    await cyclesTransitions({ now: new Date(samplingEnd.getTime() - MINUTE), log: logger });
    expect((await superAdmin.get(`${API}/cycles/${cycleId}`)).body.data.status).toBe('SAMPLING_OPEN');

    expectError(await superAdmin.post(`${API}/cycles/${cycleId}/transition`).send({ to: 'ASSESSMENT_OPEN', reason: 'Skipping a step' }), 412, 'PRECONDITION_FAILED');
    expectError(await adminA.post(`${API}/cycles/${cycleId}/transition`).send({ to: 'SAMPLING_CLOSED', reason: 'From the operator side' }), 403, 'FORBIDDEN');

    const closed = await superAdmin.post(`${API}/cycles/${cycleId}/transition`).send({ to: 'SAMPLING_CLOSED', reason: 'Demo: everyone who will lock has locked' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.status).toBe('SAMPLING_CLOSED');
    // The operator that never locked is told; the locked one is not.
    expect(recipientsOf(await mailLog(), 'sampling-closed')).toEqual(['bhavin@harbour.test']);

    const opened = await superAdmin.post(`${API}/cycles/${cycleId}/transition`).send({ to: 'ASSESSMENT_OPEN', reason: 'Demo: open the assessment window early' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body.data).toMatchObject({ status: 'ASSESSMENT_OPEN', marketShareFrozen: true });
    expectError(
      await superAdmin.put(`${API}/airports/${del}/market-share`).send({ cycleId, entries: [{ acoId: acoA, sharePct: 100 }] }),
      412,
      'PRECONDITION_FAILED',
    );

    const invitations = await adminA.get(`${API}/invitations?cycleId=${cycleId}`);
    expect((invitations.body.data as { state: string; sentAt: string | null }[]).every((row) => row.state === 'SENT' && row.sentAt !== null)).toBe(true);

    // The links, read back from the notification log the way ACFI would.
    const sent = await mailLog(`&cycleId=${cycleId}&template=assessment-invitation`);
    expect(sent).toHaveLength(3);
    for (const mail of sent) {
      expect(mail.status).toBe('SENT');
      expect(mail.body).toContain(`${t.env.PUBLIC_WEB_URL}/assess/`);
      const match = LINK.exec(mail.body);
      expect(match).not.toBeNull();
      tokens.set(mail.to, match![1]!);
    }
    expect([...tokens.keys()].sort()).toEqual(['anita@alphaff.test', 'gita@gamma.test', 'rahul@bharatchb.test']);
    expect((await superAdmin.get(`${API}/cycles/${cycleId}/monitoring`)).body.data.assessment).toEqual({ invited: 3, started: 0, completed: 0, pending: 3, completionRate: 0 });
  });

  it('13 · the clock sends the first assessment reminder two days in, with a fresh link each; the first link keeps working', async () => {
    const reminderAt = toInstant({ wall: `${addCalendarDays(localDateOf(assessmentStart, TZ), 2)}T09:30`, tz: TZ });
    expect(await sendDueReminders(new Date(reminderAt.getTime() - 60 * MINUTE))).toEqual({ sent: 0 });
    expect(await sendDueReminders(reminderAt)).toEqual({ sent: 3 });
    expect(await sendDueReminders(reminderAt)).toEqual({ sent: 0 });

    const reminders = await mailLog(`&cycleId=${cycleId}&template=assessment-reminder`);
    expect(reminders.map((mail) => mail.vars['reminderNumber'])).toEqual([1, 1, 1]);
    expect((await adminA.get(`${API}/invitations?cycleId=${cycleId}`)).body.data.every((row: { remindersSent: number }) => row.remindersSent === 1)).toBe(true);

    const fresh = LINK.exec(reminders[0]!.body)![1]!;
    expect((await t.anon.get(`${PUBLIC}/${fresh}`)).status).toBe(200);
    expect((await t.anon.get(`${PUBLIC}/${tokens.get('anita@alphaff.test')}`)).status).toBe(200);
  });

  it('14 · a participant opens the link, asks for a code (revealed in demo mode), mistypes it, then verifies', async () => {
    const token = tokens.get('anita@alphaff.test')!;
    const status = await t.anon.get(`${PUBLIC}/${token}`);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body.data).toMatchObject({
      state: 'OPENED',
      cycle: { id: cycleId, name: 'CSQ Demo 2026', tz: TZ },
      operator: { name: 'Deccan Cargo Handlers', airport: { iata: 'DEL' } },
      surveyType: 'DOMESTIC',
      customer: { type: 'FF' },
      submittedAt: null,
    });
    expect(status.body.data.customer.emailMasked).not.toContain('anita');
    expect(status.body.data.customer.nameMasked).not.toContain('Alpha');
    // Nothing of the form before the code is verified.
    expectError(await t.anon.get(`${PUBLIC}/${token}/form`), 401, 'UNAUTHENTICATED');

    const otp = await t.anon.post(`${PUBLIC}/${token}/otp`);
    expect(otp.status, JSON.stringify(otp.body)).toBe(200);
    expect(otp.body.data).toMatchObject({ sent: true, devOtp: expect.stringMatching(/^\d{6}$/) });
    const code = otp.body.data.devOtp as string;
    const otpMail = await mailLog(`&cycleId=${cycleId}&template=assessment-otp`);
    expect(otpMail.map((mail) => [mail.to, mail.vars['otp']])).toEqual([['anita@alphaff.test', code]]);

    const wrong = expectError(await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp: code === '000000' ? '111111' : '000000' }), 400, 'OTP_INVALID');
    expect(wrong.details).toMatchObject({ reason: 'MISMATCH', attemptsLeft: 4 });
    expect(expectError(await t.anon.post(`${PUBLIC}/${token}/otp`), 429, 'RATE_LIMITED').details).toMatchObject({ reason: 'COOLDOWN' });

    const verify = await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp: code });
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    expect(verify.body.data).toMatchObject({ sessionToken: expect.any(String), assessmentId: expect.any(String) });
    sessions.set('anita@alphaff.test', verify.body.data.sessionToken);
    expect((await t.anon.get(`${PUBLIC}/${token}`)).body.data.state).toBe('VERIFIED');
    expect((await superAdmin.get(`${API}/cycles/${cycleId}/monitoring`)).body.data.assessment).toMatchObject({ invited: 3, started: 1, completed: 0 });
    // The code is consumed with the verification.
    expectError(await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp: code }), 400, 'OTP_INVALID');
  });

  it('15 · the form applies its rules while the participant answers; submit waits for every question, then locks', async () => {
    const token = tokens.get('anita@alphaff.test')!;
    const session = sessions.get('anita@alphaff.test')!;
    const form = await t.anon.get(`${PUBLIC}/${token}/form`).set(LINK_HEADER, session);
    expect(form.status, JSON.stringify(form.body)).toBe(200);
    expect(form.body.data).toMatchObject({
      survey: { id: domesticSurveyId, code: 'DOMESTIC', version: 1, status: 'PUBLISHED' },
      stakeholderType: 'FF',
      questionCount: 23,
      progress: { answered: 0, total: 23, pct: 0 },
      assessment: { kind: 'CUSTOMER', customerType: 'FF', status: 'DRAFT' },
    });
    expect((form.body.data.categories as { code: string }[]).map((category) => category.code)).toEqual(['INFRA', 'SEC', 'PROC', 'TRADE']);
    questionIds = formQuestionIds(form.body.data);
    expect(questionIds).toHaveLength(23);
    const [first, second, ...rest] = questionIds as [string, string, ...string[]];
    const firstQuestion = form.body.data.categories[0].questions[0] as { id: string; commentMode: string; followUp: { options: string[] } | null };
    expect(firstQuestion).toMatchObject({ id: first, commentMode: 'REQUIRED_ON_LOW' });

    // Fair without a comment is refused — the batch as a whole, naming the issue.
    const low = expectError(await patchAnswers(token, session, [{ questionId: first, rating: 2 }]), 400, 'VALIDATION');
    expect(JSON.stringify(low.details)).toMatch(/comment/i);
    expectError(await patchAnswers(token, session, [{ questionId: first, rating: 6 }]), 400, 'VALIDATION');
    expectError(await patchAnswers(token, session, [{ questionId: 'not-a-question', rating: 4 }]), 400, 'VALIDATION');
    expectError(await patchAnswers(token, session, [{ questionId: first, rating: 4, na: true }]), 400, 'VALIDATION');

    // A comment (and a follow-up option) make the low rating acceptable; NA stands on its own.
    const saved = await patchAnswers(token, session, [
      { questionId: first, rating: 2, comment: 'Acceptance takes too long at peak hours', followUp: firstQuestion.followUp ? [firstQuestion.followUp.options[0]] : [] },
      { questionId: second, na: true },
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toMatchObject({ answered: 2, total: 23 });
    const readiness = await t.anon.get(`${PUBLIC}/${token}/readiness`).set(LINK_HEADER, session);
    expect(readiness.body.data).toMatchObject({ answered: 2, total: 23, complete: false });
    expect(readiness.body.data.missing).toEqual(rest);
    expect(expectError(await t.anon.post(`${PUBLIC}/${token}/submit`).set(LINK_HEADER, session), 412, 'PRECONDITION_FAILED').details).toMatchObject({ missing: rest });

    const done = await patchAnswers(token, session, answersFor(rest, 4));
    expect(done.body.data).toMatchObject({ answered: 23, total: 23, pct: 100 });
    const draft = await t.anon.get(`${PUBLIC}/${token}/draft`).set(LINK_HEADER, session);
    expect(draft.body.data).toMatchObject({ status: 'DRAFT', progress: { answered: 23, pct: 100 } });
    expect((draft.body.data.answers as { questionId: string; na: boolean; rating: number | null }[]).find((answer) => answer.questionId === second)).toMatchObject({ na: true, rating: null });

    const submit = await t.anon.post(`${PUBLIC}/${token}/submit`).set(LINK_HEADER, session);
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    expect(submit.body.data).toMatchObject({ state: 'SUBMITTED', assessment: { status: 'SUBMITTED', kind: 'CUSTOMER', customerType: 'FF', progress: { answered: 23, total: 23, pct: 100 } } });
    expect(submit.body.data.submittedAt).not.toBeNull();

    // Read-only from here; the page says so.
    expectError(await patchAnswers(token, session, [{ questionId: first, rating: 5 }]), 412, 'PRECONDITION_FAILED');
    expectError(await t.anon.post(`${PUBLIC}/${token}/submit`).set(LINK_HEADER, session), 412, 'PRECONDITION_FAILED');
    expect((await t.anon.get(`${PUBLIC}/${token}/draft`).set(LINK_HEADER, session)).body.data.status).toBe('SUBMITTED');
    expect((await t.anon.get(`${PUBLIC}/${token}`)).body.data.state).toBe('SUBMITTED');
    expect((await adminA.get(`${API}/invitations?cycleId=${cycleId}&state=SUBMITTED`)).body.meta.total).toBe(1);
    expect(recipientsOf(await mailLog(), 'assessment-thank-you')).toEqual(['anita@alphaff.test']);
    expect((await superAdmin.get(`${API}/cycles/${cycleId}/monitoring`)).body.data.assessment).toEqual({ invited: 3, started: 1, completed: 1, pending: 2, completionRate: 33.3 });
  });

  it('16 · the other two participants complete theirs through the same link flow; every invitation is SUBMITTED', async () => {
    await completeThroughLink('rahul@bharatchb.test', 5, 'CB');
    await completeThroughLink('gita@gamma.test', 3, 'FF');

    expect((await adminA.get(`${API}/invitations?cycleId=${cycleId}`)).body.data.map((row: { state: string }) => row.state)).toEqual(['SUBMITTED', 'SUBMITTED', 'SUBMITTED']);
    expect((await superAdmin.get(`${API}/cycles/${cycleId}/monitoring`)).body.data.assessment).toEqual({ invited: 3, started: 3, completed: 3, pending: 0, completionRate: 100 });

    // The operator's history: masked assessors, the NA-excluding score of each submission.
    const history = await adminA.get(`${API}/assessments?cycleId=${cycleId}&kind=CUSTOMER&sort=submittedAt`);
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    const rows = history.body.data as { customerType: string; status: string; score: number; assessorName: string; assessor: { revealed: boolean } }[];
    expect(rows.map((row) => [row.customerType, row.status, row.score])).toEqual([
      ['FF', 'SUBMITTED', 3.9],
      ['CB', 'SUBMITTED', 5],
      ['FF', 'SUBMITTED', 3],
    ]);
    expect(rows.every((row) => !row.assessor.revealed && !/Anita|Rahul|Gita/.test(row.assessorName))).toBe(true);
    expect((await adminB.get(`${API}/assessments?cycleId=${cycleId}`)).body.meta.total).toBe(0);
  });

  it('17 · the operator rates itself: the self-assessment carries every active question and the participant records it', async () => {
    const path = `${API}/assessments/self/${cycleId}/DOMESTIC`;
    const opened = await adminA.get(path);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body.data).toMatchObject({ stakeholderType: null, questionCount: 23, assessment: { kind: 'SELF', status: 'DRAFT' }, progress: { answered: 0, total: 23 } });
    expect(questionIds).toEqual(formQuestionIds(opened.body.data));

    const saved = await adminA.patch(`${path}/answers`).send({ answers: questionIds.map((questionId, index) => (index === 3 ? { questionId, na: true } : { questionId, rating: 5 })) });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toMatchObject({ answered: 23, total: 23, pct: 100 });
    const done = await adminA.post(`${path}/submit`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data).toMatchObject({ kind: 'SELF', status: 'SUBMITTED' });
    expectError(await adminA.post(`${path}/submit`), 412, 'PRECONDITION_FAILED');

    const strip = await adminA.get(`${API}/cycles/current`);
    expect(strip.body.data[0].participant.selfAssessment).toEqual({ DOMESTIC: 'SUBMITTED', INTERNATIONAL: null });
    expect(strip.body.data[0].participant.stats).toEqual({ invited: 3, started: 3, completed: 3 });
    expect((await adminA.get(`${API}/assessments?cycleId=${cycleId}`)).body.meta.total).toBe(4);
  });

  it('18 · ACFI closes the assessment: the final scoring run happens inside the transition and the cycle is SCORED', async () => {
    const closed = await superAdmin.post(`${API}/cycles/${cycleId}/transition`).send({ to: 'ASSESSMENT_CLOSED', reason: 'Demo: close the window early' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    // The response carries the status this request wrote; the scoring listener then moved the cycle on.
    expect(closed.body.data.status).toBe('ASSESSMENT_CLOSED');
    const after = await superAdmin.get(`${API}/cycles/${cycleId}`);
    expect(after.body.data).toMatchObject({ status: 'SCORED', marketShareFrozen: true });
    expect(after.body.data.scoredAt).not.toBeNull();

    const scores = await getScores(cycleId, acoA, 'DOMESTIC');
    expect(scores).toMatchObject({ surveyId: domesticSurveyId, provisional: false, counts: { customer: 3, self: 1, FF: 2, CB: 1 } });
    const overall = scores.rows.find((row) => row.level === 'OVERALL');
    expect(overall).toMatchObject({ refId: 'OVERALL', customer: { n: 3 }, self: { mean: 5, n: 1 }, rank: 1, rankOf: 1 });
    expect(overall).not.toHaveProperty('suppressed');
    overallMean = overall?.customer.mean ?? null;
    // 23 fives, 23 threes, 21 fours, one Fair and one NA: every question averages 4 except the first (3.33).
    expect(overallMean).toBeGreaterThan(3.9);
    expect(overallMean).toBeLessThan(4);
    expect(scores.rows.filter((row) => row.level === 'QUESTION')).toHaveLength(23);
    expect(scores.rows.filter((row) => row.level === 'CATEGORY').map((row) => row.refId)).toEqual(['INFRA', 'SEC', 'PROC', 'TRADE']);
    expect(scores.rows.find((row) => row.level === 'QUESTION')?.customer).toMatchObject({ mean: 3.33, n: 3, naCount: 0 });

    // The operator that invited nobody has no figures: suppressed, unranked.
    const theirs = await getScores(cycleId, acoB, 'DOMESTIC');
    expect(theirs.rows.find((row) => row.level === 'OVERALL')).toMatchObject({ customer: { mean: null, n: 0 }, suppressed: 'INSUFFICIENT_RESPONSES', rank: null });

    // A manual re-run replaces the rows in place; only ACFI may ask for it.
    const rerun = await superAdmin.post(`${API}/scoring/cycles/${cycleId}/run`).send({});
    expect(rerun.status, JSON.stringify(rerun.body)).toBe(200);
    expect(rerun.body.data).toMatchObject({ cycleId, provisional: false, surveyTypes: ['DOMESTIC'], operators: 2, airports: 2 });
    expect((await getScores(cycleId, acoA, 'DOMESTIC')).rows.find((row) => row.level === 'OVERALL')?.customer.mean).toBe(overallMean);
    expectError(await adminA.post(`${API}/scoring/cycles/${cycleId}/run`).send({}), 403, 'FORBIDDEN');
  });

  it('19 · the operator dashboard: figures, assessment counts, the funnel, its own airport in the national table — and nothing of the other operator', async () => {
    const res = await adminA.get(`${API}/reports/operator/${acoA}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const report = res.body.data;
    expect(report).toMatchObject({
      cycle: { id: cycleId, code: 'CSQ-DEMO-2026', type: 'DOMESTIC', status: 'SCORED' },
      surveyType: 'DOMESTIC',
      provisional: false,
      operator: { id: acoA, code: 'DEL-DECCAN', name: 'Deccan Cargo Handlers', airport: { id: del, iata: 'DEL' } },
      overall: { customer: { mean: overallMean, n: 3 }, self: { mean: 5 }, rank: 1, rankOf: 1 },
      comparison: { current: { cycleId, cycleName: 'CSQ Demo 2026', customer: overallMean, self: 5 }, previous: null },
      // Two forwarders and one broker: each split is under `settings.scoring.minResponses` (3), so its mean stays hidden.
      byStakeholder: { FF: { mean: null, n: 2 }, CB: { mean: null, n: 1 } },
      assessorStats: { total: 3, completed: 3, inProgress: 0, yetToStart: 0 },
      // "4 assessments · 1 self · 3 customer"
      assessments: { total: 4, customer: 3, self: 1 },
      airportsTotal: PHASE_I_IATA.length,
    });
    expect(report.overall).not.toHaveProperty('suppressed');
    expect(report.cycle.scoredAt).not.toBeNull();
    // Every customer answer, counted: 23 fives, 21 fours, 23 threes, one Fair, one NA (SELF never enters the distribution).
    // The percentages are apportioned by largest remainder so they sum to 100.00: 21/69 is 30.4348, floored to
    // 30.43, and it is one of the three buckets that take the leftover hundredths (with the two 1.449 ones).
    expect(report.feedbackDistribution).toEqual([
      { rating: 5, label: 'Excellent', count: 23, pct: 33.33 },
      { rating: 4, label: 'Very Good', count: 21, pct: 30.44 },
      { rating: 3, label: 'Good', count: 23, pct: 33.33 },
      { rating: 2, label: 'Fair', count: 1, pct: 1.45 },
      { rating: 1, label: 'Poor', count: 0, pct: 0 },
      { rating: null, label: 'NA', count: 1, pct: 1.45 },
    ]);
    const categories = report.categories as { code: string; customer: { mean: number | null; n: number }; self: { mean: number | null }; subcategories: unknown[] }[];
    expect(categories.map((category) => category.code)).toEqual(['INFRA', 'SEC', 'PROC', 'TRADE']);
    expect(categories.map((category) => [category.customer.n, category.self.mean, category.subcategories.length])).toEqual([
      [3, 5, 0],
      [3, 5, 0],
      [3, 5, 0],
      [3, 5, 0],
    ]);
    expect(categories[0]!.customer.mean).toBeLessThan(4);
    expect(categories.slice(1).map((category) => category.customer.mean)).toEqual([4, 4, 4]);
    expect(report.nationalTable).toEqual([
      { airportIata: 'DEL', airportName: 'Indira Gandhi International Airport', rating: overallMean, rank: 1, rankOf: 1, isOwn: true },
      { airportIata: 'BOM', airportName: 'Chhatrapati Shivaji Maharaj International Airport', rating: null, rank: null, rankOf: 1, isOwn: false },
    ]);
    expect(JSON.stringify(report)).not.toContain('Harbour');
    expect(JSON.stringify(report)).not.toContain(acoB);

    const questions = await adminA.get(`${API}/reports/operator/${acoA}/questions`);
    expect(questions.status, JSON.stringify(questions.body)).toBe(200);
    const rows = questions.body.data.questions as { id: string; customer: { mean: number | null; n: number; naCount: number }; comments: number }[];
    expect(rows).toHaveLength(23);
    expect(rows.map((row) => row.id)).toEqual(questionIds);
    expect(rows[0]).toMatchObject({ customer: { mean: 3.33, n: 3, naCount: 0 }, comments: 1 });
    // One NA leaves the second question with two respondents, under `settings.scoring.minResponses` (3): its mean is
    // suppressed at the question level too (a publication rule only — the category above still rolled it up as 4).
    expect(rows[1]).toMatchObject({ customer: { mean: null, n: 2, naCount: 1 }, suppressed: 'INSUFFICIENT_RESPONSES', comments: 0 });

    // Confidentiality: the other operator reads neither dashboard nor questions of this one; its own is suppressed.
    expectError(await adminB.get(`${API}/reports/operator/${acoA}`), 404, 'NOT_FOUND');
    expectError(await adminB.get(`${API}/reports/operator/${acoA}/questions`), 404, 'NOT_FOUND');
    expectError(await adminB.get(`${API}/reports/export?scope=operator&acoId=${acoA}`), 404, 'NOT_FOUND');
    const own = await adminB.get(`${API}/reports/operator/${acoB}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data).toMatchObject({
      overall: { customer: { mean: null, n: 0 }, rank: null, suppressed: 'INSUFFICIENT_RESPONSES' },
      assessments: { total: 0, customer: 0, self: 0 },
      assessorStats: { total: 0, completed: 0, inProgress: 0, yetToStart: 0 },
    });
    expect((own.body.data.nationalTable as { airportIata: string; isOwn: boolean }[]).map((row) => [row.airportIata, row.isOwn])).toEqual([
      ['DEL', false],
      ['BOM', true],
    ]);

    const csv = await adminA.get(`${API}/reports/export?scope=operator&acoId=${acoA}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="csq-operator-DEL-DECCAN-CSQ-DEMO-2026-DOMESTIC.csv"');
    expect(csv.text.trim().split('\r\n')).toHaveLength(1 + 1 + 4 + 23);
  });

  it('20 · the airport and national views agree; the audit trail and the notification log tell the whole story in order', async () => {
    const national = await superAdmin.get(`${API}/reports/national`);
    expect(national.status, JSON.stringify(national.body)).toBe(200);
    expect(national.body.data).toMatchObject({
      cycle: { id: cycleId },
      provisional: false,
      participation: { airports: 2, operators: 2, sampleLocked: 1, invited: 3, started: 3, completed: 3, pending: 0, completionRate: 100 },
    });
    expect((national.body.data.airports as { iata: string; rating: number | null; rank: number | null }[]).map((row) => [row.iata, row.rating, row.rank])).toEqual([
      ['DEL', overallMean, 1],
      ['BOM', null, null],
    ]);
    expect((national.body.data.operators as { code: string; rank: number | null }[]).map((row) => [row.code, row.rank])).toEqual([
      ['DEL-DECCAN', 1],
      ['BOM-HARBOUR', null],
    ]);
    const airport = await superAdmin.get(`${API}/reports/airport/${del}`);
    expect(airport.body.data).toMatchObject({
      airport: { iata: 'DEL' },
      overall: { mean: overallMean, coveredSharePct: 100, marketShareApplied: true, rank: 1, rankOf: 1 },
      operators: [{ acoId: acoA, code: 'DEL-DECCAN', mean: overallMean, sharePct: 100, suppressed: false }],
    });
    expectError(await adminA.get(`${API}/reports/national`), 403, 'FORBIDDEN');

    // The audit trail, oldest first: every step left its mark, in the order it happened.
    const audit = await superAdmin.get(`${API}/audit?sort=at&pageSize=200`);
    expect(audit.status, JSON.stringify(audit.body)).toBe(200);
    const entries = audit.body.data as { action: string; actorUserId: string | null; actorEmail: string | null; orgId: string | null }[];
    const actions = entries.map((entry) => entry.action);
    const story = [
      'onboarding.link.created',
      'registration.submitted',
      'registration.approved',
      'operator.created',
      'cycle.created',
      'marketshare.updated',
      'cycle.published',
      'customer.imported',
      'sample.selection.changed',
      'sample.locked',
      'cycle.transitioned',
      'invitation.sent',
      'assessment.submitted',
      'scoring.run',
    ];
    const firstSeen = story.map((action) => actions.indexOf(action));
    expect(firstSeen.every((index) => index >= 0)).toBe(true);
    expect(firstSeen).toEqual([...firstSeen].sort((a, b) => a - b));
    const count = (action: string): number => actions.filter((candidate) => candidate === action).length;
    expect(count('invitation.sent')).toBe(3);
    expect(count('assessment.submitted')).toBe(4);
    expect(count('sample.selection.changed')).toBe(2);
    expect(count('sample.locked')).toBe(1);
    expect(count('cycle.transitioned')).toBe(4);
    expect(count('scoring.run')).toBe(2);
    expect(count('marketshare.updated')).toBeGreaterThanOrEqual(2);
    expect(entries.find((entry) => entry.action === 'registration.submitted')).toMatchObject({ actorUserId: null, actorEmail: null });
    expect(entries.find((entry) => entry.action === 'sample.locked')).toMatchObject({ actorEmail: 'arjun@deccan.test', orgId: acoA });
    expect(entries.filter((entry) => entry.action === 'scoring.run').every((entry) => entry.actorEmail === 'admin@acfi.test')).toBe(true);
    // The operator's own window on it: its sample entries, newest first.
    expect((await adminA.get(`${API}/sampling/cycles/${cycleId}/audit`)).body.data.map((entry: { action: string }) => entry.action)).toEqual([
      'sample.locked',
      'sample.selection.changed',
      'sample.selection.changed',
    ]);

    // The notification log, oldest first: each template appears when the story reaches it.
    const log = await mailLog();
    const templates = log.map((mail) => mail.template);
    expect([...new Set(templates)]).toEqual([
      'registration-received',
      'generic',
      'registration-approved',
      'account-invited',
      'cycle-published',
      'sample-locked',
      'sampling-closed',
      'assessment-invitation',
      'assessment-reminder',
      'assessment-otp',
      'assessment-thank-you',
    ]);
    const sent = (template: string): number => templates.filter((candidate) => candidate === template).length;
    expect([sent('cycle-published'), sent('sample-locked'), sent('sampling-closed'), sent('assessment-invitation'), sent('assessment-reminder'), sent('assessment-otp'), sent('assessment-thank-you')]).toEqual([
      2, 1, 1, 3, 3, 3, 3,
    ]);
    expect(log.every((mail) => mail.status === 'SENT')).toBe(true);
  });
});
