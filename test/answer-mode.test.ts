// Import / export answers end to end over the real modules: a SINGLE cycle
// and an IMPORT_EXPORT cycle with the same two operators (DEL, BOM). Covers
// the assessments inheriting the cycle's mode (answers per direction, one
// remark per section whatever the mode, readiness, submit, history), scoring per direction (rows, ranks, airports,
// a mode switch dropping the other direction's rows, assessments of the other
// mode ignored), the reports' direction resolution and the boot migration of
// the score indexes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clearEventHandlers } from '../src/core/events.js';
import { idString, newId, toId } from '../src/core/ids.js';
import type { AnswerInput } from '../src/modules/assessments/assessments.form.js';
import { AssessmentModel } from '../src/modules/assessments/assessments.model.js';
import { getOrCreateForInvitation, getOrCreateSelf, patchAnswers, patchSectionRemarks, readiness, submit } from '../src/modules/assessments/assessments.service.js';
import { CycleModel } from '../src/modules/cycles/cycles.model.js';
import type { OrganisationDoc } from '../src/modules/organisations/organisations.model.js';
import { AirportScoreModel } from '../src/modules/scoring/airport-scores.model.js';
import { migrateScoreDirections } from '../src/modules/scoring/scores.migration.js';
import { ScoreModel } from '../src/modules/scoring/scores.model.js';
import { getScores, nationalTable, runCycle } from '../src/modules/scoring/scoring.service.js';
import { SettingsModel } from '../src/modules/settings/settings.model.js';

import { createTestCustomer, createTestCycle, createTestSurvey, ctxOf, remarkEverySection, type TestCycle, type TestSurvey } from './assessments.fixtures.js';
import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, createTestOperator, expectError, grantTasks, revokeTasks } from './helpers/fixtures.js';

const DAY = 86_400_000;
/** The FF form of `createTestSurvey`, in display order. */
const FF_QUESTIONS = ['Q.LOW', 'Q.OPT', 'Q.REQ', 'Q.PLAIN'] as const;

let t: TestApp;
let superAdmin: TestUser;
let adminA: TestUser;
let survey: TestSurvey;
let opA: OrganisationDoc;
let opB: OrganisationDoc;
let acoA: string;
let acoB: string;
let del: string;
let bom: string;
let customerA: string;
let customerB: string;
let single: TestCycle;
let split: TestCycle;
let splitA: string;

/** Every FF question rated `rating` (with a comment, which Q.REQ and a low Q.LOW need), in one direction or none. */
function answers(rating: number, direction?: 'IMPORT' | 'EXPORT'): AnswerInput[] {
  return FF_QUESTIONS.map((code) => ({ questionId: survey.q[code] ?? code, ...(direction ? { direction } : {}), rating, comment: 'Noted' }));
}

function invitation(cycle: TestCycle, acoId: string, customerId: string) {
  return { _id: newId(), cycleId: cycle.id, acoId, customerId, surveyType: 'DOMESTIC' as const };
}

/** A customer assessment answered, remarked and submitted through the service. */
async function submitCustomer(cycle: TestCycle, acoId: string, customerId: string, batches: AnswerInput[][]): Promise<string> {
  const { id } = await getOrCreateForInvitation(invitation(cycle, acoId, customerId));
  for (const batch of batches) await patchAnswers(id, batch);
  await remarkEverySection(id);
  await submit(ctxOf(superAdmin), id);
  return id;
}

async function overall(cycleId: string, acoId: string, direction: 'SINGLE' | 'IMPORT' | 'EXPORT') {
  return (await getScores(cycleId, acoId, 'DOMESTIC', direction)).rows.find((row) => row.level === 'OVERALL');
}

beforeAll(async () => {
  t = await createTestApp();
  // Statuses are set by hand here; no listener should move them.
  clearEventHandlers();
  await SettingsModel.updateOne({ key: 'global' }, { $set: { 'scoring.minResponses': 1 } });
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  [del, bom] = await Promise.all([airportIdByIata('DEL'), airportIdByIata('BOM')]);
  opA = await createTestOperator({ code: 'IE-A', airportIata: 'DEL' });
  opB = await createTestOperator({ code: 'IE-B', airportIata: 'BOM' });
  acoA = idString(opA._id);
  acoB = idString(opB._id);
  adminA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: acoA });
  survey = await createTestSurvey('DOMESTIC');
  customerA = await createTestCustomer({ acoId: acoA, airportId: del, name: 'Delhi Forwarders', contactPerson: 'Asha', email: 'asha@delfwd.test', type: 'FF' });
  customerB = await createTestCustomer({ acoId: acoB, airportId: bom, name: 'Bombay Forwarders', contactPerson: 'Dev', email: 'dev@bomfwd.test', type: 'FF' });
  const participants = [
    { org: opA, surveyTypes: ['DOMESTIC' as const] },
    { org: opB, surveyTypes: ['DOMESTIC' as const] },
  ];
  const surveyVersions = { DOMESTIC: survey.id, INTERNATIONAL: null };

  // The earlier, SINGLE cycle: scored, its assessment over before the split one's.
  single = await createTestCycle({ code: 'IE-SINGLE', type: 'DOMESTIC', status: 'ASSESSMENT_OPEN', surveyVersions, participants });
  await submitCustomer(single, acoA, customerA, [answers(4)]);
  await submitCustomer(single, acoB, customerB, [answers(3)]);
  const end = new Date(Date.now() - 30 * DAY);
  await CycleModel.updateOne(
    { _id: toId(single.id) },
    { $set: { status: 'SCORED', scoredAt: end, 'assessment.start.utc': new Date(end.getTime() - 30 * DAY), 'assessment.end.utc': end } },
  );

  split = await createTestCycle({ code: 'IE-SPLIT', type: 'DOMESTIC', answerMode: 'IMPORT_EXPORT', status: 'ASSESSMENT_OPEN', surveyVersions, participants });
});
afterAll(() => t.close());

describe('assessments of an IMPORT_EXPORT cycle', () => {
  it('inherit the mode and answer every question once per direction before they can be submitted', async () => {
    const created = await getOrCreateForInvitation(invitation(split, acoA, customerA));
    splitA = created.id;
    expect(created).toMatchObject({ answerMode: 'IMPORT_EXPORT', progress: { answered: 0, total: 8, pct: 0 } });

    await expect(patchAnswers(splitA, answers(5))).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { issues: expect.arrayContaining([{ path: 'answers.0.direction', message: 'Import or Export direction is required' }]) },
    });
    const twice = [...answers(5, 'IMPORT').slice(0, 1), ...answers(4, 'IMPORT').slice(0, 1)];
    await expect(patchAnswers(splitA, twice)).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(await patchAnswers(splitA, answers(5, 'IMPORT'))).toMatchObject({ answered: 4, total: 8, pct: 50 });
    const half = await readiness(splitA);
    expect(half).toMatchObject({ answered: 4, total: 8, complete: false });
    expect(half.missing).toEqual(FF_QUESTIONS.map((code) => `${survey.q[code]}:EXPORT`));
    await expect(submit(ctxOf(superAdmin), splitA)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    // A second import batch replaces the first in place; export lands beside it.
    await patchAnswers(splitA, answers(5, 'IMPORT'));
    expect(await patchAnswers(splitA, answers(2, 'EXPORT'))).toMatchObject({ answered: 8, total: 8, pct: 100 });
    // One remark per section, not per direction.
    const sections = [survey.section['INFRA'], survey.section['PROC']];
    expect(await readiness(splitA)).toEqual({ answered: 8, total: 8, missing: [], missingSectionRemarks: sections, complete: false });
    await expect(submit(ctxOf(superAdmin), splitA)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', details: { missing: [], missingSectionRemarks: sections } });
    await patchSectionRemarks(splitA, [
      { categoryId: survey.section['INFRA']!, remark: 'Import sheds fine; export dock congested' },
      { categoryId: survey.section['PROC']!, remark: 'Same paperwork both ways' },
    ]);
    expect(await readiness(splitA)).toEqual({ answered: 8, total: 8, missing: [], missingSectionRemarks: [], complete: true });
    expect(await submit(ctxOf(superAdmin), splitA)).toMatchObject({ status: 'SUBMITTED', answerMode: 'IMPORT_EXPORT', progress: { answered: 8, total: 8 } });

    await submitCustomer(split, acoB, customerB, [answers(3, 'IMPORT'), answers(4, 'EXPORT')]);
  });

  it('a SINGLE assessment refuses a direction; the self-assessment inherits the mode too', async () => {
    const singleDraft = await getOrCreateForInvitation(invitation(single, acoA, customerA));
    expect(singleDraft.answerMode).toBe('SINGLE');
    await expect(patchAnswers(singleDraft.id, answers(4, 'IMPORT'))).rejects.toMatchObject({
      details: { issues: expect.arrayContaining([{ path: 'answers.0.direction', message: 'Direction is not allowed for a single-answer assessment' }]) },
    });

    const self = await getOrCreateSelf(ctxOf(adminA), split.id, 'DOMESTIC');
    // Five active questions on the self form, twice.
    expect(self).toMatchObject({ kind: 'SELF', answerMode: 'IMPORT_EXPORT', progress: { answered: 0, total: 10 } });
    // Its sections still take one remark each, without a direction.
    const remarks = `/api/v1/assessments/self/${split.id}/DOMESTIC/remarks`;
    expectError(await adminA.patch(remarks).send({ sectionRemarks: [{ categoryId: survey.section['INFRA'], remark: 'Import side', direction: 'IMPORT' }] }), 400, 'VALIDATION');
    const saved = await adminA.patch(remarks).send({ sectionRemarks: [{ categoryId: survey.section['INFRA'], remark: 'New racks in the import shed' }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const opened = await adminA.get(`/api/v1/assessments/self/${split.id}/DOMESTIC`);
    expect(opened.body.data.sectionRemarks).toEqual([{ categoryId: survey.section['INFRA'], remark: 'New racks in the import shed' }]);
    expect(await readiness(self.id)).toMatchObject({ total: 10, missingSectionRemarks: [survey.section['PROC']], complete: false });
  });

  it('shows a score per direction in the history and every answer per direction in the read-only return', async () => {
    const history = await superAdmin.get(`/api/v1/assessments?cycleId=${split.id}&kind=CUSTOMER&acoId=${acoA}`);
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({ id: splitA, score: null, importScore: 5, exportScore: 2 });

    const detail = await superAdmin.get(`/api/v1/assessments/${splitA}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.answerMode).toBe('IMPORT_EXPORT');
    const lines = detail.body.data.answers as { code: string; direction?: string; rating: number | null }[];
    expect(lines.map((line) => [line.code, line.direction, line.rating])).toEqual(FF_QUESTIONS.flatMap((code) => [[code, 'IMPORT', 5], [code, 'EXPORT', 2]]));
    expect(detail.body.data.sectionRemarks).toEqual([
      { categoryId: survey.section['INFRA'], remark: 'Import sheds fine; export dock congested' },
      { categoryId: survey.section['PROC'], remark: 'Same paperwork both ways' },
    ]);

    // The export repeats a section's remark on its import and its export lines.
    const csv = await superAdmin.get(`/api/v1/assessments/export?cycleId=${split.id}&acoId=${acoA}&kind=CUSTOMER&status=SUBMITTED`);
    expect(csv.status).toBe(200);
    const rows = csv.text.trim().split('\n').slice(1).filter((line) => line.startsWith(splitA));
    expect(rows).toHaveLength(8);
    expect(rows.filter((line) => line.includes(',INFRA,')).map((line) => line.split(',').slice(-4, -3)[0])).toEqual(['IMPORT', 'EXPORT', 'IMPORT', 'EXPORT', 'IMPORT', 'EXPORT']);
    expect(rows.filter((line) => line.includes(',INFRA,')).every((line) => line.endsWith(',Import sheds fine; export dock congested'))).toBe(true);
    expect(rows.filter((line) => line.includes(',PROC,')).every((line) => line.endsWith(',Same paperwork both ways'))).toBe(true);

    const singleRows = await superAdmin.get(`/api/v1/assessments?cycleId=${single.id}&status=SUBMITTED&acoId=${acoA}`);
    expect(singleRows.body.data[0]).toMatchObject({ score: 4, importScore: null, exportScore: null });
  });

  it('without assessments.scores the operator sees a customer row with no import or export score; its own self-assessment keeps both', async () => {
    const q = survey.q['Q.OPT'];
    const saved = await adminA.patch(`/api/v1/assessments/self/${split.id}/DOMESTIC/answers`).send({ answers: [{ questionId: q, direction: 'IMPORT', rating: 4 }, { questionId: q, direction: 'EXPORT', rating: 3 }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const rowsOf = async () => (await adminA.get(`/api/v1/assessments?cycleId=${split.id}`)).body.data as { id: string; kind: string; score: number | null; importScore: number | null; exportScore: number | null }[];

    // ACO_ADMIN holds neither customer-assessment task by default.
    const rows = await rowsOf();
    expect(rows.find((row) => row.kind === 'CUSTOMER')).toMatchObject({ id: splitA, score: null, importScore: null, exportScore: null });
    expect(rows.find((row) => row.kind === 'SELF')).toMatchObject({ score: null, importScore: 4, exportScore: 3 });

    await grantTasks('ACO_ADMIN', ['assessments.scores']);
    try {
      expect((await rowsOf()).find((row) => row.kind === 'CUSTOMER')).toMatchObject({ id: splitA, score: null, importScore: 5, exportScore: 2 });
    } finally {
      await revokeTasks('ACO_ADMIN', ['assessments.scores']);
    }
  });
});

describe('scoring per direction', () => {
  it('a SINGLE cycle still scores SINGLE rows only', async () => {
    const summary = await runCycle(single.id, { provisional: false });
    expect(summary).toMatchObject({ directions: ['SINGLE'], operators: 2, airports: 2 });
    expect(await ScoreModel.countDocuments({ cycleId: toId(single.id), direction: { $ne: 'SINGLE' } })).toBe(0);
    expect(await AirportScoreModel.countDocuments({ cycleId: toId(single.id), direction: { $ne: 'SINGLE' } })).toBe(0);
    expect(await overall(single.id, acoA, 'SINGLE')).toMatchObject({ customer: { mean: 4, n: 1 }, rank: 1, rankOf: 2 });
  });

  it('an IMPORT_EXPORT cycle writes IMPORT and EXPORT rows, no SINGLE ones, ranked per direction', async () => {
    // Answered in the other mode (as if before the cycle was switched): left out of the figures.
    const stray = await AssessmentModel.findById(splitA).lean();
    await AssessmentModel.create({ ...stray!, _id: newId(), invitationId: newId(), answerMode: 'SINGLE', answers: answers(1).map((answer) => ({ ...answer, na: false, followUp: [] })) });

    const summary = await runCycle(split.id, { provisional: true });
    expect(summary).toMatchObject({ directions: ['IMPORT', 'EXPORT'], operators: 2, airports: 2 });
    expect(await ScoreModel.countDocuments({ cycleId: toId(split.id), direction: 'SINGLE' })).toBe(0);
    expect(await AirportScoreModel.countDocuments({ cycleId: toId(split.id), direction: 'SINGLE' })).toBe(0);
    const perDirection = await ScoreModel.countDocuments({ cycleId: toId(split.id), direction: 'IMPORT' });
    expect(perDirection).toBeGreaterThan(0);
    expect(await ScoreModel.countDocuments({ cycleId: toId(split.id), direction: 'EXPORT' })).toBe(perDirection);

    // IMPORT: A 5 ahead of B 3; EXPORT: B 4 ahead of A 2. The SINGLE cycle had no rows in either direction: no delta.
    expect(await overall(split.id, acoA, 'IMPORT')).toMatchObject({ customer: { mean: 5, n: 1 }, rank: 1, rankOf: 2 });
    expect(await overall(split.id, acoB, 'IMPORT')).toMatchObject({ customer: { mean: 3, n: 1 }, rank: 2 });
    expect(await overall(split.id, acoA, 'EXPORT')).toMatchObject({ customer: { mean: 2, n: 1 }, rank: 2 });
    const exportB = await overall(split.id, acoB, 'EXPORT');
    expect(exportB).toMatchObject({ customer: { mean: 4, n: 1 }, rank: 1 });
    expect(exportB?.previous).toBeUndefined();
    expect((await getScores(split.id, acoA, 'DOMESTIC', 'IMPORT')).counts).toEqual({ customer: 1, self: 0, FF: 1, CB: 0 });

    expect((await nationalTable(split.id, 'DOMESTIC', 'IMPORT')).map((row) => [row.iata, row.mean, row.rank, row.direction])).toEqual([
      ['DEL', 5, 1, 'IMPORT'],
      ['BOM', 3, 2, 'IMPORT'],
    ]);
    expect((await nationalTable(split.id, 'DOMESTIC', 'EXPORT')).map((row) => [row.iata, row.mean, row.rank])).toEqual([
      ['BOM', 4, 1],
      ['DEL', 2, 2],
    ]);
  });

  it('a re-run drops the rows of a direction the cycle no longer produces', async () => {
    // As if the mode had been switched: scored SINGLE, the IMPORT / EXPORT rows go and only the SINGLE assessment counts.
    await CycleModel.updateOne({ _id: toId(split.id) }, { $set: { answerMode: 'SINGLE' } });
    await runCycle(split.id, { provisional: true });
    expect(await ScoreModel.countDocuments({ cycleId: toId(split.id), direction: { $in: ['IMPORT', 'EXPORT'] } })).toBe(0);
    expect(await AirportScoreModel.countDocuments({ cycleId: toId(split.id), direction: { $in: ['IMPORT', 'EXPORT'] } })).toBe(0);
    expect(await overall(split.id, acoA, 'SINGLE')).toMatchObject({ customer: { mean: 1, n: 1 } });

    await CycleModel.updateOne({ _id: toId(split.id) }, { $set: { answerMode: 'IMPORT_EXPORT' } });
    await runCycle(split.id, { provisional: true });
    expect(await ScoreModel.countDocuments({ cycleId: toId(split.id), direction: 'SINGLE' })).toBe(0);
    expect(await AirportScoreModel.countDocuments({ cycleId: toId(split.id), direction: 'SINGLE' })).toBe(0);
    expect(await overall(split.id, acoA, 'IMPORT')).toMatchObject({ customer: { mean: 5, n: 1 } });
  });
});

describe('report direction', () => {
  const OPERATOR = (acoId: string) => `/api/v1/reports/operator/${acoId}`;

  it('a SINGLE cycle reports SINGLE whatever is asked; an IMPORT_EXPORT one defaults to IMPORT', async () => {
    const singleReport = await superAdmin.get(`${OPERATOR(acoA)}?cycleId=${single.id}&direction=EXPORT`);
    expect(singleReport.status, JSON.stringify(singleReport.body)).toBe(200);
    expect(singleReport.body.data).toMatchObject({ direction: 'SINGLE', cycle: { id: single.id, answerMode: 'SINGLE' }, overall: { customer: { mean: 4, n: 1 }, rank: 1 } });

    const byDefault = await superAdmin.get(`${OPERATOR(acoA)}?cycleId=${split.id}`);
    expect(byDefault.body.data).toMatchObject({ direction: 'IMPORT', cycle: { answerMode: 'IMPORT_EXPORT' }, overall: { customer: { mean: 5 }, rank: 1 } });
    expect(byDefault.body.data.comparison.previous).toBeNull();
    expect(byDefault.body.data.nationalTable.map((row: { airportIata: string; rating: number }) => [row.airportIata, row.rating])).toEqual([
      ['DEL', 5],
      ['BOM', 3],
    ]);

    const exported = await superAdmin.get(`${OPERATOR(acoA)}?cycleId=${split.id}&direction=EXPORT`);
    expect(exported.body.data).toMatchObject({ direction: 'EXPORT', overall: { customer: { mean: 2 }, rank: 2 } });
    expectError(await superAdmin.get(`${OPERATOR(acoA)}?cycleId=${split.id}&direction=SINGLE`), 400, 'VALIDATION');
  });

  it('carries the direction on the question table, airport, national and export', async () => {
    const questions = await superAdmin.get(`${OPERATOR(acoA)}/questions?cycleId=${split.id}&direction=EXPORT`);
    expect(questions.body.data).toMatchObject({ direction: 'EXPORT', cycle: { answerMode: 'IMPORT_EXPORT' } });
    // Every active question of the tree in survey order; Q.NONE is on the CB form only, so nobody answered it.
    const rows = questions.body.data.questions as { code: string; customer: { mean: number | null }; comments: number }[];
    expect(rows.map((row) => [row.code, row.customer.mean, row.comments])).toEqual([
      ['Q.OPT', 2, 1],
      ['Q.REQ', 2, 1],
      ['Q.LOW', 2, 1],
      ['Q.NONE', null, 0],
      ['Q.PLAIN', 2, 1],
    ]);

    const airport = await superAdmin.get(`/api/v1/reports/airport/${bom}?cycleId=${split.id}&direction=EXPORT`);
    expect(airport.body.data).toMatchObject({ direction: 'EXPORT', overall: { mean: 4, rank: 1 } });
    const singleAirport = await superAdmin.get(`/api/v1/reports/airport/${bom}?cycleId=${single.id}&direction=EXPORT`);
    expect(singleAirport.body.data).toMatchObject({ direction: 'SINGLE', cycle: { answerMode: 'SINGLE' }, overall: { mean: 3 } });

    const national = await superAdmin.get(`/api/v1/reports/national?cycleId=${split.id}`);
    expect(national.body.data).toMatchObject({ direction: 'IMPORT', cycle: { answerMode: 'IMPORT_EXPORT' } });
    expect(national.body.data.airports.map((row: { iata: string; rank: number }) => [row.iata, row.rank])).toEqual([
      ['DEL', 1],
      ['BOM', 2],
    ]);

    const csv = await superAdmin.get(`/api/v1/reports/export?scope=operator&acoId=${acoA}&cycleId=${split.id}&direction=EXPORT`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toContain('-IE-SPLIT-DOMESTIC-export.csv');
    const singleCsv = await superAdmin.get(`/api/v1/reports/export?scope=national&cycleId=${single.id}&direction=EXPORT`);
    expect(singleCsv.headers['content-disposition']).toContain('csq-national-IE-SINGLE-DOMESTIC.csv');
  });

  it('compares a SINGLE and an IMPORT_EXPORT cycle, resolving the direction per cycle', async () => {
    const res = await superAdmin.get(`/api/v1/reports/comparison?acoId=${acoA}&cycleIds=${single.id},${split.id}&direction=EXPORT`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.direction).toBe('EXPORT');
    expect(res.body.data.cycles.map((cycle: { code: string; answerMode: string; direction: string }) => [cycle.code, cycle.answerMode, cycle.direction])).toEqual([
      ['IE-SINGLE', 'SINGLE', 'SINGLE'],
      ['IE-SPLIT', 'IMPORT_EXPORT', 'EXPORT'],
    ]);
    expect(res.body.data.overall.map((value: { customer: { mean: number } }) => value.customer.mean)).toEqual([4, 2]);

    const byDefault = await superAdmin.get(`/api/v1/reports/comparison?acoId=${acoA}&cycleIds=${single.id},${split.id}`);
    expect(byDefault.body.data.cycles.map((cycle: { direction: string }) => cycle.direction)).toEqual(['SINGLE', 'IMPORT']);
    expect(byDefault.body.data.overall.map((value: { customer: { mean: number } }) => value.customer.mean)).toEqual([4, 5]);
    const singleOnly = await superAdmin.get(`/api/v1/reports/comparison?acoId=${acoA}&cycleIds=${single.id}&direction=IMPORT`);
    expect(singleOnly.body.data.direction).toBe('SINGLE');
  });
});

describe('migrateScoreDirections (boot)', () => {
  const LEGACY_SCORES = { cycleId: 1, acoId: 1, surveyType: 1, level: 1, refId: 1 };
  const LEGACY_AIRPORTS = { cycleId: 1, airportId: 1, surveyType: 1, level: 1, refId: 1 };
  const NEXT_SCORES = { cycleId: 1, acoId: 1, surveyType: 1, direction: 1, level: 1, refId: 1 };
  const NEXT_AIRPORTS = { cycleId: 1, airportId: 1, surveyType: 1, direction: 1, level: 1, refId: 1 };

  it('backfills SINGLE, drops the legacy unique index whatever its name, ensures the direction-keyed one; idempotent', async () => {
    const scores = ScoreModel.collection;
    const airports = AirportScoreModel.collection;
    // A database as it was before directions: rows without one under the old unique keys.
    for (const collection of [scores, airports]) {
      await collection.deleteMany({});
      await collection.dropIndexes();
    }
    await scores.createIndex(LEGACY_SCORES, { unique: true, name: 'legacy_scores_unique' });
    await airports.createIndex(LEGACY_AIRPORTS, { unique: true });
    const cycleId = newId();
    const row = { cycleId, surveyType: 'DOMESTIC', level: 'OVERALL', refId: 'OVERALL', order: 0, provisional: false, computedAt: new Date() };
    await scores.insertOne({ ...row, acoId: opA._id, airportId: opA.airportId, surveyId: survey.id });
    await airports.insertOne({ ...row, airportId: opA.airportId, mean: 4, marketShareApplied: false, coveredSharePct: 100, operators: [], rank: 1, rankOf: 1 });

    expect(await migrateScoreDirections()).toEqual([
      { collection: 'scores', backfilled: 1, droppedIndexes: ['legacy_scores_unique'] },
      { collection: 'airport_scores', backfilled: 1, droppedIndexes: ['cycleId_1_airportId_1_surveyType_1_level_1_refId_1'] },
    ]);
    for (const [collection, legacy, next] of [
      [scores, LEGACY_SCORES, NEXT_SCORES],
      [airports, LEGACY_AIRPORTS, NEXT_AIRPORTS],
    ] as const) {
      const indexes = await collection.indexes();
      expect(indexes.some((index) => JSON.stringify(index.key) === JSON.stringify(legacy))).toBe(false);
      expect(indexes.find((index) => JSON.stringify(index.key) === JSON.stringify(next))?.unique).toBe(true);
      expect(await collection.countDocuments({ direction: 'SINGLE' })).toBe(1);
    }

    // IMPORT and EXPORT rows of the same ref no longer collide.
    await scores.insertMany([
      { ...row, acoId: opA._id, airportId: opA.airportId, surveyId: survey.id, direction: 'IMPORT' },
      { ...row, acoId: opA._id, airportId: opA.airportId, surveyId: survey.id, direction: 'EXPORT' },
    ]);
    await airports.insertMany([
      { ...row, airportId: opA.airportId, direction: 'IMPORT' },
      { ...row, airportId: opA.airportId, direction: 'EXPORT' },
    ]);
    expect(await scores.countDocuments({ cycleId })).toBe(3);
    await expect(scores.insertOne({ ...row, acoId: opA._id, airportId: opA.airportId, surveyId: survey.id, direction: 'IMPORT' })).rejects.toMatchObject({ code: 11000 });

    expect(await migrateScoreDirections()).toEqual([
      { collection: 'scores', backfilled: 0, droppedIndexes: [] },
      { collection: 'airport_scores', backfilled: 0, droppedIndexes: [] },
    ]);
  });
});
