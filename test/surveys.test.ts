import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idString } from '../src/core/ids.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { CategoryModel } from '../src/modules/surveys/categories.model.js';
import { QuestionModel } from '../src/modules/surveys/questions.model.js';
import { SubcategoryModel } from '../src/modules/surveys/subcategories.model.js';
import { bankQuestionsFor, loadSurveyBank, type BankQuestionForType } from '../src/modules/surveys/surveys.bank.js';
import { SurveyModel } from '../src/modules/surveys/surveys.model.js';
import {
  getFormForStakeholder,
  getPublishedSurvey,
  getSurveyTree,
  latestPublishedVersionIds,
} from '../src/modules/surveys/surveys.service.js';
import { seedSurveys, type SeedSurveysResult } from '../src/seed/surveys.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { expectError } from './helpers/fixtures.js';

let t: TestApp;
let superAdmin: TestUser;
let analyst: TestUser;
let seeded: SeedSurveysResult;
let domesticV1: string;
let internationalV1: string;

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  analyst = await t.asUser({ orgType: 'ACFI', roleCode: 'ACFI_ANALYST' });
  seeded = await seedSurveys();
  domesticV1 = seeded.DOMESTIC.id;
  internationalV1 = seeded.INTERNATIONAL.id;
});
afterAll(() => t.close());

const INTERNATIONAL_ONLY = [
  'ACFI.PROC.CUSTOMS_EDI_SWIFT_CONNECTIVITY',
  'ACFI.PROC.UNCLEARED_CARGO_DISPOSAL',
  'ACFI.TRADE.CUSTOMS_OFFICER_AVAILABILITY',
  'ACFI.TRADE.AIRLINE_PGA_OFFICES',
];

describe('bank', () => {
  it('loads 27 parameters under four heads; 23 are domestic; the domestic wording wins where the forms differ', async () => {
    const bank = await loadSurveyBank();
    expect(bank.heads.map((head) => head.code)).toEqual(['INFRA', 'SEC', 'PROC', 'TRADE']);
    expect(bank.questions).toHaveLength(27);
    const domestic = bankQuestionsFor(bank, 'DOMESTIC');
    const international = bankQuestionsFor(bank, 'INTERNATIONAL');
    expect(domestic).toHaveLength(23);
    expect(international).toHaveLength(27);
    const text = (list: BankQuestionForType[], code: string) => list.find((question) => question.code === code)!.text;
    expect(text(domestic, 'ACFI.INFRA.TC_BC_GENERATION')).toContain('cargo holding area/staging area');
    expect(text(international, 'ACFI.INFRA.TC_BC_GENERATION')).toContain('Truck Dock');
    expect(text(domestic, 'ACFI.INFRA.CARGO_STORAGE_CAPACITY')).toBe(text(international, 'ACFI.INFRA.CARGO_STORAGE_CAPACITY'));
    const domesticCodes = new Set(domestic.map((question) => question.code));
    expect(international.map((question) => question.code).filter((code) => !domesticCodes.has(code))).toEqual(INTERNATIONAL_ONLY);
  });
});

describe('seed', () => {
  it('creates v1 PUBLISHED per type: four heads in order, no subcategories, 23 / 27 questions with the seed defaults', async () => {
    expect(seeded.DOMESTIC).toMatchObject({ created: true, version: 1, status: 'PUBLISHED', questions: 23 });
    expect(seeded.INTERNATIONAL).toMatchObject({ created: true, version: 1, status: 'PUBLISHED', questions: 27 });

    const tree = await getSurveyTree(domesticV1);
    expect(tree.survey).toMatchObject({ code: 'DOMESTIC', version: 1, status: 'PUBLISHED', name: 'Domestic Cargo Service Quality Survey' });
    expect(tree.survey.publishedAt).toBeTruthy();
    expect(tree.issues).toEqual([]);
    expect(tree.categories.map((category) => [category.code, category.name, category.order, category.weightPct])).toEqual([
      ['INFRA', 'Infrastructure and facilities', 10, null],
      ['SEC', 'Security and safety', 20, null],
      ['PROC', 'Processes', 30, null],
      ['TRADE', 'Trade facilitation', 40, null],
    ]);
    expect(tree.categories.every((category) => category.subcategories.length === 0)).toBe(true);
    expect(tree.categories.map((category) => category.questions.length)).toEqual([8, 6, 5, 4]);
    expect(tree.categories.flatMap((category) => category.questions.map((question) => question.code))).not.toEqual(
      expect.arrayContaining(INTERNATIONAL_ONLY),
    );

    const first = tree.categories[0]!.questions[0]!;
    expect(first).toMatchObject({
      code: 'ACFI.INFRA.CARGO_STORAGE_CAPACITY',
      categoryId: tree.categories[0]!.id,
      subcategoryId: null,
      order: 1,
      help: null,
      weightPct: null,
      mandatory: true,
      commentMode: 'REQUIRED_ON_LOW',
      stakeholderTypes: ['FF', 'CB'],
      active: true,
    });
    expect(first.text).toContain('Availability of adequate cargo infrastructure');
    expect(first.followUp?.prompt).toBe('What specifically went wrong?');
    expect(first.followUp?.options.length).toBeGreaterThanOrEqual(4);
    expect(tree.categories[1]!.questions.map((question) => question.order)).toEqual([1, 2, 3, 4, 5, 6]);

    const international = await getSurveyTree(internationalV1);
    expect(international.survey).toMatchObject({ code: 'INTERNATIONAL', version: 1, status: 'PUBLISHED' });
    expect(international.categories.map((category) => category.questions.length)).toEqual([8, 6, 7, 6]);
    expect(international.categories.flatMap((category) => category.questions.map((question) => question.code))).toEqual(
      expect.arrayContaining(INTERNATIONAL_ONLY),
    );
  });

  it('is idempotent: a second run keeps everything as it is', async () => {
    const again = await seedSurveys();
    expect(again.DOMESTIC).toMatchObject({ id: domesticV1, created: false, version: 1, status: 'PUBLISHED', questions: 23 });
    expect(again.INTERNATIONAL).toMatchObject({ id: internationalV1, created: false, version: 1, status: 'PUBLISHED', questions: 27 });
    expect(await SurveyModel.countDocuments()).toBe(2);
    expect(await CategoryModel.countDocuments()).toBe(8);
    expect(await SubcategoryModel.countDocuments()).toBe(0);
    expect(await QuestionModel.countDocuments()).toBe(50);
  });
});

describe('exported functions', () => {
  it('getPublishedSurvey, latestPublishedVersionIds and getSurveyTree', async () => {
    expect(await getPublishedSurvey('DOMESTIC')).toMatchObject({ id: domesticV1, code: 'DOMESTIC', version: 1, status: 'PUBLISHED' });
    expect(await latestPublishedVersionIds()).toEqual({ DOMESTIC: domesticV1, INTERNATIONAL: internationalV1 });
    await expect(getSurveyTree('0123456789abcdef01234567')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getFormForStakeholder('0123456789abcdef01234567', 'FF')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('getFormForStakeholder returns the ordered form with the scale, the count and no editor-only fields', async () => {
    const form = await getFormForStakeholder(internationalV1, 'CB');
    expect(form.survey).toEqual({
      id: internationalV1,
      code: 'INTERNATIONAL',
      name: 'International Cargo Service Quality Survey',
      version: 1,
      status: 'PUBLISHED',
    });
    expect(form.stakeholderType).toBe('CB');
    expect(form.questionCount).toBe(27);
    expect(form.scale.map((step) => `${step.value}:${step.label}`)).toEqual(['1:Poor', '2:Fair', '3:Good', '4:Very Good', '5:Excellent']);
    expect(form.categories.map((category) => category.code)).toEqual(['INFRA', 'SEC', 'PROC', 'TRADE']);
    expect(form.categories.map((category) => category.questions.length)).toEqual([8, 6, 7, 6]);
    const question = form.categories[2]!.questions[3]!;
    expect(question.code).toBe('ACFI.PROC.CUSTOMS_EDI_SWIFT_CONNECTIVITY');
    expect(question).toMatchObject({ mandatory: true, commentMode: 'REQUIRED_ON_LOW', subcategoryId: null });
    expect(question.followUp?.options).toContain('Other');
    expect(question).not.toHaveProperty('stakeholderTypes');
    expect(question).not.toHaveProperty('active');
  });
});

describe('GET /surveys', () => {
  it('lists both types with their versions; view task only; unknown id is 404, malformed 400', async () => {
    const res = await analyst.get('/api/v1/surveys');
    expect(res.status).toBe(200);
    expect(res.body.data.map((entry: { code: string }) => entry.code)).toEqual(['DOMESTIC', 'INTERNATIONAL']);
    expect(res.body.data[0]).toMatchObject({ name: 'Domestic Cargo Service Quality Survey', publishedVersionId: domesticV1, draftVersionId: null });
    expect(res.body.data[0].versions).toHaveLength(1);
    expect(res.body.data[0].versions[0]).toMatchObject({ id: domesticV1, version: 1, status: 'PUBLISHED', questionCount: 23 });
    expect(res.body.data[1].versions[0]).toMatchObject({ id: internationalV1, questionCount: 27 });

    const tree = await analyst.get(`/api/v1/surveys/${domesticV1}`);
    expect(tree.status).toBe(200);
    expect(tree.body.data.categories).toHaveLength(4);
    expect(tree.body.data.issues).toEqual([]);

    expectError(await analyst.post(`/api/v1/surveys/${domesticV1}/versions`).send({}), 403, 'FORBIDDEN');
    const acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN' });
    expectError(await acoAdmin.get('/api/v1/surveys'), 403, 'FORBIDDEN');
    expectError(await t.anon.get('/api/v1/surveys'), 401, 'UNAUTHENTICATED');
    expectError(await analyst.get('/api/v1/surveys/0123456789abcdef01234567'), 404, 'NOT_FOUND');
    expectError(await analyst.get('/api/v1/surveys/nope'), 400, 'VALIDATION');
  });
});

describe('versions', () => {
  let draftId: string;
  let v3Id: string;

  it('a published version refuses every write with 412 PRECONDITION_FAILED', async () => {
    const tree = await getSurveyTree(domesticV1);
    const category = tree.categories[0]!;
    const question = category.questions[0]!;
    const base = `/api/v1/surveys/${domesticV1}`;
    expectError(await superAdmin.post(`${base}/categories`).send({ code: 'X', name: 'X' }), 412, 'PRECONDITION_FAILED');
    expectError(await superAdmin.patch(`${base}/categories/${category.id}`).send({ name: 'X' }), 412, 'PRECONDITION_FAILED');
    expectError(await superAdmin.delete(`${base}/categories/${category.id}`), 412, 'PRECONDITION_FAILED');
    expectError(await superAdmin.post(`${base}/subcategories`).send({ categoryId: category.id, code: 'X', name: 'X' }), 412, 'PRECONDITION_FAILED');
    expectError(await superAdmin.post(`${base}/questions`).send({ categoryId: category.id, code: 'X', text: 'X' }), 412, 'PRECONDITION_FAILED');
    expectError(await superAdmin.patch(`${base}/questions/${question.id}`).send({ text: 'X' }), 412, 'PRECONDITION_FAILED');
    expectError(await superAdmin.delete(`${base}/questions/${question.id}`), 412, 'PRECONDITION_FAILED');
    expectError(await superAdmin.put(`${base}/order`).send({ categories: [{ id: category.id, order: 1 }] }), 412, 'PRECONDITION_FAILED');
    expectError(await superAdmin.post(`${base}/publish`), 412, 'PRECONDITION_FAILED');
    expect((await getSurveyTree(domesticV1)).categories[0]!.questions[0]!.text).toBe(question.text);
  });

  it('POST /versions deep-copies the latest into a DRAFT v2 with new ids; one draft per type', async () => {
    const res = await superAdmin.post(`/api/v1/surveys/${domesticV1}/versions`).send({});
    expect(res.status).toBe(201);
    draftId = res.body.data.survey.id;
    expect(draftId).not.toBe(domesticV1);
    expect(res.body.data.survey).toMatchObject({ code: 'DOMESTIC', name: 'Domestic Cargo Service Quality Survey', version: 2, status: 'DRAFT', publishedAt: null });
    expect(res.body.data.issues).toEqual([]);

    const v1 = await getSurveyTree(domesticV1);
    const v1Questions = v1.categories.flatMap((category) => category.questions);
    const v2Questions = (res.body.data.categories as typeof v1.categories).flatMap((category) => category.questions);
    expect((res.body.data.categories as typeof v1.categories).map((category) => category.code)).toEqual(v1.categories.map((category) => category.code));
    expect(v2Questions.map((question) => question.code)).toEqual(v1Questions.map((question) => question.code));
    expect(v2Questions.map((question) => [question.text, question.order, question.followUp])).toEqual(
      v1Questions.map((question) => [question.text, question.order, question.followUp]),
    );
    expect(new Set([...v1Questions, ...v2Questions].map((question) => question.id)).size).toBe(46);
    expect(await QuestionModel.countDocuments({ surveyId: draftId })).toBe(23);

    expectError(await superAdmin.post(`/api/v1/surveys/${domesticV1}/versions`).send({}), 409, 'CONFLICT');
    expectError(await superAdmin.post('/api/v1/surveys/DOMESTIC/versions'), 409, 'CONFLICT');
    expectError(await superAdmin.post('/api/v1/surveys/REGIONAL/versions'), 400, 'VALIDATION');

    const list = await superAdmin.get('/api/v1/surveys');
    expect(list.body.data[0]).toMatchObject({ publishedVersionId: domesticV1, draftVersionId: draftId });
    expect(list.body.data[0].versions.map((version: { version: number }) => version.version)).toEqual([2, 1]);
    expect((await getPublishedSurvey('DOMESTIC'))?.id).toBe(domesticV1);
  });

  describe('draft editing', () => {
    let catId: string;
    let subId: string;
    let qId: string;
    let infraId: string;

    it('creates a category (code upper-cased, order appended) and rejects duplicates and bad input', async () => {
      const res = await superAdmin.post(`/api/v1/surveys/${draftId}/categories`).send({ code: 'handling', name: 'Cargo handling' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ code: 'HANDLING', name: 'Cargo handling', order: 41, weightPct: null });
      catId = res.body.data.id;
      expectError(await superAdmin.post(`/api/v1/surveys/${draftId}/categories`).send({ code: 'HANDLING', name: 'Again' }), 409, 'CONFLICT');
      expectError(await superAdmin.post(`/api/v1/surveys/${draftId}/categories`).send({ code: 'bad code!', name: 'x' }), 400, 'VALIDATION');
      expectError(await superAdmin.post(`/api/v1/surveys/${draftId}/categories`).send({ code: 'X', name: 'x', extra: 1 }), 400, 'VALIDATION');
      expectError(await superAdmin.post('/api/v1/surveys/0123456789abcdef01234567/categories').send({ code: 'X', name: 'x' }), 404, 'NOT_FOUND');
    });

    it('creates a subcategory and a question under it; validates the parent chain and codes', async () => {
      const sub = await superAdmin.post(`/api/v1/surveys/${draftId}/subcategories`).send({ categoryId: catId, code: 'ACCEPTANCE', name: 'Shipment acceptance' });
      expect(sub.status).toBe(201);
      expect(sub.body.data).toMatchObject({ categoryId: catId, code: 'ACCEPTANCE', name: 'Shipment acceptance', order: 1 });
      subId = sub.body.data.id;
      const unknownParent = await superAdmin.post(`/api/v1/surveys/${draftId}/subcategories`).send({ categoryId: '0123456789abcdef01234567', code: 'X', name: 'x' });
      expect(expectError(unknownParent, 400, 'VALIDATION').message).toBe('Unknown category');

      const q = await superAdmin.post(`/api/v1/surveys/${draftId}/questions`).send({
        categoryId: catId,
        subcategoryId: subId,
        code: 'ACFI.HANDLING.ACCEPTANCE_EFFICIENCY',
        text: 'How would you rate the efficiency of the cargo acceptance process?',
        followUp: { prompt: 'What went wrong?', options: ['Queue', 'Paperwork'] },
      });
      expect(q.status).toBe(201);
      expect(q.body.data).toMatchObject({
        categoryId: catId,
        subcategoryId: subId,
        code: 'ACFI.HANDLING.ACCEPTANCE_EFFICIENCY',
        order: 1,
        help: null,
        weightPct: null,
        mandatory: true,
        commentMode: 'OPTIONAL',
        stakeholderTypes: ['FF', 'CB'],
        followUp: { prompt: 'What went wrong?', options: ['Queue', 'Paperwork'] },
        active: true,
      });
      qId = q.body.data.id;

      infraId = (await getSurveyTree(draftId)).categories.find((category) => category.code === 'INFRA')!.id;
      const wrongChain = await superAdmin.post(`/api/v1/surveys/${draftId}/questions`).send({ categoryId: infraId, subcategoryId: subId, code: 'X', text: 'x' });
      expect(expectError(wrongChain, 400, 'VALIDATION').message).toContain('does not belong to category INFRA');
      expectError(
        await superAdmin.post(`/api/v1/surveys/${draftId}/questions`).send({ categoryId: infraId, code: 'ACFI.INFRA.CARGO_STORAGE_CAPACITY', text: 'dup' }),
        409,
        'CONFLICT',
      );
      expectError(await superAdmin.post(`/api/v1/surveys/${draftId}/questions`).send({ categoryId: infraId, code: 'X', text: 'x', stakeholderTypes: [] }), 400, 'VALIDATION');
      expectError(await superAdmin.post(`/api/v1/surveys/${draftId}/questions`).send({ categoryId: infraId, code: 'X', text: 'x', stakeholderTypes: ['FF', 'FF'] }), 400, 'VALIDATION');
      expectError(await superAdmin.post(`/api/v1/surveys/${draftId}/questions`).send({ categoryId: infraId, code: 'X', text: 'x', commentMode: 'ALWAYS' }), 400, 'VALIDATION');

      const tree = await superAdmin.get(`/api/v1/surveys/${draftId}`);
      const handling = tree.body.data.categories.at(-1);
      expect(handling.code).toBe('HANDLING');
      expect(handling.questions).toEqual([]);
      expect(handling.subcategories[0].questions.map((question: { id: string }) => question.id)).toEqual([qId]);
    });

    it('patches a question and moves it between parents, validating the chain', async () => {
      const patched = await superAdmin.patch(`/api/v1/surveys/${draftId}/questions/${qId}`).send({
        text: 'Rate the acceptance process',
        stakeholderTypes: ['FF'],
        commentMode: 'REQUIRED',
        help: 'Think of your last five shipments',
      });
      expect(patched.status).toBe(200);
      expect(patched.body.data).toMatchObject({ text: 'Rate the acceptance process', stakeholderTypes: ['FF'], commentMode: 'REQUIRED', help: 'Think of your last five shipments' });

      const moved = await superAdmin.patch(`/api/v1/surveys/${draftId}/questions/${qId}`).send({ categoryId: infraId, subcategoryId: null });
      expect(moved.status).toBe(200);
      expect(moved.body.data).toMatchObject({ categoryId: infraId, subcategoryId: null, order: 9 });

      const inconsistent = await superAdmin.patch(`/api/v1/surveys/${draftId}/questions/${qId}`).send({ subcategoryId: subId });
      expect(expectError(inconsistent, 400, 'VALIDATION').message).toContain('does not belong');

      const back = await superAdmin.patch(`/api/v1/surveys/${draftId}/questions/${qId}`).send({ categoryId: catId, subcategoryId: subId });
      expect(back.body.data).toMatchObject({ categoryId: catId, subcategoryId: subId, order: 1 });
      expectError(await superAdmin.patch(`/api/v1/surveys/${draftId}/questions/0123456789abcdef01234567`).send({ text: 'x' }), 404, 'NOT_FOUND');
      expectError(await superAdmin.patch(`/api/v1/surveys/${draftId}/questions/${qId}`).send({ weightPct: 101 }), 400, 'VALIDATION');

      const renamed = await superAdmin.patch(`/api/v1/surveys/${draftId}/subcategories/${subId}`).send({ name: 'Acceptance' });
      expect(renamed.body.data).toMatchObject({ id: subId, name: 'Acceptance', categoryId: catId });
    });

    it('PUT /order reorders listed nodes and rejects unknown ids, repeats and nodes under the wrong parent', async () => {
      const tree = await getSurveyTree(draftId);
      const infra = tree.categories.find((category) => category.code === 'INFRA')!;
      const sec = tree.categories.find((category) => category.code === 'SEC')!;
      const res = await superAdmin.put(`/api/v1/surveys/${draftId}/order`).send({
        categories: [
          { id: sec.id, order: 1 },
          { id: infra.id, order: 2, questions: infra.questions.map((question, index) => ({ id: question.id, order: infra.questions.length - index })) },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.categories.map((category: { code: string }) => category.code)).toEqual(['SEC', 'INFRA', 'PROC', 'TRADE', 'HANDLING']);
      expect(res.body.data.categories[1].questions.map((question: { code: string }) => question.code)).toEqual(
        infra.questions.map((question) => question.code).reverse(),
      );
      const persisted = (await getSurveyTree(draftId)).categories[1]!.questions;
      expect(persisted.map((question) => question.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(persisted[0]!.code).toBe(infra.questions.at(-1)!.code);

      const issuesOf = (body: unknown) => (expectError(body as never, 400, 'VALIDATION').details as { issues: { message: string }[] }).issues.map((issue) => issue.message);
      expect(issuesOf(await superAdmin.put(`/api/v1/surveys/${draftId}/order`).send({ categories: [{ id: '0123456789abcdef01234567', order: 1 }] }))).toEqual([
        'Unknown category 0123456789abcdef01234567',
      ]);
      expect(issuesOf(await superAdmin.put(`/api/v1/surveys/${draftId}/order`).send({ categories: [{ id: sec.id, order: 1 }, { id: sec.id, order: 2 }] }))[0]).toContain('listed twice');
      expect(
        issuesOf(
          await superAdmin.put(`/api/v1/surveys/${draftId}/order`).send({ categories: [{ id: sec.id, order: 1, questions: [{ id: infra.questions[0]!.id, order: 1 }] }] }),
        )[0],
      ).toContain('is not under this parent');
      expect(issuesOf(await superAdmin.put(`/api/v1/surveys/${draftId}/order`).send({ categories: [{ id: sec.id, order: 1, subcategories: [{ id: subId, order: 1 }] }] }))[0]).toContain(
        'is not under category SEC',
      );
      expectError(await superAdmin.put(`/api/v1/surveys/${draftId}/order`).send({ categories: [] }), 400, 'VALIDATION');
    });

    it('deletes a question, then a category with everything under it', async () => {
      const extra = await superAdmin.post(`/api/v1/surveys/${draftId}/questions`).send({ categoryId: catId, code: 'TMP', text: 'temporary' });
      expect(extra.status).toBe(201);
      expect((await superAdmin.delete(`/api/v1/surveys/${draftId}/questions/${extra.body.data.id}`)).status).toBe(204);
      expectError(await superAdmin.delete(`/api/v1/surveys/${draftId}/questions/${extra.body.data.id}`), 404, 'NOT_FOUND');

      expect((await superAdmin.delete(`/api/v1/surveys/${draftId}/categories/${catId}`)).status).toBe(204);
      expect(await QuestionModel.countDocuments({ _id: qId })).toBe(0);
      expect(await SubcategoryModel.countDocuments({ _id: subId })).toBe(0);
      expect((await getSurveyTree(draftId)).categories.map((category) => category.code)).toEqual(['SEC', 'INFRA', 'PROC', 'TRADE']);
      expectError(await superAdmin.delete(`/api/v1/surveys/${draftId}/subcategories/${subId}`), 404, 'NOT_FOUND');
    });
  });

  describe('weights and publish', () => {
    it('weights are all-or-none and must total 100; the tree reports issues and publish refuses with them', async () => {
      const base = `/api/v1/surveys/${draftId}`;
      const tree = await getSurveyTree(draftId);
      const [sec, infra, proc, trade] = tree.categories as [typeof tree.categories[number], typeof tree.categories[number], typeof tree.categories[number], typeof tree.categories[number]];
      const issuesOf = async () => (await superAdmin.get(base)).body.data.issues as { path: string; message: string }[];
      const setWeight = async (id: string, weightPct: number | null) => {
        const res = await superAdmin.patch(`${base}/categories/${id}`).send({ weightPct });
        expect(res.status).toBe(200);
      };

      await setWeight(sec.id, 40);
      expect(await issuesOf()).toEqual([{ path: 'categories', message: 'weightPct is set on some categories but not on INFRA, PROC, TRADE' }]);
      const refused = expectError(await superAdmin.post(`${base}/publish`), 412, 'PRECONDITION_FAILED');
      expect((refused.details as { issues: unknown[] }).issues).toHaveLength(1);

      await setWeight(infra.id, 20);
      await setWeight(proc.id, 20);
      await setWeight(trade.id, 10);
      expect(await issuesOf()).toEqual([{ path: 'categories', message: 'categories weights must total 100 (got 90)' }]);
      await setWeight(trade.id, 20);
      expect(await issuesOf()).toEqual([]);
      expectError(await superAdmin.patch(`${base}/categories/${trade.id}`).send({ weightPct: 101 }), 400, 'VALIDATION');

      // The same rule holds for questions within a parent; inactive questions do not take part.
      const question = sec.questions[0]!;
      await superAdmin.patch(`${base}/questions/${question.id}`).send({ weightPct: 50 });
      expect((await issuesOf()).map((issue) => issue.path)).toEqual(['categories.SEC.questions']);
      await superAdmin.patch(`${base}/questions/${question.id}`).send({ active: false });
      expect(await issuesOf()).toEqual([]);
      await superAdmin.patch(`${base}/questions/${question.id}`).send({ active: true });
      expect(await issuesOf()).toHaveLength(1);
      await superAdmin.patch(`${base}/questions/${question.id}`).send({ weightPct: null });
      expect(await issuesOf()).toEqual([]);
    });

    it('publishes v2: v1 retired, audited, immutable from then on; exported functions follow', async () => {
      const res = await superAdmin.post(`/api/v1/surveys/${draftId}/publish`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: draftId, code: 'DOMESTIC', version: 2, status: 'PUBLISHED', publishedBy: idString(superAdmin.user._id) });
      expect(res.body.data.publishedAt).toBeTruthy();
      expect((await SurveyModel.findById(domesticV1).lean())?.status).toBe('RETIRED');
      expect((await getPublishedSurvey('DOMESTIC'))?.id).toBe(draftId);
      expect(await latestPublishedVersionIds()).toEqual({ DOMESTIC: draftId, INTERNATIONAL: internationalV1 });

      const audit = await AuditModel.findOne({ action: 'survey.published', entityId: draftId }).lean();
      expect(audit).not.toBeNull();
      expect(idString(audit!.actorUserId!)).toBe(idString(superAdmin.user._id));
      expect((audit!.after as { retired: unknown; questionCount: number })).toMatchObject({ retired: [{ id: domesticV1, version: 1 }], questionCount: 23 });

      expectError(await superAdmin.post(`/api/v1/surveys/${draftId}/publish`), 412, 'PRECONDITION_FAILED');
      expectError(await superAdmin.post(`/api/v1/surveys/${domesticV1}/publish`), 412, 'PRECONDITION_FAILED');
      expectError(await superAdmin.post(`/api/v1/surveys/${draftId}/categories`).send({ code: 'X', name: 'x' }), 412, 'PRECONDITION_FAILED');
      expect((await getSurveyTree(domesticV1)).survey.status).toBe('RETIRED');
      expect((await getSurveyTree(draftId)).issues).toEqual([]);

      const list = await superAdmin.get('/api/v1/surveys');
      expect(list.body.data[0]).toMatchObject({ publishedVersionId: draftId, draftVersionId: null });
      expect(list.body.data[0].versions.map((version: { version: number; status: string }) => `${version.version}:${version.status}`)).toEqual(['2:PUBLISHED', '1:RETIRED']);

      const v3 = await superAdmin.post('/api/v1/surveys/DOMESTIC/versions').send({ name: 'Domestic CSQ v3' });
      expect(v3.status).toBe(201);
      expect(v3.body.data.survey).toMatchObject({ version: 3, status: 'DRAFT', name: 'Domestic CSQ v3' });
      expect(v3.body.data.categories.map((category: { code: string; weightPct: number }) => `${category.code}:${category.weightPct}`)).toEqual(['SEC:40', 'INFRA:20', 'PROC:20', 'TRADE:20']);
      v3Id = v3.body.data.survey.id;
    });
  });

  describe('GET /surveys/:id/preview', () => {
    it('filters by stakeholder type and active flag, drops empty groups, keeps the order', async () => {
      const base = `/api/v1/surveys/${v3Id}`;
      const tree = await getSurveyTree(v3Id);
      const infra = tree.categories.find((category) => category.code === 'INFRA')!;
      const trade = tree.categories.find((category) => category.code === 'TRADE')!;
      await superAdmin.patch(`${base}/questions/${infra.questions[0]!.id}`).send({ stakeholderTypes: ['CB'] });
      await superAdmin.patch(`${base}/questions/${infra.questions[1]!.id}`).send({ active: false });
      await superAdmin.post(`${base}/categories`).send({ code: 'EMPTY', name: 'Nothing here yet' });
      const banks = await superAdmin.post(`${base}/subcategories`).send({ categoryId: trade.id, code: 'BANKS', name: 'Banking' });
      await superAdmin.post(`${base}/questions`).send({ categoryId: trade.id, subcategoryId: banks.body.data.id, code: 'ACFI.TRADE.ATM', text: 'ATM availability', stakeholderTypes: ['FF'] });

      const ff = await analyst.get(`${base}/preview?stakeholderType=FF`);
      expect(ff.status).toBe(200);
      expect(ff.body.data.survey).toEqual({ id: v3Id, code: 'DOMESTIC', name: 'Domestic CSQ v3', version: 3, status: 'DRAFT' });
      expect(ff.body.data).toMatchObject({ stakeholderType: 'FF', questionCount: 22 });
      expect(ff.body.data.categories.map((category: { code: string }) => category.code)).toEqual(['SEC', 'INFRA', 'PROC', 'TRADE']);
      const ffInfra = ff.body.data.categories[1];
      expect(ffInfra.questions).toHaveLength(6);
      expect(ffInfra.questions.map((question: { id: string }) => question.id)).not.toContain(infra.questions[0]!.id);
      expect(ffInfra.questions.map((question: { id: string }) => question.id)).not.toContain(infra.questions[1]!.id);
      // v3 copied v2's reversed INFRA (orders 1..8); orders 1 and 2 are the CB-only and inactive ones.
      expect(ffInfra.questions.map((question: { order: number }) => question.order)).toEqual([3, 4, 5, 6, 7, 8]);
      const ffTrade = ff.body.data.categories[3];
      expect(ffTrade.questions).toHaveLength(4);
      expect(ffTrade.subcategories).toHaveLength(1);
      expect(ffTrade.subcategories[0]).toMatchObject({ code: 'BANKS', questions: [{ code: 'ACFI.TRADE.ATM', mandatory: true }] });
      expect(ffTrade.subcategories[0].questions[0]).not.toHaveProperty('stakeholderTypes');

      const cb = await analyst.get(`${base}/preview?stakeholderType=CB`);
      expect(cb.body.data).toMatchObject({ stakeholderType: 'CB', questionCount: 22 });
      expect(cb.body.data.categories[1].questions).toHaveLength(7);
      expect(cb.body.data.categories[1].questions.map((question: { id: string }) => question.id)).toContain(infra.questions[0]!.id);
      expect(cb.body.data.categories[3].subcategories).toEqual([]);

      expect(ff.body.data).toEqual(await getFormForStakeholder(v3Id, 'FF'));
      expectError(await analyst.get(`${base}/preview`), 400, 'VALIDATION');
      expectError(await analyst.get(`${base}/preview?stakeholderType=ACO`), 400, 'VALIDATION');
      expectError(await analyst.get('/api/v1/surveys/0123456789abcdef01234567/preview?stakeholderType=FF'), 404, 'NOT_FOUND');
    });
  });
});
