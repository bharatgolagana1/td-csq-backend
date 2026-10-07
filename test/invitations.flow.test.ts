// The participant flow end to end through the real neighbours: customers and
// the sample through their APIs, the cycle clock through cycles' `transition`,
// the public link flow through the API, and the unlock → re-lock → safety-net path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemContext } from '../src/core/auth/system.js';
import { idString } from '../src/core/ids.js';
import { JobModel } from '../src/core/jobs.model.js';
import { AssessmentModel } from '../src/modules/assessments/assessments.model.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { CycleParticipantModel } from '../src/modules/cycles/cycle-participants.model.js';
import { transition } from '../src/modules/cycles/cycles.service.js';
import { InvitationModel, type InvitationDoc } from '../src/modules/invitations/invitations.model.js';
import { activateOpenCycles } from '../src/modules/invitations/invitations.service.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';
import { SampleModel } from '../src/modules/sampling/sampling.model.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { answersFor, createTestCycle, createTestSurvey, formQuestionIds, mailsFor, otpFromMail, tokenFromMail, type TestSurvey } from './invitations.fixtures.js';

const PUBLIC = '/api/v1/public/assess';
const SAMPLING = '/api/v1/sampling/cycles';
const LINK_HEADER = 'x-csq-link-token';

let t: TestApp;
let superAdmin: TestUser;
let adminA: TestUser;
let adminB: TestUser;
let acoA: string;
let acoB: string;
let domestic: TestSurvey;
let cycleId: string;
const customersA: string[] = [];
let customerB: string;

async function createCustomer(as: TestUser, name: string, email: string, type: 'FF' | 'CB' = 'FF'): Promise<string> {
  const res = await as.post('/api/v1/customers').send({ name, contactPerson: `${name} desk`, email, phone: '+91 98765 43210', type, surveyType: 'DOMESTIC' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function participant(acoId: string) {
  const doc = await CycleParticipantModel.findOne({ cycleId, acoId }).lean();
  if (!doc) throw new Error('participant missing');
  return doc;
}

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  adminA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'FLW-A', airportIata: 'DEL', name: 'Asha Rao' });
  adminB = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'FLW-B', airportIata: 'BOM', name: 'Bhavin Shah' });
  acoA = idString(adminA.org._id);
  acoB = idString(adminB.org._id);
  domestic = await createTestSurvey('DOMESTIC');
  cycleId = await createTestCycle({ code: 'FLW-DOM', type: 'DOMESTIC', minSampleSize: 2, status: 'SAMPLING_OPEN', surveyVersions: { DOMESTIC: domestic.id } }, [adminA.org, adminB.org]);
  customersA.push(await createCustomer(adminA, 'Alpha Forwarders', 'ops@alpha.test'));
  customersA.push(await createCustomer(adminA, 'Beta Brokers', 'ops@beta.test', 'CB'));
  customersA.push(await createCustomer(adminA, 'Gamma Cargo', 'ops@gamma.test'));
  customerB = await createCustomer(adminB, 'Bombay Freight', 'ops@bombay.test');
});
afterAll(() => t.close());

describe('sampling lock → PENDING invitations', () => {
  it('locking the sample creates one PENDING invitation per locked sample inside the lock transaction', async () => {
    const select = await adminA.put(`${SAMPLING}/${cycleId}/selection`).send({ add: customersA.map((customerId) => ({ customerId, surveyType: 'DOMESTIC' })) });
    expect(select.status, JSON.stringify(select.body)).toBe(200);
    const lock = await adminA.post(`${SAMPLING}/${cycleId}/lock`).send({});
    expect(lock.status, JSON.stringify(lock.body)).toBe(200);
    expect(lock.body.data.participant.sampling.status).toBe('LOCKED');

    const pending = await InvitationModel.find({ cycleId, acoId: acoA }).lean<InvitationDoc[]>();
    expect(pending).toHaveLength(3);
    expect(pending.every((doc) => doc.state === 'PENDING' && doc.tokenHash === null)).toBe(true);
    expect(pending.map((doc) => doc.email).sort()).toEqual(['ops@alpha.test', 'ops@beta.test', 'ops@gamma.test']);
    expect(await SampleModel.countDocuments({ cycleId, acoId: acoA, state: 'LOCKED' })).toBe(3);
    expect(await NotificationModel.countDocuments({ template: 'assessment-invitation' })).toBe(0);
  });

  it('ACFI unlocking revokes the PENDING invitations; re-locking creates fresh ones', async () => {
    // B has a single eligible customer: below the minimum, but everything eligible is selected (SELECT_ALL rule).
    await adminB.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [{ customerId: customerB, surveyType: 'DOMESTIC' }] });
    const lock = await adminB.post(`${SAMPLING}/${cycleId}/lock`).send({});
    expect(lock.status, JSON.stringify(lock.body)).toBe(200);
    expect(await InvitationModel.countDocuments({ cycleId, acoId: acoB, state: 'PENDING' })).toBe(1);

    const unlock = await superAdmin.post(`${SAMPLING}/${cycleId}/unlock`).send({ acoId: acoB, reason: 'Operator asked to change the sample' });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);
    expect(await InvitationModel.countDocuments({ cycleId, acoId: acoB, state: 'PENDING' })).toBe(0);
    expect(await InvitationModel.countDocuments({ cycleId, acoId: acoB, state: 'REVOKED' })).toBe(1);
    expect(await AuditModel.countDocuments({ action: 'invitation.revoked' })).toBe(1);

    const relock = await adminB.post(`${SAMPLING}/${cycleId}/lock`).send({});
    expect(relock.status, JSON.stringify(relock.body)).toBe(200);
    expect(await InvitationModel.countDocuments({ cycleId, acoId: acoB, state: 'PENDING' })).toBe(1);
  });
});

describe('cycle clock → ASSESSMENT_OPEN activates the invitations', () => {
  it('sends tokens and e-mails to every PENDING invitation of locked participants and counts them as invited', async () => {
    const clock = systemContext('test: cycle clock');
    await transition(clock, cycleId, 'SAMPLING_CLOSED', 'sampling ended', { trigger: 'CLOCK' });
    expect(await NotificationModel.countDocuments({ template: 'assessment-invitation' })).toBe(0);
    await transition(clock, cycleId, 'ASSESSMENT_OPEN', 'assessment starts', { trigger: 'CLOCK' });

    const sent = await InvitationModel.find({ cycleId, state: 'SENT' }).lean<InvitationDoc[]>();
    expect(sent).toHaveLength(4);
    expect(await NotificationModel.countDocuments({ template: 'assessment-invitation' })).toBe(4);
    expect((await participant(acoA)).stats).toEqual({ invited: 3, started: 0, completed: 0 });
    expect((await participant(acoB)).stats).toEqual({ invited: 1, started: 0, completed: 0 });
    expect(await AuditModel.countDocuments({ action: 'invitation.sent' })).toBe(4);
    expect(await activateOpenCycles(new Date())).toEqual({ sent: 0, skipped: 0 });
  });
});

describe('the participant completes the assessment through the link', () => {
  let invitation: InvitationDoc;
  let token: string;
  let session: string;

  beforeAll(async () => {
    invitation = (await InvitationModel.findOne({ cycleId, email: 'ops@beta.test' }).lean<InvitationDoc>())!;
    token = await tokenFromMail(idString(invitation._id));
  });

  it('opens the link, requests a code, verifies it and receives a session', async () => {
    const status = await t.anon.get(`${PUBLIC}/${token}`);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body.data).toMatchObject({ state: 'OPENED', surveyType: 'DOMESTIC', operator: { name: 'FLW-A Cargo', airport: { iata: 'DEL' } } });

    const otp = await t.anon.post(`${PUBLIC}/${token}/otp`);
    expect(otp.status, JSON.stringify(otp.body)).toBe(200);
    const code = await otpFromMail(idString(invitation._id));
    const verify = await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp: code });
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    session = verify.body.data.sessionToken;
    expect((await participant(acoA)).stats.started).toBe(1);
    expect(await AssessmentModel.countDocuments({ invitationId: invitation._id, kind: 'CUSTOMER', customerType: 'CB' })).toBe(1);
  });

  it('answers the form in two autosaves and submits', async () => {
    const form = await t.anon.get(`${PUBLIC}/${token}/form`).set(LINK_HEADER, session);
    expect(form.status, JSON.stringify(form.body)).toBe(200);
    const questionIds = formQuestionIds(form.body.data);
    expect(questionIds).toHaveLength(3);

    const batch1 = await t.anon.patch(`${PUBLIC}/${token}/answers`).set(LINK_HEADER, session).send({ answers: answersFor(questionIds.slice(0, 2), 5) });
    expect(batch1.body.data).toMatchObject({ answered: 2, total: 3 });
    const batch2 = await t.anon.patch(`${PUBLIC}/${token}/answers`).set(LINK_HEADER, session).send({ answers: answersFor(questionIds.slice(2), 3) });
    expect(batch2.body.data).toMatchObject({ answered: 3, total: 3, pct: 100 });
    expect((await t.anon.get(`${PUBLIC}/${token}/readiness`).set(LINK_HEADER, session)).body.data.complete).toBe(true);

    const submit = await t.anon.post(`${PUBLIC}/${token}/submit`).set(LINK_HEADER, session);
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    expect(submit.body.data).toMatchObject({ state: 'SUBMITTED', assessment: { status: 'SUBMITTED', progress: { answered: 3, total: 3 } } });

    const doc = await InvitationModel.findById(invitation._id).lean();
    expect(doc?.state).toBe('SUBMITTED');
    expect((await participant(acoA)).stats).toEqual({ invited: 3, started: 1, completed: 1 });
    expect(await mailsFor(idString(invitation._id), 'assessment-thank-you')).toHaveLength(1);
    expect(await AuditModel.countDocuments({ action: 'assessment.submitted' })).toBe(1);
    expect((await t.anon.get(`${PUBLIC}/${token}`)).body.data.state).toBe('SUBMITTED');
  });

  it('the submitted assessment is visible to the operator in the assessments history, masked', async () => {
    const res = await adminA.get(`/api/v1/assessments?cycleId=${cycleId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({ kind: 'CUSTOMER', customerType: 'CB', status: 'SUBMITTED' });
  });
});

describe('a sample locked after the assessment opened', () => {
  it('is activated by the invitations.activate safety net on the next tick', async () => {
    const unlock = await superAdmin.post(`${SAMPLING}/${cycleId}/unlock`).send({ acoId: acoB, reason: 'Add one more participant' });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);
    // The SENT invitation keeps working; nothing was PENDING for B any more.
    expect(await InvitationModel.countDocuments({ cycleId, acoId: acoB, state: 'SENT' })).toBe(1);
    const extra = await createCustomer(adminB, 'Bombay Brokers', 'ops@bombaybrokers.test', 'CB');
    await adminB.put(`${SAMPLING}/${cycleId}/selection`).send({ add: [{ customerId: extra, surveyType: 'DOMESTIC' }] });
    const relock = await adminB.post(`${SAMPLING}/${cycleId}/lock`).send({});
    expect(relock.status, JSON.stringify(relock.body)).toBe(200);
    expect(await InvitationModel.countDocuments({ cycleId, acoId: acoB, state: 'PENDING' })).toBe(1);

    expect(await activateOpenCycles(new Date())).toEqual({ sent: 1, skipped: 0 });
    const extraInvitation = (await InvitationModel.findOne({ cycleId, email: 'ops@bombaybrokers.test' }).lean<InvitationDoc>())!;
    expect(extraInvitation.state).toBe('SENT');
    expect(await mailsFor(idString(extraInvitation._id), 'assessment-invitation')).toHaveLength(1);
    expect((await participant(acoB)).stats.invited).toBe(2);
    expect(await JobModel.countDocuments({ type: 'invitation.send', status: 'DONE' })).toBe(5);
    expect(await activateOpenCycles(new Date())).toEqual({ sent: 0, skipped: 0 });
  });
});
