import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { systemContext } from '../src/core/auth/system.js';
import { AppError } from '../src/core/errors.js';
import { emit } from '../src/core/events.js';
import { idString, newId } from '../src/core/ids.js';
import { JobModel } from '../src/core/jobs.model.js';
import { AssessmentModel } from '../src/modules/assessments/assessments.model.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { CycleParticipantModel } from '../src/modules/cycles/cycle-participants.model.js';
import { CycleModel } from '../src/modules/cycles/cycles.model.js';
import { hashToken } from '../src/modules/invitations/domain/token.js';
import { configureInvitations, invitationsConfig } from '../src/modules/invitations/invitations.config.js';
import { InvitationModel, type InvitationDoc } from '../src/modules/invitations/invitations.model.js';
import {
  activateCycle,
  activateOpenCycles,
  createPendingForSamples,
  expireDue,
  getByToken,
  sendDueReminders,
  sendReminders,
} from '../src/modules/invitations/invitations.service.js';
import { otpIpLimiter } from '../src/modules/invitations/otp-limiter.js';
import { requestOtp, verifyOtp } from '../src/modules/invitations/participant.service.js';
import { NotificationModel } from '../src/modules/notifications/notifications.model.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, expectError, grantTasks, revokeTasks } from './helpers/fixtures.js';
import {
  createTestCustomer,
  createTestCycle,
  createTestSurvey,
  DAY,
  formQuestionIds,
  mailsFor,
  MINUTE,
  otpFromMail,
  sampleOf,
  tokenFromMail,
  type TestSurvey,
} from './invitations.fixtures.js';

const PUBLIC = '/api/v1/public/assess';
const LINK_HEADER = 'x-csq-link-token';

let t: TestApp;
let superAdmin: TestUser;
let adminA: TestUser;
let userA: TestUser;
let adminB: TestUser;
let acoA: string;
let acoB: string;
let del: string;
let bom: string;
let domestic: TestSurvey;
let international: TestSurvey;
let cycleId: string;
let cBoth: string;
let cDom: string;
let cB: string;

async function invitationsOf(acoId: string, filter: Record<string, unknown> = {}): Promise<InvitationDoc[]> {
  return InvitationModel.find({ cycleId, acoId, ...filter })
    .sort({ _id: 1 })
    .lean<InvitationDoc[]>();
}

async function lockParticipant(acoId: string): Promise<void> {
  await CycleParticipantModel.updateOne({ cycleId, acoId }, { $set: { 'sampling.status': 'LOCKED', 'sampling.lockedAt': new Date() } });
}

async function participantStats(acoId: string): Promise<{ invited: number; started: number; completed: number }> {
  const doc = await CycleParticipantModel.findOne({ cycleId, acoId }).lean();
  if (!doc) throw new Error('participant missing');
  return doc.stats;
}

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  adminA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'INV-A', airportIata: 'DEL', name: 'Asha Rao' });
  userA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_USER', orgCode: 'INV-A', airportIata: 'DEL' });
  adminB = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'INV-B', airportIata: 'BOM' });
  acoA = idString(adminA.org._id);
  acoB = idString(adminB.org._id);
  del = await airportIdByIata('DEL');
  bom = await airportIdByIata('BOM');
  domestic = await createTestSurvey('DOMESTIC');
  international = await createTestSurvey('INTERNATIONAL');
  // The assessment opened three days ago: the first assessment reminder (start + 2 days, 09:00 IST) is due, the second is not.
  cycleId = await createTestCycle(
    {
      code: 'INV-BOTH',
      type: 'BOTH',
      minSampleSize: 2,
      status: 'ASSESSMENT_OPEN',
      samplingStart: new Date(Date.now() - 13 * DAY),
      samplingEnd: new Date(Date.now() - 3 * DAY),
      assessmentStart: new Date(Date.now() - 3 * DAY),
      assessmentEnd: new Date(Date.now() + 27 * DAY),
      surveyVersions: { DOMESTIC: domestic.id, INTERNATIONAL: international.id },
    },
    [adminA.org, adminB.org],
  );
  cBoth = await createTestCustomer({ acoId: acoA, airportId: del, name: 'Both Ways Logistics', contactPerson: 'Meera Nair', email: 'meera@bothways.test', type: 'FF' });
  cDom = await createTestCustomer({ acoId: acoA, airportId: del, name: 'Domestic Brokers', contactPerson: 'Imran Shaikh', email: 'imran@dombrokers.test', type: 'CB', surveyType: 'DOMESTIC' });
  cB = await createTestCustomer({ acoId: acoB, airportId: bom, name: 'Bombay Freight', contactPerson: 'Dev Patel', email: 'dev@bombayfreight.test', type: 'FF' });
});
afterAll(() => t.close());
beforeEach(() => {
  otpIpLimiter.reset();
});

describe('sample.locked → PENDING invitations', () => {
  it('creates one PENDING invitation per locked sample with the customer snapshot and the cycle assessment end', async () => {
    const result = await createPendingForSamples({
      cycleId,
      acoId: acoA,
      samples: [sampleOf(cBoth, 'DOMESTIC'), sampleOf(cBoth, 'INTERNATIONAL'), sampleOf(cDom, 'DOMESTIC')],
    });
    expect(result).toEqual({ created: 3, existing: 0 });
    const docs = await invitationsOf(acoA);
    expect(docs).toHaveLength(3);
    for (const doc of docs) {
      expect(doc.state).toBe('PENDING');
      expect(doc.tokenHash).toBeNull();
      expect(idString(doc.airportId!)).toBe(del);
      expect(doc.otp).toMatchObject({ hash: null, expiresAt: null, attempts: 0, sentAts: [] });
    }
    const cycle = await CycleModel.findById(cycleId).lean();
    expect(docs[0]!.expiresAt.getTime()).toBe(cycle!.assessment.end.utc.getTime());
    const both = docs.find((doc) => idString(doc.customerId) === cBoth && doc.surveyType === 'INTERNATIONAL');
    expect(both).toMatchObject({ email: 'meera@bothways.test', customer: { name: 'Both Ways Logistics', contactPerson: 'Meera Nair', type: 'FF' } });
  });

  it('is idempotent on cycle + aco + customer + surveyType', async () => {
    const again = await createPendingForSamples({ cycleId, acoId: acoA, samples: [sampleOf(cBoth, 'DOMESTIC'), sampleOf(cDom, 'DOMESTIC')] });
    expect(again).toEqual({ created: 0, existing: 2 });
    expect(await invitationsOf(acoA)).toHaveLength(3);
  });

  it('runs from the event listener registered by the module', async () => {
    await emit('sample.locked', { cycleId, acoId: acoB, samples: [sampleOf(cB, 'DOMESTIC')] }, { ctx: systemContext('test: lock B') });
    const docs = await invitationsOf(acoB);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.state).toBe('PENDING');
    expect(idString(docs[0]!.airportId!)).toBe(bom);
  });

  it('refuses a sample whose customer is not the operator’s (the lock rolls back)', async () => {
    await expect(createPendingForSamples({ cycleId, acoId: acoB, samples: [sampleOf(cBoth, 'DOMESTIC')] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await invitationsOf(acoB)).toHaveLength(1);
  });
});

describe('sample.unlocked → PENDING invitations revoked', () => {
  it('revokes PENDING invitations of the participant, audited, and a re-lock creates fresh ones', async () => {
    await emit('sample.unlocked', { cycleId, acoId: acoB, reason: 'Wrong customers selected' }, { ctx: systemContext('test: unlock B') });
    const revoked = await invitationsOf(acoB);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.state).toBe('REVOKED');
    expect(revoked[0]!.revokedAt).toBeInstanceOf(Date);
    const audit = await AuditModel.findOne({ action: 'invitation.revoked', entityId: idString(revoked[0]!._id) }).lean();
    expect(audit?.after).toMatchObject({ state: 'REVOKED', reason: 'Wrong customers selected' });
    expect(idString(audit!.orgId!)).toBe(acoB);

    const relock = await createPendingForSamples({ cycleId, acoId: acoB, samples: [sampleOf(cB, 'DOMESTIC')] });
    expect(relock).toEqual({ created: 1, existing: 0 });
    const states = (await invitationsOf(acoB)).map((doc) => doc.state).sort();
    expect(states).toEqual(['PENDING', 'REVOKED']);
  });
});

describe('activateCycle', () => {
  it('gives every PENDING invitation of a LOCKED participant a token, sends the e-mail, audits and announces invitation.sent', async () => {
    await lockParticipant(acoA);
    const result = await activateCycle(cycleId);
    expect(result).toEqual({ sent: 3, skipped: 1 });

    const docs = await invitationsOf(acoA);
    for (const doc of docs) {
      expect(doc.state).toBe('SENT');
      expect(doc.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(doc.sentAt).toBeInstanceOf(Date);
      const mails = await mailsFor(idString(doc._id), 'assessment-invitation');
      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe(doc.email);
      expect(mails[0]!.status).toBe('SENT');
      expect(mails[0]!.body).toContain('http://localhost:5173/assess/');
      expect(mails[0]!.body).toContain('INV-A Cargo');
      const token = await tokenFromMail(idString(doc._id));
      expect(hashToken(token)).toBe(doc.tokenHash);
      const audit = await AuditModel.findOne({ action: 'invitation.sent', entityId: idString(doc._id) }).lean();
      expect(audit?.after).toMatchObject({ state: 'SENT' });
    }
    expect((await participantStats(acoA)).invited).toBe(3);
    expect((await invitationsOf(acoB, { state: 'PENDING' })).length).toBe(1);
  });

  it('is idempotent: a second run sends nothing and the safety net picks up a participant locked later', async () => {
    expect(await activateCycle(cycleId)).toEqual({ sent: 0, skipped: 1 });
    expect(await NotificationModel.countDocuments({ template: 'assessment-invitation' })).toBe(3);

    await lockParticipant(acoB);
    expect(await activateOpenCycles(new Date())).toEqual({ sent: 1, skipped: 0 });
    expect(await NotificationModel.countDocuments({ template: 'assessment-invitation' })).toBe(4);
    expect((await participantStats(acoB)).invited).toBe(1);
    expect(await JobModel.countDocuments({ type: 'invitation.send', status: 'DONE' })).toBe(4);
  });
});

describe('GET /public/assess/:token', () => {
  let invitation: InvitationDoc;
  let token: string;

  beforeAll(async () => {
    invitation = (await invitationsOf(acoA, { customerId: cBoth, surveyType: 'DOMESTIC' }))[0]!;
    token = await tokenFromMail(idString(invitation._id));
  });

  it('is 404 for an unknown or malformed token', async () => {
    expectError(await t.anon.get(`${PUBLIC}/${'x'.repeat(43)}`), 404, 'NOT_FOUND');
    expectError(await t.anon.get(`${PUBLIC}/not-a-token`), 404, 'NOT_FOUND');
  });

  it('returns the page facts with the participant masked and moves SENT → OPENED once', async () => {
    const res = await t.anon.get(`${PUBLIC}/${token}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      state: 'OPENED',
      // `tz` lets the page render `assessmentEnd` in the cycle's zone; `type` is the stakeholder type the form will take.
      cycle: { id: cycleId, name: 'Cycle INV-BOTH', tz: 'Asia/Kolkata' },
      operator: { name: 'INV-A Cargo', airport: { iata: 'DEL' } },
      surveyType: 'DOMESTIC',
      customer: { nameMasked: 'B*** W*** L***', emailMasked: 'm****a@bothways.test', type: 'FF' },
      submittedAt: null,
    });
    expect(new Date(res.body.data.cycle.assessmentEnd).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.data).not.toHaveProperty('email');
    const doc = await InvitationModel.findById(invitation._id).lean();
    expect(doc?.state).toBe('OPENED');
    expect(doc?.openedAt).toBeInstanceOf(Date);
    const again = await t.anon.get(`${PUBLIC}/${token}`);
    expect(again.body.data.state).toBe('OPENED');
    expect((await InvitationModel.findById(invitation._id).lean())?.openedAt?.getTime()).toBe(doc?.openedAt?.getTime());
  });
});

describe('POST /public/assess/:token/otp and /verify', () => {
  let invitation: InvitationDoc;
  let token: string;
  let sessionToken: string;

  beforeAll(async () => {
    invitation = (await invitationsOf(acoA, { customerId: cBoth, surveyType: 'DOMESTIC' }))[0]!;
    token = await tokenFromMail(idString(invitation._id));
  });

  it('e-mails a hashed six-digit code valid ten minutes, without devOtp', async () => {
    const res = await t.anon.post(`${PUBLIC}/${token}/otp`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.sent).toBe(true);
    expect(res.body.data).not.toHaveProperty('devOtp');
    const expiresAt = new Date(res.body.data.expiresAt).getTime();
    expect(expiresAt - Date.now()).toBeGreaterThan(9 * MINUTE);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(10 * MINUTE);

    const otp = await otpFromMail(idString(invitation._id));
    expect(otp).toMatch(/^\d{6}$/);
    const mail = (await mailsFor(idString(invitation._id), 'assessment-otp'))[0]!;
    expect(mail.to).toBe('meera@bothways.test');
    expect(mail.subject).toContain(otp);
    const doc = await InvitationModel.findById(invitation._id).lean();
    expect(doc?.otp.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc?.otp.hash).not.toContain(otp);
    expect(doc?.otp.attempts).toBe(0);
    expect(doc?.otp.sentAts).toHaveLength(1);
  });

  it('refuses a second code inside the 30 s cooldown and a fourth inside ten minutes', async () => {
    const res = await t.anon.post(`${PUBLIC}/${token}/otp`);
    const error = expectError(res, 429, 'RATE_LIMITED');
    expect(error.details).toMatchObject({ reason: 'COOLDOWN' });

    const first = (await InvitationModel.findById(invitation._id).lean())!.otp.sentAts[0]!;
    await requestOtp(token, { now: new Date(first.getTime() + 31_000) });
    await requestOtp(token, { now: new Date(first.getTime() + 62_000) });
    await expect(requestOtp(token, { now: new Date(first.getTime() + 93_000) })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { reason: 'RATE_LIMITED' },
    });
    expect(await mailsFor(idString(invitation._id), 'assessment-otp')).toHaveLength(3);
  });

  it('reveals the code in the response only when DEMO_REVEAL_OTP is on', async () => {
    const first = (await InvitationModel.findById(invitation._id).lean())!.otp.sentAts[0]!;
    configureInvitations({ ...invitationsConfig(), revealOtp: true });
    try {
      const result = await requestOtp(token, { now: new Date(first.getTime() + 11 * MINUTE) });
      expect(result.devOtp).toBe(await otpFromMail(idString(invitation._id)));
    } finally {
      configureInvitations(null);
    }
  });

  it('locks the code after five wrong guesses until a new one is requested', async () => {
    const otp = await otpFromMail(idString(invitation._id));
    const wrong = otp === '000000' ? '111111' : '000000';
    for (const attemptsLeft of [4, 3, 2, 1]) {
      const res = await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp: wrong });
      const error = expectError(res, 400, 'OTP_INVALID');
      expect(error.details).toMatchObject({ reason: 'MISMATCH', attemptsLeft });
    }
    const fifth = expectError(await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp: wrong }), 400, 'OTP_INVALID');
    expect(fifth.details).toMatchObject({ reason: 'LOCKED', attemptsLeft: 0 });
    const right = expectError(await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp }), 400, 'OTP_INVALID');
    expect(right.details).toMatchObject({ reason: 'LOCKED' });
    expect((await InvitationModel.findById(invitation._id).lean())?.state).toBe('OPENED');
  });

  it('validates the body', async () => {
    expectError(await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp: '12' }), 400, 'VALIDATION');
    expectError(await t.anon.post(`${PUBLIC}/${token}/verify`).send({}), 400, 'VALIDATION');
  });

  it('a new code resets the attempts; an expired code is refused', async () => {
    const last = (await InvitationModel.findById(invitation._id).lean())!.otp.sentAts.at(-1)!;
    const issuedAt = new Date(last.getTime() + 11 * MINUTE);
    await requestOtp(token, { now: issuedAt });
    const otp = await otpFromMail(idString(invitation._id));
    expect((await InvitationModel.findById(invitation._id).lean())?.otp.attempts).toBe(0);
    await expect(verifyOtp(token, otp, new Date(issuedAt.getTime() + 10 * MINUTE))).rejects.toMatchObject({ code: 'OTP_INVALID', details: { reason: 'EXPIRED' } });
  });

  it('a correct code verifies the invitation, creates the assessment, counts the participant as started and signs a 12 h session', async () => {
    const otp = await otpFromMail(idString(invitation._id));
    const res = await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    sessionToken = res.body.data.sessionToken;
    expect(sessionToken.split('.')).toHaveLength(3);
    expect(new Date(res.body.data.expiresAt).getTime() - Date.now()).toBeGreaterThan(11.9 * 60 * MINUTE);

    const doc = await InvitationModel.findById(invitation._id).lean();
    expect(doc?.state).toBe('VERIFIED');
    expect(doc?.verifiedAt).toBeInstanceOf(Date);
    expect(doc?.otp.hash).toBeNull();
    expect(doc?.assessmentId).not.toBeNull();
    expect(idString(doc!.assessmentId!)).toBe(res.body.data.assessmentId);
    const assessment = await AssessmentModel.findById(doc!.assessmentId).lean();
    expect(assessment).toMatchObject({ kind: 'CUSTOMER', status: 'DRAFT', surveyType: 'DOMESTIC', customerType: 'FF' });
    expect(idString(assessment!.invitationId!)).toBe(idString(invitation._id));
    expect((await participantStats(acoA)).started).toBe(1);

    const session = await invitationsConfig().links.verify(sessionToken, 'participant');
    expect(session.subject).toBe(idString(invitation._id));
    expect(session.claims).toMatchObject({ inv: idString(invitation._id), asg: res.body.data.assessmentId, aco: acoA });
  });

  it('a consumed code cannot be used again; re-verifying later keeps the same assessment and does not count started twice', async () => {
    const consumed = expectError(await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp: '123456' }), 400, 'OTP_INVALID');
    expect(consumed.details).toMatchObject({ reason: 'NO_OTP' });

    const last = (await InvitationModel.findById(invitation._id).lean())!.otp.sentAts.at(-1)!;
    await requestOtp(token, { now: new Date(last.getTime() + 11 * MINUTE) });
    const again = await verifyOtp(token, await otpFromMail(idString(invitation._id)));
    expect(again.assessmentId).toBe(idString((await InvitationModel.findById(invitation._id).lean())!.assessmentId!));
    expect((await participantStats(acoA)).started).toBe(1);
    expect(await AssessmentModel.countDocuments({ invitationId: invitation._id })).toBe(1);
  });

  describe('with the link session', () => {
    const withSession = (path: string) => ({
      get: () => t.anon.get(`${PUBLIC}/${token}${path}`).set(LINK_HEADER, sessionToken),
      patch: () => t.anon.patch(`${PUBLIC}/${token}${path}`).set(LINK_HEADER, sessionToken),
      post: () => t.anon.post(`${PUBLIC}/${token}${path}`).set(LINK_HEADER, sessionToken),
    });

    it('requires a valid participant session', async () => {
      expectError(await t.anon.get(`${PUBLIC}/${token}/form`), 401, 'UNAUTHENTICATED');
      expectError(await t.anon.get(`${PUBLIC}/${token}/form`).set(LINK_HEADER, 'garbage'), 401, 'UNAUTHENTICATED');
      const other = await invitationsConfig().links.sign({ audience: 'registration', subject: 'x', ttlSeconds: 60 });
      expectError(await t.anon.get(`${PUBLIC}/${token}/form`).set(LINK_HEADER, other), 401, 'UNAUTHENTICATED');
    });

    it('refuses the session against another invitation’s token (404) and a session that names another assessment', async () => {
      const sibling = (await invitationsOf(acoA, { customerId: cDom }))[0]!;
      const siblingToken = await tokenFromMail(idString(sibling._id));
      expectError(await t.anon.get(`${PUBLIC}/${siblingToken}/form`).set(LINK_HEADER, sessionToken), 404, 'NOT_FOUND');
      const forged = await invitationsConfig().links.sign({
        audience: 'participant',
        subject: idString(invitation._id),
        claims: { inv: idString(invitation._id), asg: idString(newId()), aco: acoA },
        ttlSeconds: 60,
      });
      expectError(await t.anon.get(`${PUBLIC}/${token}/form`).set(LINK_HEADER, forged), 401, 'UNAUTHENTICATED');
    });

    it('serves the form for the customer’s stakeholder type and an empty draft', async () => {
      const form = await withSession('/form').get();
      expect(form.status, JSON.stringify(form.body)).toBe(200);
      expect(form.body.data.survey).toMatchObject({ code: 'DOMESTIC', version: 1 });
      expect(form.body.data.assessment).toMatchObject({ kind: 'CUSTOMER', status: 'DRAFT', customerType: 'FF' });
      expect(formQuestionIds(form.body.data).sort()).toEqual([...domestic.questionIds].sort());
      expect(form.body.data.progress).toEqual({ answered: 0, total: 3, pct: 0 });

      const draft = await withSession('/draft').get();
      expect(draft.status).toBe(200);
      expect(draft.body.data).toMatchObject({ status: 'DRAFT', answers: [], progress: { answered: 0, total: 3 } });
    });

    it('autosaves by merge, reports readiness and refuses to submit while questions are missing', async () => {
      const [q1, q2, q3] = domestic.questionIds as [string, string, string];
      const partial = await withSession('/answers').patch().send({ answers: [{ questionId: q1, rating: 5 }, { questionId: q2, na: true }] });
      expect(partial.status, JSON.stringify(partial.body)).toBe(200);
      expect(partial.body.data).toMatchObject({ answered: 2, total: 3 });

      const readiness = await withSession('/readiness').get();
      expect(readiness.body.data).toEqual({ answered: 2, total: 3, missing: [q3], complete: false });
      expectError(await withSession('/submit').post(), 412, 'PRECONDITION_FAILED');
      expectError(await withSession('/answers').patch().send({ answers: [{ questionId: 'nope', rating: 3 }] }), 400, 'VALIDATION');

      const rest = await withSession('/answers').patch().send({ answers: [{ questionId: q3, rating: 2, comment: 'Slow at the gate' }] });
      expect(rest.body.data).toMatchObject({ answered: 3, total: 3, pct: 100 });
      const draft = await withSession('/draft').get();
      expect(draft.body.data.answers).toHaveLength(3);
      expect((await withSession('/readiness').get()).body.data.complete).toBe(true);
    });

    it('submits: assessment and invitation SUBMITTED, participant completed, thank-you e-mail, answers read-only', async () => {
      const res = await withSession('/submit').post();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ state: 'SUBMITTED', assessment: { status: 'SUBMITTED' } });
      expect(res.body.data.submittedAt).toBeTruthy();

      const doc = await InvitationModel.findById(invitation._id).lean();
      expect(doc?.state).toBe('SUBMITTED');
      expect(doc?.submittedAt).toBeInstanceOf(Date);
      const thanks = await mailsFor(idString(invitation._id), 'assessment-thank-you');
      expect(thanks).toHaveLength(1);
      expect(thanks[0]!.to).toBe('meera@bothways.test');
      expect(thanks[0]!.body).toContain('INV-A Cargo');
      expect((await participantStats(acoA)).completed).toBe(1);

      expectError(await withSession('/submit').post(), 412, 'PRECONDITION_FAILED');
      expectError(await withSession('/answers').patch().send({ answers: [{ questionId: domestic.questionIds[0], rating: 1 }] }), 412, 'PRECONDITION_FAILED');
      expect((await withSession('/draft').get()).body.data.status).toBe('SUBMITTED');
      const status = await t.anon.get(`${PUBLIC}/${token}`);
      expect(status.body.data.state).toBe('SUBMITTED');
      expect(status.body.data.submittedAt).toBeTruthy();
      expectError(await t.anon.post(`${PUBLIC}/${token}/otp`), 412, 'PRECONDITION_FAILED');
    });
  });
});

describe('signed-in: GET /invitations, resend, revoke', () => {
  beforeAll(async () => {
    await grantTasks('ACO_ADMIN', ['cycles.view', 'notifications.send']);
  });

  it('lists the operator’s own invitations with masked identity; PLATFORM sees every operator', async () => {
    const mine = await adminA.get('/api/v1/invitations');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.meta.total).toBe(3);
    for (const row of mine.body.data) {
      expect(row.acoId).toBe(acoA);
      expect(row.emailMasked).toMatch(/^.\*{4}.@/);
      expect(row).not.toHaveProperty('email');
      expect(row).not.toHaveProperty('tokenHash');
      expect(row.customer.nameMasked).toMatch(/\*\*\*/);
    }
    const all = await superAdmin.get(`/api/v1/invitations?cycleId=${cycleId}`);
    expect(all.body.meta.total).toBe(5);
    const submitted = await superAdmin.get(`/api/v1/invitations?state=SUBMITTED`);
    expect(submitted.body.data.map((row: { customerId: string }) => row.customerId)).toEqual([cBoth]);
    const theirs = await superAdmin.get(`/api/v1/invitations?acoId=${acoB}`);
    expect(theirs.body.data.every((row: { acoId: string }) => row.acoId === acoB)).toBe(true);
    expectError(await superAdmin.get('/api/v1/invitations?sort=tokenHash'), 400, 'VALIDATION');
  });

  it('needs cycles.view (a role without it is 403, not an empty list)', async () => {
    await revokeTasks('ACO_USER', ['cycles.view']);
    expectError(await userA.get('/api/v1/invitations'), 403, 'FORBIDDEN');
  });

  it('resends with a new token: the old link dies, the OTP resets, the e-mail goes again and it is audited', async () => {
    const invitation = (await invitationsOf(acoA, { customerId: cDom }))[0]!;
    const oldToken = await tokenFromMail(idString(invitation._id));
    await t.anon.get(`${PUBLIC}/${oldToken}`);
    await t.anon.post(`${PUBLIC}/${oldToken}/otp`);

    const res = await superAdmin.post(`/api/v1/invitations/${idString(invitation._id)}/resend`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.state).toBe('SENT');
    const doc = await InvitationModel.findById(invitation._id).lean();
    expect(doc?.tokenHash).not.toBe(invitation.tokenHash);
    expect(doc?.otp.hash).toBeNull();
    expectError(await t.anon.get(`${PUBLIC}/${oldToken}`), 404, 'NOT_FOUND');
    const newToken = await tokenFromMail(idString(invitation._id));
    expect(newToken).not.toBe(oldToken);
    expect((await t.anon.get(`${PUBLIC}/${newToken}`)).body.data.state).toBe('OPENED');
    expect(await mailsFor(idString(invitation._id), 'assessment-invitation')).toHaveLength(2);
    const audit = await AuditModel.findOne({ action: 'invitation.resent', entityId: idString(invitation._id) }).lean();
    expect(audit?.actorEmail).toBe(superAdmin.user.email);
    expect((await participantStats(acoA)).invited).toBe(3);
  });

  it('refuses to resend a submitted invitation, another operator’s invitation, or outside the assessment window', async () => {
    const submitted = (await invitationsOf(acoA, { state: 'SUBMITTED' }))[0]!;
    expectError(await superAdmin.post(`/api/v1/invitations/${idString(submitted._id)}/resend`), 412, 'PRECONDITION_FAILED');
    const theirs = (await invitationsOf(acoB, { state: 'SENT' }))[0]!;
    expectError(await adminA.post(`/api/v1/invitations/${idString(theirs._id)}/resend`), 404, 'NOT_FOUND');
    expectError(await superAdmin.post(`/api/v1/invitations/${idString(newId())}/resend`), 404, 'NOT_FOUND');

    await CycleModel.updateOne({ _id: cycleId }, { $set: { status: 'ASSESSMENT_CLOSED' } });
    try {
      expectError(await superAdmin.post(`/api/v1/invitations/${idString(theirs._id)}/resend`), 412, 'PRECONDITION_FAILED');
    } finally {
      await CycleModel.updateOne({ _id: cycleId }, { $set: { status: 'ASSESSMENT_OPEN' } });
    }
  });

  it('revokes: the link reports REVOKED, codes are refused, it is audited; cross-tenant is 404; terminal states are 412', async () => {
    const invitation = (await invitationsOf(acoA, { customerId: cBoth, surveyType: 'INTERNATIONAL' }))[0]!;
    const token = await tokenFromMail(idString(invitation._id));
    expectError(await adminB.post(`/api/v1/invitations/${idString(invitation._id)}/revoke`), 404, 'NOT_FOUND');

    const res = await adminA.post(`/api/v1/invitations/${idString(invitation._id)}/revoke`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.state).toBe('REVOKED');
    expect(res.body.data.revokedAt).toBeTruthy();
    expect((await t.anon.get(`${PUBLIC}/${token}`)).body.data.state).toBe('REVOKED');
    expectError(await t.anon.post(`${PUBLIC}/${token}/otp`), 410, 'LINK_EXPIRED');
    expectError(await t.anon.post(`${PUBLIC}/${token}/verify`).send({ otp: '123456' }), 410, 'LINK_EXPIRED');
    const audit = await AuditModel.findOne({ action: 'invitation.revoked', entityId: idString(invitation._id) }).lean();
    expect(audit?.actorEmail).toBe(adminA.user.email);

    expectError(await adminA.post(`/api/v1/invitations/${idString(invitation._id)}/revoke`), 412, 'PRECONDITION_FAILED');
    const submitted = (await invitationsOf(acoA, { state: 'SUBMITTED' }))[0]!;
    expectError(await adminA.post(`/api/v1/invitations/${idString(submitted._id)}/revoke`), 412, 'PRECONDITION_FAILED');
    expectError(await superAdmin.post(`/api/v1/invitations/${idString(invitation._id)}/resend`), 412, 'PRECONDITION_FAILED');
  });
});

describe('reminders', () => {
  it('sends the due reminder once per invitation that was sent and not submitted, with a link of its own that does not kill the first', async () => {
    const now = new Date();
    const first = await sendReminders(cycleId, now, { dueOnly: true });
    // A: cDom (SENT after the resend) · B: cB (SENT). cBoth DOMESTIC is SUBMITTED, cBoth INTERNATIONAL is REVOKED.
    expect(first.sent).toBe(2);

    const reminded = await InvitationModel.find({ cycleId, remindersSent: 1 }).lean<InvitationDoc[]>();
    expect(reminded.map((doc) => doc.state).sort()).toEqual(['OPENED', 'SENT']);
    for (const doc of reminded) {
      expect(doc.lastReminderAt?.getTime()).toBe(now.getTime());
      expect(doc.previousTokenHashes).toHaveLength(1);
      const mails = await mailsFor(idString(doc._id), 'assessment-reminder');
      expect(mails).toHaveLength(1);
      expect(mails[0]!.vars).toMatchObject({ reminderNumber: 1 });
      expect(mails[0]!.subject).toContain('Reminder');
      const reminderToken = await tokenFromMail(idString(doc._id), 'assessment-reminder');
      const invitationToken = await tokenFromMail(idString(doc._id), 'assessment-invitation');
      expect(reminderToken).not.toBe(invitationToken);
      expect(idString((await getByToken(reminderToken))!._id)).toBe(idString(doc._id));
      expect(idString((await getByToken(invitationToken))!._id)).toBe(idString(doc._id));
    }
    expect(await NotificationModel.countDocuments({ template: 'assessment-reminder' })).toBe(2);
  });

  it('is idempotent on the clock: a second tick sends nothing, and the next reminder is not due yet', async () => {
    expect(await sendReminders(cycleId, new Date(), { dueOnly: true })).toEqual({ sent: 0 });
    expect(await sendDueReminders(new Date())).toEqual({ sent: 0 });
    expect(await NotificationModel.countDocuments({ template: 'assessment-reminder' })).toBe(2);
    expect(await JobModel.countDocuments({ type: 'invitation.reminder', status: 'DONE' })).toBe(2);
  });

  it('a manual run sends the next reminder now, for one operator only when asked', async () => {
    const manual = await sendReminders(cycleId, new Date(), { acoId: acoB });
    expect(manual).toEqual({ sent: 1 });
    const b = (await invitationsOf(acoB, { state: 'SENT' }))[0]!;
    expect(b.remindersSent).toBe(2);
    expect((await mailsFor(idString(b._id), 'assessment-reminder'))[1]!.vars).toMatchObject({ reminderNumber: 2 });
    const a = (await invitationsOf(acoA, { customerId: cDom }))[0]!;
    expect(a.remindersSent).toBe(1);
  });

  it('runs through the sender registered into cycles (POST /cycles/:id/reminders/send)', async () => {
    const res = await superAdmin.post(`/api/v1/cycles/${cycleId}/reminders/send`).send({ kind: 'ASSESSMENT', acoId: acoA });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ kind: 'ASSESSMENT', sent: 1 });
    expect((await invitationsOf(acoA, { customerId: cDom }))[0]!.remindersSent).toBe(2);
  });
});

describe('expiry', () => {
  let expiringCycle: string;
  let cExp: string;

  beforeAll(async () => {
    expiringCycle = await createTestCycle(
      {
        code: 'INV-EXP',
        type: 'DOMESTIC',
        minSampleSize: 1,
        status: 'ASSESSMENT_OPEN',
        samplingStart: new Date(Date.now() - 40 * DAY),
        samplingEnd: new Date(Date.now() - 31 * DAY),
        assessmentStart: new Date(Date.now() - 31 * DAY),
        assessmentEnd: new Date(Date.now() - 60 * MINUTE),
        surveyVersions: { DOMESTIC: domestic.id },
      },
      [adminA.org],
    );
    cExp = await createTestCustomer({ acoId: acoA, airportId: del, name: 'Late Logistics', contactPerson: 'Lata', email: 'lata@late.test', type: 'FF' });
    await createPendingForSamples({ cycleId: expiringCycle, acoId: acoA, samples: [sampleOf(cExp, 'DOMESTIC')] });
    await CycleParticipantModel.updateOne({ cycleId: expiringCycle, acoId: acoA }, { $set: { 'sampling.status': 'LOCKED' } });
    await activateCycle(expiringCycle);
  });

  it('shows EXPIRED by the clock before the job runs and refuses codes', async () => {
    const doc = (await InvitationModel.findOne({ cycleId: expiringCycle }).lean<InvitationDoc>())!;
    expect(doc.state).toBe('SENT');
    const token = await tokenFromMail(idString(doc._id));
    const status = await t.anon.get(`${PUBLIC}/${token}`);
    expect(status.status).toBe(200);
    expect(status.body.data.state).toBe('EXPIRED');
    expectError(await t.anon.post(`${PUBLIC}/${token}/otp`), 410, 'LINK_EXPIRED');
    expect((await InvitationModel.findById(doc._id).lean())?.state).toBe('SENT');
  });

  it('follows an extended window instead of expiring, then expires once the window has really passed', async () => {
    const extendedEnd = new Date(Date.now() + 5 * DAY);
    await CycleModel.updateOne({ _id: expiringCycle }, { $set: { 'assessment.end': { wall: extendedEnd.toISOString().slice(0, 16), utc: extendedEnd } } });
    expect(await expireDue(new Date())).toEqual({ expired: 0, extended: 1 });
    const doc = (await InvitationModel.findOne({ cycleId: expiringCycle }).lean<InvitationDoc>())!;
    expect(doc.state).toBe('SENT');
    expect(doc.expiresAt.getTime()).toBe(extendedEnd.getTime());

    const pastEnd = new Date(Date.now() - 60 * MINUTE);
    await CycleModel.updateOne({ _id: expiringCycle }, { $set: { 'assessment.end': { wall: pastEnd.toISOString().slice(0, 16), utc: pastEnd } } });
    await InvitationModel.updateOne({ _id: doc._id }, { $set: { expiresAt: pastEnd } });
    expect(await expireDue(new Date())).toEqual({ expired: 1, extended: 0 });
    const expired = (await InvitationModel.findById(doc._id).lean())!;
    expect(expired.state).toBe('EXPIRED');
    expect(expired.expiredAt).toBeInstanceOf(Date);
    expect(await expireDue(new Date())).toEqual({ expired: 0, extended: 0 });
  });

  it('an EXPIRED invitation comes back only through a resend after the window was extended', async () => {
    const doc = (await InvitationModel.findOne({ cycleId: expiringCycle }).lean<InvitationDoc>())!;
    expectError(await superAdmin.post(`/api/v1/invitations/${idString(doc._id)}/resend`), 412, 'PRECONDITION_FAILED');
    const extendedEnd = new Date(Date.now() + 5 * DAY);
    await CycleModel.updateOne({ _id: expiringCycle }, { $set: { 'assessment.end': { wall: extendedEnd.toISOString().slice(0, 16), utc: extendedEnd } } });
    const res = await superAdmin.post(`/api/v1/invitations/${idString(doc._id)}/resend`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.state).toBe('SENT');
    expect(new Date(res.body.data.expiresAt).getTime()).toBe(extendedEnd.getTime());
    const token = await tokenFromMail(idString(doc._id));
    expect((await t.anon.get(`${PUBLIC}/${token}`)).body.data.state).toBe('OPENED');
  });
});

describe('cross-ACO isolation', () => {
  it('a session of one operator’s participant opens nothing of another operator', async () => {
    const b = (await invitationsOf(acoB, { state: 'SENT' }))[0]!;
    const bToken = await tokenFromMail(idString(b._id), 'assessment-reminder');
    const aSubmitted = (await invitationsOf(acoA, { state: 'SUBMITTED' }))[0]!;
    const aSession = await invitationsConfig().links.sign({
      audience: 'participant',
      subject: idString(aSubmitted._id),
      claims: { inv: idString(aSubmitted._id), asg: idString(aSubmitted.assessmentId!), aco: acoA },
      ttlSeconds: 60,
    });
    expectError(await t.anon.get(`${PUBLIC}/${bToken}/form`).set(LINK_HEADER, aSession), 404, 'NOT_FOUND');
    expectError(await t.anon.get(`${PUBLIC}/${bToken}/draft`).set(LINK_HEADER, aSession), 404, 'NOT_FOUND');
    expectError(await t.anon.post(`${PUBLIC}/${bToken}/submit`).set(LINK_HEADER, aSession), 404, 'NOT_FOUND');
  });

  it('an operator never sees another operator’s invitations and an airport organisation sees its airport’s operators', async () => {
    const b = (await invitationsOf(acoB, { state: 'SENT' }))[0]!;
    const list = await adminA.get(`/api/v1/invitations?acoId=${acoB}`);
    expect(list.body.meta.total).toBe(0);
    expectError(await adminA.post(`/api/v1/invitations/${idString(b._id)}/revoke`), 404, 'NOT_FOUND');

    const airportDel = await t.asUser({ orgType: 'AIRPORT', roleCode: 'AIRPORT_ADMIN', orgCode: 'INV-DEL', airportIata: 'DEL' });
    const seen = await airportDel.get(`/api/v1/invitations?cycleId=${cycleId}`);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(seen.body.data.every((row: { airportId: string }) => row.airportId === del)).toBe(true);
    expect(seen.body.meta.total).toBe(3);
  });

  it('a lock for a customer of another operator is refused and nothing is created', async () => {
    await expect(createPendingForSamples({ cycleId, acoId: acoA, samples: [sampleOf(cB, 'DOMESTIC')] })).rejects.toBeInstanceOf(AppError);
    expect(await InvitationModel.countDocuments({ cycleId, customerId: cB, acoId: acoA })).toBe(0);
  });
});
