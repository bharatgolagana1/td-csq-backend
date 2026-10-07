import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '../src/core/errors.js';
import { clearEventHandlers, on, type Events } from '../src/core/events.js';
import { idString, newId } from '../src/core/ids.js';
import { AssessmentModel } from '../src/modules/assessments/assessments.model.js';
import {
  getDraft,
  getForm,
  getOrCreateForInvitation,
  getOrCreateSelf,
  listSubmitted,
  patchAnswers,
  readiness,
  submit,
} from '../src/modules/assessments/assessments.service.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';

import {
  createTestCustomer,
  createTestCycle,
  createTestSurvey,
  ctxOf,
  FOLLOW_UP_OPTIONS,
  setTestCycleStatus,
  type TestCycle,
  type TestSurvey,
} from './assessments.fixtures.js';
import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, expectError, grantTasks } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let adminA: TestUser;
let userA: TestUser;
let adminB: TestUser;
let del: string;
let bom: string;
let domestic: TestSurvey;
let international: TestSurvey;
let cycle: TestCycle;
let ffCustomerA: string;
let cbCustomerA: string;
let customerB: string;
const submitted: Events['assessment.submitted'][] = [];

function invitation(customerId: string, acoId: string, surveyType: 'DOMESTIC' | 'INTERNATIONAL' = 'DOMESTIC', cycleId = cycle.id) {
  return { _id: newId(), cycleId, acoId, customerId, surveyType };
}

beforeAll(async () => {
  t = await createTestApp();
  // This file asserts on the event itself; the real listeners are exercised by the flow test.
  clearEventHandlers();
  on('assessment.submitted', 'test.recordSubmitted', async (payload) => {
    submitted.push(payload);
  });
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  adminA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'ACO-A', airportIata: 'DEL', name: 'Asha Rao' });
  userA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_USER', orgCode: 'ACO-A', airportIata: 'DEL', name: 'Ravi Kumar' });
  adminB = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'ACO-B', airportIata: 'BOM' });
  del = await airportIdByIata('DEL');
  bom = await airportIdByIata('BOM');
  domestic = await createTestSurvey('DOMESTIC');
  international = await createTestSurvey('INTERNATIONAL');
  cycle = await createTestCycle({
    code: 'CSQ-2026-1',
    status: 'ASSESSMENT_OPEN',
    surveyVersions: { DOMESTIC: domestic.id, INTERNATIONAL: international.id },
    participants: [
      { org: adminA.org, surveyTypes: ['DOMESTIC', 'INTERNATIONAL'] },
      { org: adminB.org, surveyTypes: ['DOMESTIC'] },
    ],
  });
  const acoA = idString(adminA.org._id);
  ffCustomerA = await createTestCustomer({ acoId: acoA, airportId: del, name: 'Fast Forwarders', contactPerson: 'Meera Nair', email: 'meera@fastfwd.test', type: 'FF' });
  cbCustomerA = await createTestCustomer({ acoId: acoA, airportId: del, name: 'Clear Brokers', contactPerson: 'Imran Shaikh', email: 'imran@clearbrokers.test', type: 'CB' });
  customerB = await createTestCustomer({ acoId: idString(adminB.org._id), airportId: bom, name: 'Bombay Freight', contactPerson: 'Dev Patel', email: 'dev@bombayfreight.test', type: 'FF' });
});
afterAll(() => t.close());

describe('getOrCreateForInvitation', () => {
  it('creates one DRAFT assessment per invitation with the pinned survey version and the customer type, and returns it again afterwards', async () => {
    const inv = invitation(ffCustomerA, idString(adminA.org._id));
    const first = await getOrCreateForInvitation(inv);
    expect(first).toMatchObject({
      cycleId: cycle.id,
      acoId: idString(adminA.org._id),
      airportId: del,
      surveyId: domestic.id,
      surveyType: 'DOMESTIC',
      kind: 'CUSTOMER',
      customerType: 'FF',
      invitationId: idString(inv._id),
      userId: null,
      status: 'DRAFT',
      progress: { answered: 0, total: 4, pct: 0 },
      lastSavedAt: null,
      submittedAt: null,
    });
    const again = await getOrCreateForInvitation({ id: idString(inv._id), cycleId: inv.cycleId, acoId: inv.acoId, customerId: inv.customerId, surveyType: 'DOMESTIC' });
    expect(again.id).toBe(first.id);
    expect(await AssessmentModel.countDocuments({ invitationId: inv._id })).toBe(1);
  });

  it('pins the INTERNATIONAL version for an INTERNATIONAL invitation', async () => {
    const created = await getOrCreateForInvitation(invitation(cbCustomerA, idString(adminA.org._id), 'INTERNATIONAL'));
    expect(created).toMatchObject({ surveyId: international.id, surveyType: 'INTERNATIONAL', customerType: 'CB' });
  });

  it('refuses when the cycle pins no survey for the type, the operator is not a participant, or the customer or cycle is unknown', async () => {
    const noSurvey = await createTestCycle({
      code: 'DOM-ONLY',
      type: 'DOMESTIC',
      status: 'ASSESSMENT_OPEN',
      surveyVersions: { DOMESTIC: domestic.id, INTERNATIONAL: null },
      participants: [{ org: adminA.org, surveyTypes: ['DOMESTIC'] }],
    });
    await expect(getOrCreateForInvitation(invitation(ffCustomerA, idString(adminA.org._id), 'INTERNATIONAL', noSurvey.id))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(getOrCreateForInvitation(invitation(customerB, idString(adminB.org._id), 'DOMESTIC', noSurvey.id))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(getOrCreateForInvitation(invitation(customerB, idString(adminA.org._id)))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getOrCreateForInvitation(invitation(ffCustomerA, idString(adminA.org._id), 'DOMESTIC', idString(newId())))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('getForm', () => {
  it('renders the surveys form for the stakeholder type unchanged — survey, scale, questionCount, categories → questions / subcategories — plus the assessment and its progress', async () => {
    const ff = await getOrCreateForInvitation(invitation(ffCustomerA, idString(adminA.org._id)));
    const form = await getForm(ff.id);
    expect(form.assessment.id).toBe(ff.id);
    expect(form.survey).toEqual({ id: domestic.id, code: 'DOMESTIC', name: 'DOMESTIC test survey', version: 1, status: 'PUBLISHED' });
    expect(form.stakeholderType).toBe('FF');
    expect(form.scale.map((step) => step.label)).toEqual(['Poor', 'Fair', 'Good', 'Very Good', 'Excellent']);
    expect(form.questionCount).toBe(4);
    expect(form.progress).toEqual({ answered: 0, total: 4, pct: 0 });
    expect(form.categories.map((category) => category.code)).toEqual(['INFRA', 'PROC']);
    const [infra, proc] = form.categories;
    expect(infra).toMatchObject({ id: domestic.section['INFRA'], code: 'INFRA', name: 'Infrastructure', order: 10, weightPct: 40 });
    expect(infra!.questions.map((question) => question.code)).toEqual(['Q.LOW']);
    expect(infra!.subcategories.map((sub) => sub.code)).toEqual(['STORAGE']);
    expect(infra!.subcategories[0]!.questions.map((question) => question.code)).toEqual(['Q.OPT', 'Q.REQ']);
    expect(infra!.subcategories[0]!.questions[0]).toEqual({
      id: domestic.q['Q.OPT'],
      categoryId: domestic.section['INFRA'],
      subcategoryId: domestic.section['STORAGE'],
      code: 'Q.OPT',
      text: 'Question Q.OPT',
      help: 'Rate the storage',
      order: 1,
      weightPct: null,
      mandatory: true,
      commentMode: 'OPTIONAL',
      followUp: null,
    });
    expect(infra!.questions[0]).toMatchObject({ subcategoryId: null, commentMode: 'REQUIRED_ON_LOW', followUp: { prompt: 'What went wrong?', options: FOLLOW_UP_OPTIONS } });
    // The inactive question and the CB-only question are not on an FF form.
    expect(proc!.questions.map((question) => question.code)).toEqual(['Q.PLAIN']);
    expect(proc!.subcategories).toEqual([]);
  });

  it('filters by stakeholder type: a customs broker gets the CB questions and not the FF-only one', async () => {
    const cb = await getOrCreateForInvitation(invitation(cbCustomerA, idString(adminA.org._id)));
    const form = await getForm(cb.id);
    const codes = form.categories.flatMap((category) => [...category.questions, ...category.subcategories.flatMap((sub) => sub.questions)]).map((q) => q.code);
    expect(codes).toEqual(['Q.OPT', 'Q.REQ', 'Q.NONE', 'Q.PLAIN']);
    expect(form.stakeholderType).toBe('CB');
    expect(form.questionCount).toBe(4);
    expect(form.progress.total).toBe(4);
    await expect(getForm(idString(newId()))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('patchAnswers', () => {
  let id: string;
  const issuesOf = async (answers: Parameters<typeof patchAnswers>[1]): Promise<string[]> => {
    try {
      await patchAnswers(id, answers);
    } catch (error) {
      if (error instanceof AppError && error.code === 'VALIDATION') {
        return (error.details as { issues: { path: string; message: string }[] }).issues.map((issue) => `${issue.path}: ${issue.message}`);
      }
      throw error;
    }
    return [];
  };

  beforeAll(async () => {
    id = (await getOrCreateForInvitation(invitation(ffCustomerA, idString(adminA.org._id)))).id;
  });

  it('rejects a question that is not on the form, and the same question twice in one batch', async () => {
    expect(await issuesOf([{ questionId: domestic.q['Q.NONE']!, rating: 4 }])).toEqual([`answers.0.questionId: question ${domestic.q['Q.NONE']} is not on this form`]);
    expect(await issuesOf([{ questionId: domestic.q['Q.OFF']!, rating: 4 }])).toHaveLength(1);
    expect(await issuesOf([{ questionId: domestic.q['Q.OPT']!, rating: 4 }, { questionId: domestic.q['Q.OPT']!, rating: 5 }])).toEqual([
      `answers.1.questionId: question ${domestic.q['Q.OPT']} appears twice in this batch`,
    ]);
  });

  it('requires exactly one of a rating or NA, and a rating between 1 and 5', async () => {
    expect(await issuesOf([{ questionId: domestic.q['Q.OPT']! }])).toEqual(['answers.0.rating: needs a rating from 1 to 5 or NA']);
    expect(await issuesOf([{ questionId: domestic.q['Q.OPT']!, rating: null, na: false }])).toHaveLength(1);
    expect(await issuesOf([{ questionId: domestic.q['Q.OPT']!, rating: 4, na: true }])).toEqual(['answers.0.na: a rating and NA are exclusive']);
    expect(await issuesOf([{ questionId: domestic.q['Q.OPT']!, rating: 6 }])).toContain('answers.0.rating: must be a whole number from 1 to 5');
    expect(await issuesOf([{ questionId: domestic.q['Q.OPT']!, rating: 2.5 }])).toHaveLength(1);
    expect(await issuesOf([{ questionId: domestic.q['Q.OPT']!, rating: 4 }])).toEqual([]);
    expect(await issuesOf([{ questionId: domestic.q['Q.OPT']!, na: true }])).toEqual([]);
  });

  it('requires a comment when the comment mode is REQUIRED (also on NA)', async () => {
    expect(await issuesOf([{ questionId: domestic.q['Q.REQ']!, rating: 5 }])).toEqual(['answers.0.comment: a comment is required for this question']);
    expect(await issuesOf([{ questionId: domestic.q['Q.REQ']!, rating: 5, comment: '   ' }])).toHaveLength(1);
    expect(await issuesOf([{ questionId: domestic.q['Q.REQ']!, na: true }])).toHaveLength(1);
    expect(await issuesOf([{ questionId: domestic.q['Q.REQ']!, rating: 5, comment: 'Spotless' }])).toEqual([]);
  });

  it('requires a comment on a Fair or Poor rating when the mode is REQUIRED_ON_LOW, and not otherwise', async () => {
    expect(await issuesOf([{ questionId: domestic.q['Q.LOW']!, rating: 2 }])).toEqual(['answers.0.comment: a comment is required for a Fair or Poor rating']);
    expect(await issuesOf([{ questionId: domestic.q['Q.LOW']!, rating: 1 }])).toHaveLength(1);
    expect(await issuesOf([{ questionId: domestic.q['Q.LOW']!, rating: 3 }])).toEqual([]);
    expect(await issuesOf([{ questionId: domestic.q['Q.LOW']!, na: true }])).toEqual([]);
    expect(await issuesOf([{ questionId: domestic.q['Q.LOW']!, rating: 2, comment: 'Slow' }])).toEqual([]);
  });

  it('refuses a comment where the mode is NONE', async () => {
    const cb = await getOrCreateForInvitation(invitation(cbCustomerA, idString(adminA.org._id)));
    await expect(patchAnswers(cb.id, [{ questionId: domestic.q['Q.NONE']!, rating: 4, comment: 'Nice' }])).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { issues: [{ path: 'answers.0.comment', message: 'this question takes no comment' }] },
    });
    expect((await patchAnswers(cb.id, [{ questionId: domestic.q['Q.NONE']!, rating: 4, comment: '' }])).answered).toBe(1);
  });

  it('allows follow-up options only on a Fair or Poor rating, only from the list, and only where the question offers them', async () => {
    const low = domestic.q['Q.LOW']!;
    expect(await issuesOf([{ questionId: low, rating: 4, followUp: ['Long delay'] }])).toEqual(['answers.0.followUp: follow-up options apply to a Fair or Poor rating only']);
    expect(await issuesOf([{ questionId: low, na: true, followUp: ['Long delay'] }])).toHaveLength(1);
    expect(await issuesOf([{ questionId: low, rating: 2, comment: 'Slow', followUp: ['Rude'] }])).toEqual(['answers.0.followUp.0: "Rude" is not one of the listed options']);
    expect(await issuesOf([{ questionId: low, rating: 2, comment: 'Slow', followUp: ['Long delay', 'Long delay'] }])).toEqual(['answers.0.followUp.1: "Long delay" is listed twice']);
    expect(await issuesOf([{ questionId: domestic.q['Q.OPT']!, rating: 1, followUp: ['Long delay'] }])).toEqual(['answers.0.followUp: this question has no follow-up options']);
    expect(await issuesOf([{ questionId: low, rating: 1, comment: 'Bad day', followUp: ['Long delay', 'Damaged cargo'] }])).toEqual([]);
    const draft = await getDraft(id);
    expect(draft.answers.find((answer) => answer.questionId === low)).toEqual({ questionId: low, rating: 1, na: false, comment: 'Bad day', followUp: ['Long delay', 'Damaged cargo'] });
  });

  it('merges by question, replaces an earlier answer for the same question, recounts and returns progress', async () => {
    const fresh = (await getOrCreateForInvitation(invitation(ffCustomerA, idString(adminA.org._id)))).id;
    const one = await patchAnswers(fresh, [{ questionId: domestic.q['Q.OPT']!, rating: 3, comment: 'ok' }]);
    expect(one).toMatchObject({ answered: 1, total: 4, pct: 25 });
    expect(typeof one.lastSavedAt).toBe('string');
    const two = await patchAnswers(fresh, [{ questionId: domestic.q['Q.PLAIN']!, na: true }]);
    expect(two).toMatchObject({ answered: 2, total: 4, pct: 50 });
    const replaced = await patchAnswers(fresh, [{ questionId: domestic.q['Q.OPT']!, rating: 5 }]);
    expect(replaced).toMatchObject({ answered: 2, total: 4, pct: 50 });
    const draft = await getDraft(fresh);
    expect(draft.answers).toEqual([
      { questionId: domestic.q['Q.OPT'], rating: 5, na: false, comment: null, followUp: [] },
      { questionId: domestic.q['Q.PLAIN'], rating: null, na: true, comment: null, followUp: [] },
    ]);
    expect(draft.progress).toEqual({ answered: 2, total: 4, pct: 50 });
    expect(draft.status).toBe('DRAFT');
    // A batch may be empty; nothing changes.
    expect((await patchAnswers(fresh, [])).answered).toBe(2);
    // A whole batch is refused when one entry is invalid.
    await expect(patchAnswers(fresh, [{ questionId: domestic.q['Q.REQ']!, rating: 4, comment: 'fine' }, { questionId: domestic.q['Q.LOW']!, rating: 2 }])).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await getDraft(fresh)).answers).toHaveLength(2);
  });
});

describe('readiness and submit', () => {
  let id: string;
  const acoA = () => idString(adminA.org._id);

  beforeAll(async () => {
    id = (await getOrCreateForInvitation(invitation(ffCustomerA, acoA()))).id;
  });

  it('lists the unanswered questions in form order and refuses to submit until none are left', async () => {
    expect(await readiness(id)).toEqual({ answered: 0, total: 4, missing: [domestic.q['Q.LOW'], domestic.q['Q.OPT'], domestic.q['Q.REQ'], domestic.q['Q.PLAIN']], complete: false });
    await patchAnswers(id, [
      { questionId: domestic.q['Q.REQ']!, rating: 4, comment: 'Good' },
      { questionId: domestic.q['Q.PLAIN']!, rating: 5 },
    ]);
    expect(await readiness(id)).toEqual({ answered: 2, total: 4, missing: [domestic.q['Q.LOW'], domestic.q['Q.OPT']], complete: false });
    const link = { audience: 'participant' as const, subject: 'inv', claims: { asg: id }, expiresAt: new Date(Date.now() + 60_000) };
    const refused = await submit(link, id).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'PRECONDITION_FAILED', details: { missing: [domestic.q['Q.LOW'], domestic.q['Q.OPT']] } });
    expect(submitted).toHaveLength(0);
  });

  it('a link session for another assessment, a registration link, or a signed-in user of another operator gets 404', async () => {
    const other = { audience: 'participant' as const, subject: 'inv', claims: { asg: idString(newId()) }, expiresAt: new Date(Date.now() + 60_000) };
    await expect(submit(other, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const registration = { audience: 'registration' as const, subject: 'reg', claims: {}, expiresAt: new Date(Date.now() + 60_000) };
    await expect(submit(registration, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(submit(ctxOf(adminB), id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('submits once complete: SUBMITTED + submittedAt, the event with kind / surveyType / invitationId, the audit row; then everything is read-only', async () => {
    await patchAnswers(id, [
      { questionId: domestic.q['Q.OPT']!, na: true },
      { questionId: domestic.q['Q.LOW']!, rating: 2, comment: 'Slow gate', followUp: ['Long delay'] },
    ]);
    expect((await readiness(id)).complete).toBe(true);
    const link = { audience: 'participant' as const, subject: 'inv', claims: { asg: id, aco: acoA() }, expiresAt: new Date(Date.now() + 60_000) };
    const result = await submit(link, id);
    expect(result.status).toBe('SUBMITTED');
    expect(result.submittedAt).toBeTruthy();
    expect(result.progress).toEqual({ answered: 4, total: 4, pct: 100 });

    const doc = await AssessmentModel.findById(id).lean();
    expect(submitted).toEqual([
      { assessmentId: id, cycleId: cycle.id, acoId: acoA(), kind: 'CUSTOMER', surveyType: 'DOMESTIC', invitationId: idString(doc!.invitationId!) },
    ]);
    const audit = await AuditModel.findOne({ action: 'assessment.submitted', entityId: id }).lean();
    expect(audit).toMatchObject({ entity: 'assessment', actorUserId: null });
    expect(idString(audit!.orgId!)).toBe(acoA());
    expect(audit!.after).toMatchObject({ kind: 'CUSTOMER', surveyType: 'DOMESTIC', answeredCount: 4, questionCount: 4 });

    await expect(submit(link, id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(patchAnswers(id, [{ questionId: domestic.q['Q.OPT']!, rating: 1 }])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await getDraft(id)).status).toBe('SUBMITTED');
    expect(submitted).toHaveLength(1);
  });

  it('a failing listener rolls the submit back', async () => {
    const other = (await getOrCreateForInvitation(invitation(cbCustomerA, acoA()))).id;
    await patchAnswers(other, [
      { questionId: domestic.q['Q.OPT']!, rating: 4 },
      { questionId: domestic.q['Q.REQ']!, rating: 4, comment: 'fine' },
      { questionId: domestic.q['Q.NONE']!, rating: 3 },
      { questionId: domestic.q['Q.PLAIN']!, rating: 3 },
    ]);
    on('assessment.submitted', 'test.failing', async () => {
      throw new Error('listener down');
    });
    const link = { audience: 'participant' as const, subject: 'inv', claims: { asg: other }, expiresAt: new Date(Date.now() + 60_000) };
    try {
      await expect(submit(link, other)).rejects.toThrow('listener down');
    } finally {
      clearEventHandlers();
      on('assessment.submitted', 'test.recordSubmitted', async (payload) => {
        submitted.push(payload);
      });
    }
    expect((await getDraft(other)).status).toBe('DRAFT');
  });

  it('listSubmitted returns SUBMITTED assessments of the operator in the cycle, optionally by kind, in the engine shape', async () => {
    const rows = await listSubmitted(cycle.id, acoA());
    expect(rows.map((row) => row.id)).toEqual([id]);
    expect(rows[0]).toMatchObject({ kind: 'CUSTOMER', customerType: 'FF', surveyType: 'DOMESTIC', customerId: ffCustomerA });
    expect(rows[0]!.answers).toHaveLength(4);
    expect(rows[0]!.answers.find((answer) => answer.questionId === domestic.q['Q.LOW'])).toMatchObject({ rating: 2, na: false, followUp: ['Long delay'] });
    expect(await listSubmitted(cycle.id, acoA(), 'SELF')).toEqual([]);
    expect(await listSubmitted(cycle.id, idString(adminB.org._id))).toEqual([]);
  });
});

describe('self assessment', () => {
  const path = () => `/api/v1/assessments/self/${cycle.id}/DOMESTIC`;
  let selfId: string;

  it('ACO_USER opens the self-assessment (created on first access) with every active question and no answers', async () => {
    const res = await userA.get(path());
    expect(res.status).toBe(200);
    selfId = res.body.data.assessment.id;
    expect(res.body.data.assessment).toMatchObject({
      kind: 'SELF',
      surveyType: 'DOMESTIC',
      surveyId: domestic.id,
      acoId: idString(userA.org._id),
      customerType: null,
      invitationId: null,
      userId: idString(userA.user._id),
      status: 'DRAFT',
      progress: { answered: 0, total: 5, pct: 0 },
    });
    expect(res.body.data).toMatchObject({ stakeholderType: null, questionCount: 5, answers: [], progress: { answered: 0, total: 5, pct: 0 } });
    expect(res.body.data.scale).toHaveLength(5);
    const codes = (res.body.data.categories as { questions: { code: string }[]; subcategories: { questions: { code: string }[] }[] }[]).flatMap((c) => [
      ...c.questions.map((q) => q.code),
      ...c.subcategories.flatMap((s) => s.questions.map((q) => q.code)),
    ]);
    expect(codes).toEqual(['Q.LOW', 'Q.OPT', 'Q.REQ', 'Q.NONE', 'Q.PLAIN']);
    const again = await adminA.get(path());
    expect(again.body.data.assessment.id).toBe(selfId);
    expect((await getOrCreateSelf(ctxOf(adminA), cycle.id, 'DOMESTIC')).id).toBe(selfId);
    expect(await AssessmentModel.countDocuments({ kind: 'SELF', acoId: userA.org._id })).toBe(1);
  });

  it('saves answers through PATCH (validated at the edge and against the form) and submits only when complete', async () => {
    expectError(await userA.patch(`${path()}/answers`).send({ answers: [{ questionId: domestic.q['Q.OPT'], rating: 7 }] }), 400, 'VALIDATION');
    expectError(await userA.patch(`${path()}/answers`).send({ answers: [{ questionId: domestic.q['Q.OPT'], rating: 4, extra: 1 }] }), 400, 'VALIDATION');
    const bad = await userA.patch(`${path()}/answers`).send({ answers: [{ questionId: domestic.q['Q.REQ'], rating: 4 }] });
    expect(expectError(bad, 400, 'VALIDATION').details).toMatchObject({ issues: [{ path: 'answers.0.comment' }] });

    const saved = await userA.patch(`${path()}/answers`).send({
      answers: [
        { questionId: domestic.q['Q.OPT'], rating: 4 },
        { questionId: domestic.q['Q.REQ'], rating: 3, comment: 'Needs work' },
        { questionId: domestic.q['Q.NONE'], na: true },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ answered: 3, total: 5, pct: 60 });

    expectError(await userA.post(`${path()}/submit`), 412, 'PRECONDITION_FAILED');
    await userA.patch(`${path()}/answers`).send({
      answers: [
        { questionId: domestic.q['Q.LOW'], rating: 5 },
        { questionId: domestic.q['Q.PLAIN'], rating: 2 },
      ],
    });
    const done = await userA.post(`${path()}/submit`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ id: selfId, status: 'SUBMITTED', progress: { answered: 5, total: 5, pct: 100 } });
    expect(submitted.at(-1)).toEqual({ assessmentId: selfId, cycleId: cycle.id, acoId: idString(userA.org._id), kind: 'SELF', surveyType: 'DOMESTIC' });
    const audit = await AuditModel.findOne({ action: 'assessment.submitted', entityId: selfId }).lean();
    expect(audit?.actorEmail).toBe(userA.user.email);
    expect(idString(audit!.orgId!)).toBe(idString(userA.org._id));

    expectError(await userA.patch(`${path()}/answers`).send({ answers: [{ questionId: domestic.q['Q.OPT'], rating: 1 }] }), 412, 'PRECONDITION_FAILED');
    expectError(await userA.post(`${path()}/submit`), 412, 'PRECONDITION_FAILED');
    const after = await userA.get(path());
    expect(after.body.data.answers).toHaveLength(5);
    expect(after.body.data.assessment.status).toBe('SUBMITTED');
  });

  it('is gated by the task, the ACO scope, the participant survey types and the cycle status', async () => {
    expectError(await superAdmin.get(path()), 403, 'FORBIDDEN');
    const viewer = await t.asUser({ orgType: 'AIRPORT', roleCode: 'AIRPORT_VIEWER', orgCode: 'AIRPORT-DEL', airportIata: 'DEL' });
    expectError(await viewer.get(path()), 403, 'FORBIDDEN');
    // ACO-B takes part in DOMESTIC only.
    expectError(await adminB.get(`/api/v1/assessments/self/${cycle.id}/INTERNATIONAL`), 412, 'PRECONDITION_FAILED');
    expect((await adminB.get(`/api/v1/assessments/self/${cycle.id}/DOMESTIC`)).status).toBe(200);
    expectError(await adminB.get(`/api/v1/assessments/self/${cycle.id}/BOTH`), 400, 'VALIDATION');
    // A cycle the operator is not part of is 404.
    const elsewhere = await createTestCycle({
      code: 'ELSEWHERE',
      type: 'DOMESTIC',
      status: 'ASSESSMENT_OPEN',
      surveyVersions: { DOMESTIC: domestic.id, INTERNATIONAL: null },
      participants: [{ org: adminB.org, surveyTypes: ['DOMESTIC'] }],
    });
    expectError(await adminA.get(`/api/v1/assessments/self/${elsewhere.id}/DOMESTIC`), 404, 'NOT_FOUND');
    expectError(await adminA.get(`/api/v1/assessments/self/${idString(newId())}/DOMESTIC`), 404, 'NOT_FOUND');
    // Only while the cycle is between SAMPLING_OPEN and ASSESSMENT_OPEN (a DRAFT cycle is not even visible to an operator).
    for (const status of ['PUBLISHED', 'ASSESSMENT_CLOSED', 'SCORED', 'ARCHIVED'] as const) {
      await setTestCycleStatus(cycle.id, status);
      expectError(await adminA.get(`/api/v1/assessments/self/${cycle.id}/INTERNATIONAL`), 412, 'PRECONDITION_FAILED');
    }
    await setTestCycleStatus(cycle.id, 'DRAFT');
    expectError(await adminA.get(`/api/v1/assessments/self/${cycle.id}/INTERNATIONAL`), 404, 'NOT_FOUND');
    for (const status of ['SAMPLING_OPEN', 'SAMPLING_CLOSED'] as const) {
      await setTestCycleStatus(cycle.id, status);
      expect((await adminA.get(`/api/v1/assessments/self/${cycle.id}/INTERNATIONAL`)).status).toBe(200);
    }
    await setTestCycleStatus(cycle.id, 'ASSESSMENT_OPEN');
  });
});

describe('history, masking, tenancy and export', () => {
  let submittedB: string;

  beforeAll(async () => {
    const b = await getOrCreateForInvitation(invitation(customerB, idString(adminB.org._id)));
    submittedB = b.id;
    await patchAnswers(submittedB, [
      { questionId: domestic.q['Q.OPT']!, rating: 5 },
      { questionId: domestic.q['Q.REQ']!, rating: 4, comment: 'Good' },
      { questionId: domestic.q['Q.LOW']!, na: true },
      { questionId: domestic.q['Q.PLAIN']!, rating: 4 },
    ]);
    await submit({ audience: 'participant', subject: 'inv', claims: {}, expiresAt: new Date(Date.now() + 60_000) }, submittedB);
  });

  it('PLATFORM lists every assessment with full identity, filters and a 1 dp own score', async () => {
    const all = await superAdmin.get('/api/v1/assessments?sort=startedAt&pageSize=50');
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(await AssessmentModel.countDocuments());
    const row = (all.body.data as { id: string; cycle: { code: string }; operator: { code: string }; assessorName: string; assessor: { revealed: boolean; email: string }; customerId: string; score: number }[]).find((r) => r.id === submittedB)!;
    expect(row).toMatchObject({
      cycle: { id: cycle.id, code: 'CSQ-2026-1', name: 'Cycle CSQ-2026-1' },
      operator: { code: 'ACO-B' },
      kind: 'CUSTOMER',
      surveyType: 'DOMESTIC',
      customerType: 'FF',
      customerId: customerB,
      assessorName: 'Dev Patel',
      assessorEmailMasked: 'd***@bombayfreight.test',
      assessor: { name: 'Dev Patel', email: 'dev@bombayfreight.test', revealed: true },
      status: 'SUBMITTED',
      progress: { answered: 4, total: 4, pct: 100 },
      score: 4.3,
    });
    expect(typeof row.score).toBe('number');

    const byStatus = await superAdmin.get('/api/v1/assessments?status=SUBMITTED');
    expect((byStatus.body.data as { status: string }[]).every((r) => r.status === 'SUBMITTED')).toBe(true);
    expect(byStatus.body.meta.total).toBe(3);
    const selfOnly = await superAdmin.get(`/api/v1/assessments?kind=SELF&cycleId=${cycle.id}`);
    expect((selfOnly.body.data as { kind: string }[]).map((r) => r.kind)).toEqual(['SELF', 'SELF', 'SELF']);
    const cb = await superAdmin.get('/api/v1/assessments?customerType=CB');
    expect(cb.body.meta.total).toBeGreaterThan(0);
    expect((cb.body.data as { customerType: string }[]).every((r) => r.customerType === 'CB')).toBe(true);
    const intl = await superAdmin.get('/api/v1/assessments?surveyType=INTERNATIONAL');
    // The CB customer's INTERNATIONAL assessment and ACO-A's INTERNATIONAL self-assessment.
    expect(intl.body.meta.total).toBe(2);
    expect((intl.body.data as { surveyType: string }[]).every((r) => r.surveyType === 'INTERNATIONAL')).toBe(true);
    const acoB = await superAdmin.get(`/api/v1/assessments?acoId=${idString(adminB.org._id)}`);
    expect(acoB.body.meta.total).toBe(2);
    expect((acoB.body.data as { operator: { code: string } }[]).every((r) => r.operator.code === 'ACO-B')).toBe(true);
    expectError(await superAdmin.get('/api/v1/assessments?sort=answers'), 400, 'VALIDATION');
  });

  it('an operator sees its own rows with the assessor masked until the setting reveals identities; its own self-assessment is never masked', async () => {
    const mine = await adminB.get('/api/v1/assessments');
    expect(mine.status).toBe(200);
    expect(mine.body.meta.total).toBe(2);
    expect((mine.body.data as { operator: { code: string } }[]).every((r) => r.operator.code === 'ACO-B')).toBe(true);
    const customer = (mine.body.data as { kind: string; assessorName: string; assessorEmailMasked: string; customerId: string | null; assessor: { name: string; email: string | null; revealed: boolean } }[]).find((r) => r.kind === 'CUSTOMER')!;
    expect(customer).toMatchObject({
      assessorName: 'D*** P***',
      assessorEmailMasked: 'd***@bombayfreight.test',
      customerId: null,
      assessor: { name: 'D*** P***', email: 'd***@bombayfreight.test', revealed: false },
    });
    const self = (mine.body.data as { kind: string; assessorName: string; assessor: { revealed: boolean } }[]).find((r) => r.kind === 'SELF')!;
    expect(self).toMatchObject({ assessorName: adminB.user.name, assessor: { revealed: true } });

    const one = await adminB.get(`/api/v1/assessments/${submittedB}`);
    expect(one.status).toBe(200);
    expect(one.body.data.assessor.revealed).toBe(false);
    expect(one.body.data.survey).toEqual({ id: domestic.id, code: 'DOMESTIC', name: 'DOMESTIC test survey', version: 1, status: 'PUBLISHED' });
    expect(one.body.data.answers).toEqual([
      expect.objectContaining({ code: 'Q.LOW', text: 'Question Q.LOW', category: expect.objectContaining({ code: 'INFRA' }), subcategory: null, rating: null, na: true }),
      expect.objectContaining({ code: 'Q.OPT', subcategory: expect.objectContaining({ code: 'STORAGE' }), rating: 5, na: false }),
      expect.objectContaining({ code: 'Q.REQ', rating: 4, comment: 'Good' }),
      expect.objectContaining({ code: 'Q.PLAIN', category: expect.objectContaining({ code: 'PROC' }), rating: 4 }),
    ]);

    expect((await superAdmin.patch('/api/v1/settings').send({ revealAssessorIdentity: true })).status).toBe(200);
    try {
      const revealed = await adminB.get(`/api/v1/assessments/${submittedB}`);
      expect(revealed.body.data).toMatchObject({ assessorName: 'Dev Patel', customerId: customerB, assessor: { email: 'dev@bombayfreight.test', revealed: true } });
    } finally {
      await superAdmin.patch('/api/v1/settings').send({ revealAssessorIdentity: false });
    }
  });

  it('cross-tenant reads are 404; an airport organisation granted the task sees the operators at its airport', async () => {
    expectError(await adminA.get(`/api/v1/assessments/${submittedB}`), 404, 'NOT_FOUND');
    expectError(await adminA.get(`/api/v1/assessments/${idString(newId())}`), 404, 'NOT_FOUND');
    expectError(await adminA.get('/api/v1/assessments/nope'), 400, 'VALIDATION');
    const listA = await adminA.get(`/api/v1/assessments?acoId=${idString(adminB.org._id)}`);
    expect(listA.body.meta.total).toBe(0);
    expect((await userA.get('/api/v1/assessments')).status).toBe(403);
    expect((await t.anon.get('/api/v1/assessments')).status).toBe(401);

    await grantTasks('AIRPORT_VIEWER', ['assessments.view']);
    const viewer = await t.asUser({ orgType: 'AIRPORT', roleCode: 'AIRPORT_VIEWER', orgCode: 'AIRPORT-DEL', airportIata: 'DEL' });
    const atDel = await viewer.get('/api/v1/assessments');
    expect(atDel.status).toBe(200);
    expect(atDel.body.meta.total).toBeGreaterThan(0);
    const rows = atDel.body.data as { operator: { code: string }; kind: string; assessor: { revealed: boolean } }[];
    expect(rows.every((r) => r.operator.code === 'ACO-A')).toBe(true);
    // Not a platform role: customer identities stay masked for the airport too.
    expect(rows.filter((r) => r.kind === 'CUSTOMER').every((r) => !r.assessor.revealed)).toBe(true);
    expectError(await viewer.get(`/api/v1/assessments/${submittedB}`), 404, 'NOT_FOUND');
  });

  it('exports a cycle as CSV, one line per assessment and form question, within scope', async () => {
    const res = await superAdmin.get(`/api/v1/assessments/export?cycleId=${cycle.id}&status=SUBMITTED`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('assessments-CSQ-2026-1.csv');
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('assessmentId,cycle,operator,kind,surveyType,customerType,assessorName,assessorEmail,status,submittedAt,score,category,subcategory,questionCode,question,rating,na,comment,followUp');
    // Three SUBMITTED assessments: FF customer (4 questions) + SELF (5) of ACO-A, FF customer (4) of ACO-B.
    expect(lines).toHaveLength(1 + 4 + 5 + 4);
    expect(lines.find((line) => line.includes(submittedB) && line.includes('Q.REQ'))).toContain('Dev Patel,dev@bombayfreight.test,SUBMITTED');

    const mine = await adminB.get(`/api/v1/assessments/export?cycleId=${cycle.id}`);
    const myLines = mine.text.trim().split('\n').slice(1);
    expect(myLines).toHaveLength(4 + 5);
    expect(myLines.every((line) => line.includes(',ACO-B,'))).toBe(true);
    expect(myLines.find((line) => line.includes('Q.REQ') && line.includes('CUSTOMER'))).toContain('D*** P***,d***@bombayfreight.test');
    expectError(await superAdmin.get('/api/v1/assessments/export'), 400, 'VALIDATION');
    expectError(await adminB.get(`/api/v1/assessments/export?cycleId=${idString(newId())}`), 404, 'NOT_FOUND');
  });
});
