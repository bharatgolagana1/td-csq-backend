// The assessments part of the participant flow (ARCHITECTURE §6 "public
// participant flow"), driven the way the invitations public routes call it,
// against the real neighbours: the seeded ACFI survey bank, a cycle with its
// participant from the cycles rules, a customer, an invitation created by
// the invitations service, and the cycles listener for `assessment.submitted`
// (participant stats / self-assessment status). Nothing is mocked.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LinkSession } from '../src/core/auth/link.js';
import { idString, newId, toId } from '../src/core/ids.js';
import { getDraft, getForm, getOrCreateForInvitation, listSubmitted, patchAnswers, readiness, submit } from '../src/modules/assessments/assessments.service.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { getParticipant } from '../src/modules/cycles/cycles.service.js';
import { InvitationModel, type InvitationDoc } from '../src/modules/invitations/invitations.model.js';
import { createPendingForSamples } from '../src/modules/invitations/invitations.service.js';
import { seedSurveys } from '../src/seed/surveys.js';

import { createTestCustomer, createTestCycle, type TestCycle } from './assessments.fixtures.js';
import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata } from './helpers/fixtures.js';

let t: TestApp;
let operator: TestUser;
let acoId: string;
let surveyId: string;
let cycle: TestCycle;
let customerId: string;
let invitation: InvitationDoc;

interface FormQuestionView {
  id: string;
  code: string;
  commentMode: string;
  followUp: { options: string[] } | null;
}

function questionsOf(form: { categories: { questions: FormQuestionView[]; subcategories: { questions: FormQuestionView[] }[] }[] }): FormQuestionView[] {
  return form.categories.flatMap((category) => [...category.questions, ...category.subcategories.flatMap((sub) => sub.questions)]);
}

beforeAll(async () => {
  t = await createTestApp();
  operator = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'FLOW-ACO', airportIata: 'BLR', name: 'Nisha Menon' });
  acoId = idString(operator.org._id);
  surveyId = (await seedSurveys()).INTERNATIONAL.id;
  cycle = await createTestCycle({
    code: 'FLOW-1',
    type: 'INTERNATIONAL',
    status: 'ASSESSMENT_OPEN',
    surveyVersions: { DOMESTIC: null, INTERNATIONAL: surveyId },
    participants: [{ org: operator.org, surveyTypes: ['INTERNATIONAL'] }],
  });
  const blr = await airportIdByIata('BLR');
  customerId = await createTestCustomer({ acoId, airportId: blr, name: 'Garden City Brokers', contactPerson: 'Lakshmi Iyer', email: 'lakshmi@gcb.test', type: 'CB' });
  // The invitation as the sample lock creates it; the OTP step is the invitations module's own flow,
  // so the state is moved to VERIFIED directly (what the public routes guarantee before they call us).
  await createPendingForSamples({ cycleId: cycle.id, acoId, samples: [{ sampleId: idString(newId()), customerId, surveyType: 'INTERNATIONAL' }] });
  const pending = await InvitationModel.findOneAndUpdate(
    { cycleId: toId(cycle.id), acoId: toId(acoId), customerId: toId(customerId) },
    { $set: { state: 'VERIFIED', verifiedAt: new Date() } },
    { new: true },
  ).lean<InvitationDoc>();
  if (!pending) throw new Error('Invitation was not created');
  invitation = pending;
});
afterAll(() => t.close());

describe('participant flow', () => {
  let assessmentId: string;
  let link: LinkSession;
  let questions: FormQuestionView[];

  it('verify → the invitation gets its assessment (idempotent) and the link session names it', async () => {
    const created = await getOrCreateForInvitation(invitation);
    assessmentId = created.id;
    expect(created).toMatchObject({
      cycleId: cycle.id,
      acoId,
      kind: 'CUSTOMER',
      customerType: 'CB',
      surveyId,
      surveyType: 'INTERNATIONAL',
      invitationId: idString(invitation._id),
      status: 'DRAFT',
      progress: { answered: 0, total: 27, pct: 0 },
    });
    expect((await getOrCreateForInvitation(invitation)).id).toBe(assessmentId);
    link = {
      audience: 'participant',
      subject: idString(invitation._id),
      claims: { inv: idString(invitation._id), asg: assessmentId, aco: acoId },
      expiresAt: new Date(Date.now() + 3_600_000),
    };
  });

  it('form → the 27 international parameters for a customs broker under the four heads; draft → empty', async () => {
    const form = await getForm(assessmentId);
    expect(form.survey).toMatchObject({ id: surveyId, code: 'INTERNATIONAL', version: 1, status: 'PUBLISHED' });
    expect(form.stakeholderType).toBe('CB');
    expect(form.scale.map((step) => step.value)).toEqual([1, 2, 3, 4, 5]);
    expect(form.categories.map((category) => category.code)).toEqual(['INFRA', 'SEC', 'PROC', 'TRADE']);
    questions = questionsOf(form);
    expect(questions).toHaveLength(27);
    expect(form.questionCount).toBe(27);
    expect(form.progress).toEqual({ answered: 0, total: 27, pct: 0 });
    const draft = await getDraft(assessmentId);
    expect(draft).toMatchObject({ id: assessmentId, status: 'DRAFT', answers: [], progress: { answered: 0, total: 27, pct: 0 }, lastSavedAt: null, submittedAt: null });
  });

  it('autosave in batches → progress climbs; readiness lists what is left; submit waits for 100 %', async () => {
    const [first, second, third] = questions;
    expect(first?.commentMode).toBe('REQUIRED_ON_LOW');
    // A Fair rating needs its comment (and may carry follow-up options).
    await expect(patchAnswers(assessmentId, [{ questionId: first!.id, rating: 2 }])).rejects.toMatchObject({ code: 'VALIDATION' });
    const followUp = first!.followUp ? [first!.followUp.options[0]!] : [];
    expect(await patchAnswers(assessmentId, [{ questionId: first!.id, rating: 2, comment: 'Acceptance queue is slow', followUp }])).toMatchObject({ answered: 1, total: 27, pct: 4 });
    expect(await patchAnswers(assessmentId, [{ questionId: second!.id, na: true }, { questionId: third!.id, rating: 4 }])).toMatchObject({ answered: 3, pct: 11 });

    const middle = questions.slice(3, 20).map((question) => ({ questionId: question.id, rating: 4 }));
    expect(await patchAnswers(assessmentId, middle)).toMatchObject({ answered: 20, total: 27, pct: 74 });

    const ready = await readiness(assessmentId);
    expect(ready).toEqual({ answered: 20, total: 27, missing: questions.slice(20).map((question) => question.id), complete: false });
    await expect(submit(link, assessmentId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', details: { missing: ready.missing } });
    expect((await getDraft(assessmentId)).status).toBe('DRAFT');
  });

  it('submit → SUBMITTED and locked, the audit row, the participant counted as completed, and the row scoring reads', async () => {
    await patchAnswers(assessmentId, questions.slice(20).map((question) => ({ questionId: question.id, rating: 4 })));
    expect((await readiness(assessmentId)).complete).toBe(true);
    const result = await submit(link, assessmentId);
    expect(result.status).toBe('SUBMITTED');
    expect(result.submittedAt).not.toBeNull();
    expect(result.progress).toEqual({ answered: 27, total: 27, pct: 100 });

    expect(await AuditModel.countDocuments({ action: 'assessment.submitted', entityId: assessmentId })).toBe(1);
    // The cycles listener ran inside the submit transaction.
    const participant = await getParticipant(cycle.id, acoId);
    expect(participant?.stats.completed).toBe(1);

    await expect(patchAnswers(assessmentId, [{ questionId: questions[0]!.id, rating: 1 }])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(submit(link, assessmentId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const draft = await getDraft(assessmentId);
    expect(draft.status).toBe('SUBMITTED');
    expect(draft.answers).toHaveLength(27);

    const rows = await listSubmitted(cycle.id, acoId, 'CUSTOMER');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: assessmentId, kind: 'CUSTOMER', customerType: 'CB', surveyType: 'INTERNATIONAL', customerId });
    expect(rows[0]!.answers.filter((answer) => answer.na)).toHaveLength(1);
    expect(rows[0]!.answers.filter((answer) => answer.rating === 4)).toHaveLength(25);
  });

  it('the signed-in history shows the submission to the operator with the assessor masked and the NA-excluding score', async () => {
    const res = await operator.get(`/api/v1/assessments?cycleId=${cycle.id}&kind=CUSTOMER`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // (25 × 4 + 2) / 26 = 3.92 → 3.9
    expect(res.body.data[0]).toMatchObject({ id: assessmentId, status: 'SUBMITTED', assessorName: 'L*** I***', assessorEmailMasked: 'l***@gcb.test', score: 3.9 });
    const one = await operator.get(`/api/v1/assessments/${assessmentId}`);
    expect(one.status).toBe(200);
    expect(one.body.data.answers).toHaveLength(27);
    expect(one.body.data.answers[0]).toMatchObject({ code: questions[0]!.code, rating: 2, comment: 'Acceptance queue is slow' });
  });
});

describe('self-assessment flow', () => {
  const path = () => `/api/v1/assessments/self/${cycle.id}/INTERNATIONAL`;

  it('the operator rates itself on every active question and the participant records the submission', async () => {
    const opened = await operator.get(path());
    expect(opened.status).toBe(200);
    expect(opened.body.data).toMatchObject({ stakeholderType: null, questionCount: 27, progress: { answered: 0, total: 27, pct: 0 } });
    expect((await getParticipant(cycle.id, acoId))?.selfAssessment.INTERNATIONAL).toBe('NOT_STARTED');

    const questions = questionsOf(opened.body.data);
    const saved = await operator.patch(`${path()}/answers`).send({ answers: questions.map((question, index) => (index === 5 ? { questionId: question.id, na: true } : { questionId: question.id, rating: 5 })) });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ answered: 27, total: 27, pct: 100 });

    const done = await operator.post(`${path()}/submit`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ kind: 'SELF', status: 'SUBMITTED' });
    expect((await getParticipant(cycle.id, acoId))?.selfAssessment.INTERNATIONAL).toBe('SUBMITTED');
    expect(await listSubmitted(cycle.id, acoId, 'SELF')).toHaveLength(1);
    expect(await listSubmitted(cycle.id, acoId)).toHaveLength(2);
  });

  it('the export carries both submissions, one line per question', async () => {
    const res = await operator.get(`/api/v1/assessments/export?cycleId=${cycle.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('assessments-FLOW-1.csv');
    expect(res.text.trim().split('\n')).toHaveLength(1 + 27 + 27);
  });
});
