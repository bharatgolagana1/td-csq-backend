// The surveys part of the flow: a platform admin starts a survey type from
// nothing, builds a version through the API, publishes it, and the modules
// above (cycles, assessments) consume it through the exported functions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QuestionModel } from '../src/modules/surveys/questions.model.js';
import {
  getFormForStakeholder,
  getPublishedSurvey,
  getSurveyTree,
  latestPublishedVersionIds,
} from '../src/modules/surveys/surveys.service.js';
import { seedSurveys } from '../src/seed/surveys.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { expectError } from './helpers/fixtures.js';

let t: TestApp;
let admin: TestUser;
let surveyId: string;

beforeAll(async () => {
  t = await createTestApp({ airports: false });
  admin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
});
afterAll(() => t.close());

describe('from nothing to a published survey', () => {
  it('starts with both types listed and nothing published', async () => {
    const res = await admin.get('/api/v1/surveys');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { code: 'DOMESTIC', name: 'Domestic Cargo Service Quality Survey', publishedVersionId: null, draftVersionId: null, versions: [] },
      { code: 'INTERNATIONAL', name: 'International Cargo Service Quality Survey', publishedVersionId: null, draftVersionId: null, versions: [] },
    ]);
    expect(await getPublishedSurvey('INTERNATIONAL')).toBeNull();
    expect(await latestPublishedVersionIds()).toEqual({});
  });

  it('POST /surveys/INTERNATIONAL/versions starts an empty v1 draft that cannot be published yet', async () => {
    const res = await admin.post('/api/v1/surveys/INTERNATIONAL/versions').send({ name: 'International CSQ' });
    expect(res.status).toBe(201);
    surveyId = res.body.data.survey.id;
    expect(res.body.data.survey).toMatchObject({ code: 'INTERNATIONAL', name: 'International CSQ', version: 1, status: 'DRAFT' });
    expect(res.body.data.categories).toEqual([]);
    expect(res.body.data.issues).toEqual([{ path: 'categories', message: 'A survey needs at least one category' }]);
    const refused = expectError(await admin.post(`/api/v1/surveys/${surveyId}/publish`), 412, 'PRECONDITION_FAILED');
    expect(refused.message).toBe('Survey is not ready to publish');
  });

  it('builds category → subcategory → questions, with a category needing an active question first', async () => {
    const base = `/api/v1/surveys/${surveyId}`;
    const cargo = await admin.post(`${base}/categories`).send({ code: 'CARGO', name: 'Cargo handling', weightPct: 60 });
    expect(cargo.status).toBe(201);
    // One weighted category on its own is "all siblings weighted" with a total of 60.
    const tree = await admin.get(base);
    expect(tree.body.data.issues).toEqual([
      { path: 'questions', message: 'A survey needs at least one active question' },
      { path: 'categories', message: 'categories weights must total 100 (got 60)' },
    ]);

    const service = await admin.post(`${base}/categories`).send({ code: 'SERVICE', name: 'Service attitude', weightPct: 40 });
    expect(service.status).toBe(201);
    expect((await admin.get(base)).body.data.issues).toEqual([{ path: 'questions', message: 'A survey needs at least one active question' }]);
    const accept = await admin.post(`${base}/subcategories`).send({ categoryId: cargo.body.data.id, code: 'ACCEPT', name: 'Shipment acceptance' });
    expect(accept.status).toBe(201);
    const questions = [
      { categoryId: cargo.body.data.id, subcategoryId: accept.body.data.id, code: 'CARGO.ACCEPT.SPEED', text: 'Speed of acceptance', commentMode: 'REQUIRED_ON_LOW' },
      { categoryId: cargo.body.data.id, subcategoryId: accept.body.data.id, code: 'CARGO.ACCEPT.PAPERWORK', text: 'Acceptance paperwork', stakeholderTypes: ['FF'] },
      { categoryId: cargo.body.data.id, code: 'CARGO.STORAGE', text: 'Storage adequacy', mandatory: false, commentMode: 'NONE' },
      { categoryId: service.body.data.id, code: 'SERVICE.ATTITUDE', text: 'Attitude of personnel', followUp: { prompt: 'What went wrong?', options: ['Rude', 'Slow', 'Absent'] } },
    ];
    for (const question of questions) {
      expect((await admin.post(`${base}/questions`).send(question)).status).toBe(201);
    }
    expect((await admin.get(base)).body.data.issues).toEqual([]);
  });

  it('publishes; the exported functions then serve it to cycles and assessments', async () => {
    const published = await admin.post(`/api/v1/surveys/${surveyId}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.data).toMatchObject({ id: surveyId, status: 'PUBLISHED', version: 1 });

    expect((await getPublishedSurvey('INTERNATIONAL'))?.id).toBe(surveyId);
    expect(await latestPublishedVersionIds()).toEqual({ INTERNATIONAL: surveyId });

    const tree = await getSurveyTree(surveyId);
    expect(tree.survey.status).toBe('PUBLISHED');
    expect(tree.categories.map((category) => `${category.code}:${category.weightPct}`)).toEqual(['CARGO:60', 'SERVICE:40']);
    expect(tree.categories[0]!.subcategories[0]!.questions.map((question) => question.code)).toEqual(['CARGO.ACCEPT.SPEED', 'CARGO.ACCEPT.PAPERWORK']);
    expect(tree.categories[0]!.questions.map((question) => question.code)).toEqual(['CARGO.STORAGE']);

    const cb = await getFormForStakeholder(surveyId, 'CB');
    expect(cb.questionCount).toBe(3);
    expect(cb.categories.map((category) => category.code)).toEqual(['CARGO', 'SERVICE']);
    expect(cb.categories[0]!.subcategories[0]!.questions.map((question) => question.code)).toEqual(['CARGO.ACCEPT.SPEED']);
    expect(cb.categories[0]!.questions[0]).toMatchObject({ code: 'CARGO.STORAGE', mandatory: false, commentMode: 'NONE', followUp: null });
    expect(cb.categories[1]!.questions[0]!.followUp).toEqual({ prompt: 'What went wrong?', options: ['Rude', 'Slow', 'Absent'] });
    const ff = await getFormForStakeholder(surveyId, 'FF');
    expect(ff.questionCount).toBe(4);

    expectError(await admin.post(`/api/v1/surveys/${surveyId}/questions`).send({ categoryId: tree.categories[0]!.id, code: 'LATE', text: 'x' }), 412, 'PRECONDITION_FAILED');
  });

  it('the seed then fills only the type that has no version', async () => {
    const result = await seedSurveys();
    expect(result.INTERNATIONAL).toMatchObject({ id: surveyId, created: false, version: 1, status: 'PUBLISHED', questions: 4 });
    expect(result.DOMESTIC).toMatchObject({ created: true, version: 1, status: 'PUBLISHED', questions: 23 });
    expect(await QuestionModel.countDocuments()).toBe(27);
    expect(await latestPublishedVersionIds()).toEqual({ DOMESTIC: result.DOMESTIC.id, INTERNATIONAL: surveyId });
  });
});
