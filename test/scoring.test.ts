// Scoring over a real database (ARCHITECTURE §7 "Scoring", REQUIREMENTS
// §20–23): two airports × two operators, a previous cycle on survey v1 and
// the current one on v2 (same codes, new ids). Covers the final run through
// the `cycle.transitioned` listener, the provisional run (levels, NA, FF / CB,
// SELF isolation, suppression, ranks, previous / delta, airport roll-up with
// and without a market-share snapshot, national table), the nightly job and
// the route.
import type { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemContext } from '../src/core/auth/system.js';
import { withTransaction } from '../src/core/db.js';
import { on, type Events } from '../src/core/events.js';
import { idString, newId, toId } from '../src/core/ids.js';
import { JobModel } from '../src/core/jobs.model.js';
import { logger } from '../src/core/logger.js';
import { nightlySlot, scoringFinalise, scoringNightly } from '../src/jobs/scoring.jobs.js';
import { AssessmentModel } from '../src/modules/assessments/assessments.model.js';
import { AuditModel } from '../src/modules/audit/audit.model.js';
import { CycleModel } from '../src/modules/cycles/cycles.model.js';
import { transition } from '../src/modules/cycles/cycles.service.js';
import type { CycleStatus } from '../src/modules/cycles/domain/types.js';
import { createParticipants, planParticipants } from '../src/modules/cycles/participants.service.js';
import { MarketShareModel } from '../src/modules/organisations/market-shares.model.js';
import type { OrganisationDoc } from '../src/modules/organisations/organisations.model.js';
import { AirportScoreModel } from '../src/modules/scoring/airport-scores.model.js';
import type { Rating } from '../src/modules/scoring/engine/index.js';
import { ScoreModel } from '../src/modules/scoring/scores.model.js';
import { getAirportScores, getScores, nationalTable, runCycle } from '../src/modules/scoring/scoring.service.js';
import { SettingsModel } from '../src/modules/settings/settings.model.js';
import { createSurveyFromDefinition, getSurveyTree, type QuestionDefinition } from '../src/modules/surveys/surveys.service.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, createTestOperator, expectError } from './helpers/fixtures.js';

const DAY = 24 * 60 * 60 * 1000;
const RUN = (cycleId: string) => `/api/v1/scoring/cycles/${cycleId}/run`;

// --- survey: INFRA { STORAGE { Q.S1, Q.S2 }, Q.I3 } · PROC { Q.P1, Q.OFF (inactive) } ---------

type QuestionCode = 'Q.S1' | 'Q.S2' | 'Q.I3' | 'Q.P1';
/** Pre-order of the scored tree, as `getScores` returns it. */
const TREE_ORDER = ['OVERALL', 'INFRA', 'STORAGE', 'Q.S1', 'Q.S2', 'Q.I3', 'PROC', 'Q.P1'];

function question(code: string, order: number, overrides: Partial<QuestionDefinition> = {}): QuestionDefinition {
  return { code, text: `Question ${code}`, help: null, order, weightPct: null, mandatory: true, commentMode: 'OPTIONAL', stakeholderTypes: ['FF', 'CB'], followUp: null, active: true, ...overrides };
}

interface TestSurvey {
  id: string;
  /** question code → id */
  q: Record<string, string>;
}

/** The same structure under a new version id each time, as publishing a new version does. */
async function createSurveyVersion(version: number, status: 'PUBLISHED' | 'RETIRED'): Promise<TestSurvey> {
  const survey = await createSurveyFromDefinition({
    code: 'DOMESTIC',
    name: 'Domestic scoring test survey',
    version,
    status,
    publishedAt: new Date(),
    categories: [
      {
        code: 'INFRA',
        name: 'Infrastructure',
        order: 10,
        weightPct: 40,
        subcategories: [{ code: 'STORAGE', name: 'Storage', order: 1, questions: [question('Q.S1', 1), question('Q.S2', 2)] }],
        questions: [question('Q.I3', 1)],
      },
      { code: 'PROC', name: 'Processes', order: 20, weightPct: 60, subcategories: [], questions: [question('Q.P1', 1), question('Q.OFF', 2, { active: false })] },
    ],
  });
  const id = idString(survey._id);
  const tree = await getSurveyTree(id);
  const q: Record<string, string> = {};
  for (const category of tree.categories) {
    for (const item of category.questions) q[item.code] = item.id;
    for (const sub of category.subcategories) for (const item of sub.questions) q[item.code] = item.id;
  }
  return { id, q };
}

// --- cycles and assessments straight in the database ------------------------------------------

const edge = (at: Date) => ({ wall: at.toISOString().slice(0, 16), utc: at });

interface CycleInput {
  code: string;
  status: CycleStatus;
  surveyId: string;
  assessmentStart: Date;
  assessmentEnd: Date;
}

/** A DOMESTIC cycle with its participants created by the real cycles rules. */
async function createCycle(input: CycleInput, operators: OrganisationDoc[]): Promise<string> {
  const cycle = await CycleModel.create({
    name: `Cycle ${input.code}`,
    code: input.code,
    type: 'DOMESTIC',
    tz: 'Asia/Kolkata',
    sampling: { start: edge(new Date(input.assessmentStart.getTime() - 20 * DAY)), end: edge(new Date(input.assessmentStart.getTime() - DAY)) },
    assessment: { start: edge(input.assessmentStart), end: edge(input.assessmentEnd) },
    minSampleSize: 1,
    reminders: { sampling: { count: 3, everyDays: 3 }, assessment: { count: 10, everyDays: 2 } },
    participatingAirportIds: [...new Set(operators.map((op) => idString(op.airportId as Types.ObjectId)))],
    participatingAcoIds: operators.map((op) => op._id),
    surveyVersions: { DOMESTIC: toId(input.surveyId), INTERNATIONAL: null },
    status: input.status,
    publishedAt: new Date(input.assessmentStart.getTime() - 21 * DAY),
  });
  await withTransaction(async (session) => {
    await createParticipants(cycle._id, planParticipants({ type: 'DOMESTIC', minSampleSize: 1 }, operators), session);
  });
  return idString(cycle._id);
}

type Answers = Partial<Record<QuestionCode, Rating | 'NA'>>;

/** Every active question rated `rating`, with overrides (`'NA'` for not applicable). */
function all(rating: Rating, overrides: Answers = {}): Answers {
  return { 'Q.S1': rating, 'Q.S2': rating, 'Q.I3': rating, 'Q.P1': rating, ...overrides };
}

interface SubmitInput {
  cycleId: string;
  operator: OrganisationDoc;
  survey: TestSurvey;
  kind: 'CUSTOMER' | 'SELF';
  customerType?: 'FF' | 'CB';
  answers: Answers;
}

/** A SUBMITTED assessment as the participant flow leaves it. */
async function submit(input: SubmitInput): Promise<string> {
  const answers = Object.entries(input.answers).map(([code, value]) => ({
    questionId: input.survey.q[code],
    rating: value === 'NA' ? null : value,
    na: value === 'NA',
    comment: null,
    followUp: [],
  }));
  const now = new Date();
  const doc = await AssessmentModel.create({
    cycleId: toId(input.cycleId),
    acoId: input.operator._id,
    airportId: input.operator.airportId,
    surveyId: input.survey.id,
    surveyType: 'DOMESTIC',
    kind: input.kind,
    customerId: input.kind === 'CUSTOMER' ? newId() : null,
    customerType: input.customerType ?? null,
    invitationId: null,
    userId: input.kind === 'SELF' ? newId() : null,
    status: 'SUBMITTED',
    answers,
    answeredCount: answers.length,
    questionCount: answers.length,
    startedAt: now,
    lastSavedAt: now,
    submittedAt: now,
  });
  return idString(doc._id);
}

function rowOf<T extends { refId: string }>(rows: readonly T[], refId: string): T {
  const row = rows.find((candidate) => candidate.refId === refId);
  if (!row) throw new Error(`no row for ${refId}`);
  return row;
}

// --- fixture ----------------------------------------------------------------------------------

let t: TestApp;
let superAdmin: TestUser;
let analyst: TestUser;
let acoAdmin: TestUser;
let del: string;
let bom: string;
let delA: OrganisationDoc;
let delB: OrganisationDoc;
let bomC: OrganisationDoc;
let bomD: OrganisationDoc;
let v1: TestSurvey;
let v2: TestSurvey;
let prev: string;
let cur: string;
const completed: Events['scoring.completed'][] = [];

beforeAll(async () => {
  t = await createTestApp();
  on('scoring.completed', 'test.recordCompleted', async (payload) => {
    completed.push({ ...payload });
  });
  await SettingsModel.updateOne({ key: 'global' }, { $set: { 'scoring.minResponses': 2 } });

  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN' });
  analyst = await t.asUser({ orgType: 'ACFI', roleCode: 'ACFI_ANALYST', email: 'analyst@acfi.test' });
  del = await airportIdByIata('DEL');
  bom = await airportIdByIata('BOM');
  delA = await createTestOperator({ code: 'DEL-A', airportIata: 'DEL' });
  delB = await createTestOperator({ code: 'DEL-B', airportIata: 'DEL' });
  bomC = await createTestOperator({ code: 'BOM-C', airportIata: 'BOM' });
  bomD = await createTestOperator({ code: 'BOM-D', airportIata: 'BOM' });
  acoAdmin = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgCode: 'DEL-A', airportIata: 'DEL' });
  const operators = [delA, delB, bomC, bomD];

  v1 = await createSurveyVersion(1, 'RETIRED');
  v2 = await createSurveyVersion(2, 'PUBLISHED');

  // Previous cycle on v1: assessment over, still ASSESSMENT_OPEN until the clock closes it below.
  prev = await createCycle({ code: 'SCR-PREV', status: 'ASSESSMENT_OPEN', surveyId: v1.id, assessmentStart: new Date(Date.now() - 70 * DAY), assessmentEnd: new Date(Date.now() - 40 * DAY) }, operators);
  const prevAnswers: [OrganisationDoc, Rating, ('FF' | 'CB')[]][] = [
    [delA, 4, ['FF', 'FF', 'CB']],
    [delB, 3, ['FF', 'FF', 'CB']],
    [bomC, 5, ['FF', 'CB']],
    [bomD, 2, ['FF', 'CB']],
  ];
  for (const [operator, rating, types] of prevAnswers) {
    for (const customerType of types) await submit({ cycleId: prev, operator, survey: v1, kind: 'CUSTOMER', customerType, answers: all(rating) });
  }

  // Current cycle on v2: assessment open; DEL has a market-share snapshot (30 / 70), BOM none.
  cur = await createCycle({ code: 'SCR-CUR', status: 'ASSESSMENT_OPEN', surveyId: v2.id, assessmentStart: new Date(Date.now() - 20 * DAY), assessmentEnd: new Date(Date.now() + 10 * DAY) }, operators);
  await MarketShareModel.create([
    { airportId: toId(del), acoId: delA._id, cycleId: toId(cur), sharePct: 30, setBy: null, note: null },
    { airportId: toId(del), acoId: delB._id, cycleId: toId(cur), sharePct: 70, setBy: null, note: null },
  ]);
  // DEL-A: FF 5, 5 · CB 4, 4 → every question 4.5; FF 5.0, CB 4.0; SELF all 5.
  for (const [customerType, rating] of [['FF', 5], ['FF', 5], ['CB', 4], ['CB', 4]] as const) {
    await submit({ cycleId: cur, operator: delA, survey: v2, kind: 'CUSTOMER', customerType, answers: all(rating) });
  }
  await submit({ cycleId: cur, operator: delA, survey: v2, kind: 'SELF', answers: all(5) });
  // DEL-B: FF 4, 4, 4 · CB 4 with Q.I3 not applicable → 4.0 everywhere, one NA, CB split hidden (n = 1).
  for (const answers of [all(4), all(4), all(4)]) await submit({ cycleId: cur, operator: delB, survey: v2, kind: 'CUSTOMER', customerType: 'FF', answers });
  await submit({ cycleId: cur, operator: delB, survey: v2, kind: 'CUSTOMER', customerType: 'CB', answers: all(4, { 'Q.I3': 'NA' }) });
  // BOM-C: one customer → suppressed. BOM-D: FF 3 · CB 3 → 3.0, both splits hidden.
  await submit({ cycleId: cur, operator: bomC, survey: v2, kind: 'CUSTOMER', customerType: 'FF', answers: all(3) });
  await submit({ cycleId: cur, operator: bomD, survey: v2, kind: 'CUSTOMER', customerType: 'FF', answers: all(3) });
  await submit({ cycleId: cur, operator: bomD, survey: v2, kind: 'CUSTOMER', customerType: 'CB', answers: all(3) });
});
afterAll(() => t.close());

// --- the listener: final run when the assessment closes ---------------------------------------

describe('cycle.transitioned to ASSESSMENT_CLOSED', () => {
  it('runs the final scoring, which marks the cycle SCORED through scoring.completed', async () => {
    await transition(systemContext('test: clock'), prev, 'ASSESSMENT_CLOSED', 'assessment window ended', { trigger: 'CLOCK' });

    const cycle = await CycleModel.findById(prev).lean();
    expect(cycle?.status).toBe('SCORED');
    expect(cycle?.scoredAt).toBeInstanceOf(Date);
    expect(completed).toEqual([{ cycleId: prev, provisional: false }]);

    const a = await getScores(prev, idString(delA._id), 'DOMESTIC');
    expect(a.provisional).toBe(false);
    expect(a.surveyId).toBe(v1.id);
    expect(a.rows.map((row) => row.refId)).toEqual(TREE_ORDER);
    expect(rowOf(a.rows, 'OVERALL')).toMatchObject({ level: 'OVERALL', customer: { mean: 4, n: 3 }, rank: 2, rankOf: 4 });
    expect(rowOf(a.rows, 'OVERALL').previous).toBeUndefined();
    expect(await ScoreModel.countDocuments({ cycleId: prev, provisional: false })).toBe(4 * TREE_ORDER.length);

    const audit = await AuditModel.findOne({ action: 'scoring.run', entityId: prev }).lean();
    expect(audit).toMatchObject({ entity: 'cycle', actorUserId: null, orgId: null });
    expect((audit?.after as { trigger: string; provisional: boolean }).trigger).toBe('test: clock');
  });

  it('ranks the previous cycle densely (C 5.0, A 4.0, B 3.0, D 2.0) and ties airports at equal weights', async () => {
    const ranks = await Promise.all(
      [bomC, delA, delB, bomD].map(async (operator) => rowOf((await getScores(prev, idString(operator._id), 'DOMESTIC')).rows, 'OVERALL').rank),
    );
    expect(ranks).toEqual([1, 2, 3, 4]);
    // No snapshot in the previous cycle: (4 + 3) / 2 at DEL and (5 + 2) / 2 at BOM share rank 1.
    expect((await nationalTable(prev, 'DOMESTIC')).map((row) => [row.iata, row.mean, row.rank, row.rankOf, row.marketShareApplied, row.coveredSharePct])).toEqual([
      ['BOM', 3.5, 1, 2, false, 100],
      ['DEL', 3.5, 1, 2, false, 100],
    ]);
  });
});

// --- runCycle: the provisional run of the open cycle --------------------------------------------

describe('runCycle (provisional)', () => {
  it('scores every participant per level, NA excluded, FF / CB split, SELF isolated', async () => {
    const summary = await runCycle(cur, { provisional: true });
    expect(summary).toMatchObject({ cycleId: cur, provisional: true, surveyTypes: ['DOMESTIC'], operators: 4, airports: 2, rows: 4 * TREE_ORDER.length, airportRows: 2 * TREE_ORDER.length });

    const a = await getScores(cur, idString(delA._id), 'DOMESTIC');
    expect(a).toMatchObject({ cycleId: cur, acoId: idString(delA._id), surveyType: 'DOMESTIC', surveyId: v2.id, provisional: true, computedAt: summary.computedAt });
    expect(a.rows.map((row) => row.refId)).toEqual(TREE_ORDER);
    expect(a.rows.map((row) => row.level)).toEqual(['OVERALL', 'CATEGORY', 'SUBCATEGORY', 'QUESTION', 'QUESTION', 'QUESTION', 'CATEGORY', 'QUESTION']);
    for (const row of a.rows) {
      expect(row.customer).toEqual({ mean: 4.5, n: 4, naCount: 0, byType: { FF: { mean: 5, n: 2 }, CB: { mean: 4, n: 2 } } });
      expect(row.self).toEqual({ mean: 5, n: 1 });
      expect(row.suppressed).toBeUndefined();
    }
    expect(a.counts).toEqual({ customer: 4, self: 1, FF: 2, CB: 2 });
    expect(a.distribution).toEqual([
      { rating: 5, label: 'Excellent', count: 8, pct: 50 },
      { rating: 4, label: 'Very Good', count: 8, pct: 50 },
      { rating: 3, label: 'Good', count: 0, pct: 0 },
      { rating: 2, label: 'Fair', count: 0, pct: 0 },
      { rating: 1, label: 'Poor', count: 0, pct: 0 },
      { rating: null, label: 'NA', count: 0, pct: 0 },
    ]);

    const b = await getScores(cur, idString(delB._id), 'DOMESTIC');
    expect(rowOf(b.rows, 'OVERALL').customer).toEqual({ mean: 4, n: 4, naCount: 1, byType: { FF: { mean: 4, n: 3 }, CB: { mean: null, n: 1 } } });
    expect(rowOf(b.rows, 'Q.I3').customer).toMatchObject({ mean: 4, n: 3, naCount: 1 });
    expect(rowOf(b.rows, 'INFRA').customer).toMatchObject({ mean: 4, n: 4, naCount: 1 });
    expect(rowOf(b.rows, 'PROC').customer).toMatchObject({ mean: 4, n: 4, naCount: 0 });
    expect(rowOf(b.rows, 'OVERALL').self).toEqual({ mean: null, n: 0 });
    expect(b.counts).toEqual({ customer: 4, self: 0, FF: 3, CB: 1 });
    expect(b.distribution.map((bucket) => [bucket.label, bucket.count, bucket.pct])).toEqual([
      ['Excellent', 0, 0],
      ['Very Good', 15, 93.75],
      ['Good', 0, 0],
      ['Fair', 0, 0],
      ['Poor', 0, 0],
      ['NA', 1, 6.25],
    ]);
  });

  it('suppresses a level below minResponses and never exposes a single respondent through the split', async () => {
    const c = await getScores(cur, idString(bomC._id), 'DOMESTIC');
    expect(c.rows).toHaveLength(TREE_ORDER.length);
    for (const row of c.rows) {
      expect(row.suppressed).toBe('INSUFFICIENT_RESPONSES');
      expect(row.customer).toEqual({ mean: null, n: 1, naCount: 0, byType: { FF: { mean: null, n: 1 }, CB: { mean: null, n: 0 } } });
    }
    expect(rowOf(c.rows, 'OVERALL')).toMatchObject({ rank: null, rankOf: 3 });

    const d = rowOf((await getScores(cur, idString(bomD._id), 'DOMESTIC')).rows, 'OVERALL');
    expect(d.suppressed).toBeUndefined();
    expect(d.customer).toEqual({ mean: 3, n: 2, naCount: 0, byType: { FF: { mean: null, n: 1 }, CB: { mean: null, n: 1 } } });
  });

  it('ranks operators densely on the overall customer mean, on the OVERALL row only', async () => {
    const overall = await Promise.all([delA, delB, bomD, bomC].map(async (operator) => (await getScores(cur, idString(operator._id), 'DOMESTIC')).rows));
    expect(overall.map((rows) => [rowOf(rows, 'OVERALL').rank, rowOf(rows, 'OVERALL').rankOf])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
      [null, 3],
    ]);
    for (const rows of overall) {
      for (const row of rows.filter((candidate) => candidate.level !== 'OVERALL')) {
        expect(row.rank).toBeUndefined();
        expect(row.rankOf).toBeUndefined();
      }
    }
  });

  it('compares every row with the most recent SCORED cycle across survey versions (refId = code)', async () => {
    const a = (await getScores(cur, idString(delA._id), 'DOMESTIC')).rows;
    expect(rowOf(a, 'OVERALL')).toMatchObject({ previous: { cycleId: prev, mean: 4 }, delta: 0.5 });
    expect(rowOf(a, 'Q.S1')).toMatchObject({ previous: { cycleId: prev, mean: 4 }, delta: 0.5 });
    expect(rowOf(a, 'STORAGE')).toMatchObject({ previous: { cycleId: prev, mean: 4 }, delta: 0.5 });
    expect(a.every((row) => row.previous?.cycleId === prev)).toBe(true);

    expect(rowOf((await getScores(cur, idString(delB._id), 'DOMESTIC')).rows, 'OVERALL')).toMatchObject({ previous: { cycleId: prev, mean: 3 }, delta: 1 });
    expect(rowOf((await getScores(cur, idString(bomD._id), 'DOMESTIC')).rows, 'OVERALL')).toMatchObject({ previous: { cycleId: prev, mean: 2 }, delta: 1 });
    // Suppressed now, scored then: the previous figure is shown, the delta is not.
    const c = rowOf((await getScores(cur, idString(bomC._id), 'DOMESTIC')).rows, 'OVERALL');
    expect(c.previous).toEqual({ cycleId: prev, mean: 5 });
    expect(c.delta).toBeUndefined();
  });

  it('rolls airports up with the market-share snapshot (REQUIREMENTS §20) and falls back to equal weights', async () => {
    const delRows = await getAirportScores(cur, del);
    expect(delRows.map((row) => row.refId)).toEqual(TREE_ORDER);
    expect(delRows.every((row) => row.surveyType === 'DOMESTIC' && row.provisional)).toBe(true);
    // (4.5 × 30 %) + (4.0 × 70 %) = 4.15 at every level, the full airport covered.
    for (const row of delRows) {
      expect(row).toMatchObject({ cycleId: cur, airportId: del, mean: 4.15, marketShareApplied: true, coveredSharePct: 100, rank: 1, rankOf: 2 });
      expect(row.operators).toEqual([
        { acoId: idString(delA._id), mean: 4.5, sharePct: 30, suppressed: false },
        { acoId: idString(delB._id), mean: 4, sharePct: 70, suppressed: false },
      ]);
    }
    // No snapshot at BOM: equal weights, one of two operators suppressed → half covered, not below the floor.
    const bomOverall = rowOf(await getAirportScores(cur, bom), 'OVERALL');
    expect(bomOverall).toMatchObject({ mean: 3, marketShareApplied: false, coveredSharePct: 50, rank: 2, rankOf: 2 });
    expect(bomOverall.operators).toEqual([
      { acoId: idString(bomC._id), mean: null, sharePct: null, suppressed: true },
      { acoId: idString(bomD._id), mean: 3, sharePct: null, suppressed: false },
    ]);
    expect(await getAirportScores(cur, await airportIdByIata('BLR'))).toEqual([]);
  });

  it('publishes the national table with airport figures only, best first', async () => {
    const table = await nationalTable(cur, 'DOMESTIC');
    expect(table).toEqual([
      expect.objectContaining({ airportId: del, iata: 'DEL', name: expect.any(String), mean: 4.15, rank: 1, rankOf: 2, marketShareApplied: true, coveredSharePct: 100, provisional: true }),
      expect.objectContaining({ airportId: bom, iata: 'BOM', mean: 3, rank: 2, rankOf: 2, marketShareApplied: false, coveredSharePct: 50 }),
    ]);
    for (const row of table) expect(row).not.toHaveProperty('operators');
    expect(await nationalTable(cur, 'INTERNATIONAL')).toEqual([]);
  });

  it('flags the run provisional, leaves the cycle open and announces it; an unscored type reads empty', async () => {
    expect((await CycleModel.findById(cur).lean())?.status).toBe('ASSESSMENT_OPEN');
    expect(await ScoreModel.countDocuments({ cycleId: cur })).toBe(4 * TREE_ORDER.length);
    expect(await ScoreModel.countDocuments({ cycleId: cur, provisional: false })).toBe(0);
    expect(completed).toEqual([
      { cycleId: prev, provisional: false },
      { cycleId: cur, provisional: true },
    ]);
    const none = await getScores(cur, idString(delA._id), 'INTERNATIONAL');
    expect(none).toMatchObject({ surveyId: null, provisional: null, computedAt: null, rows: [], counts: { customer: 0, self: 0, FF: 0, CB: 0 } });
    expect(none.distribution.map((bucket) => bucket.count)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

// --- the nightly job ----------------------------------------------------------------------------

describe('scoring.nightly', () => {
  it('is due from 01:00 cycle-local, once per cycle and day', () => {
    const cycle = { tz: 'Asia/Kolkata' };
    expect(nightlySlot(cycle, new Date('2026-10-07T19:29:00.000Z'))).toBeNull(); // 00:59 IST
    expect(nightlySlot(cycle, new Date('2026-10-07T19:30:00.000Z'))).toBe('2026-10-08'); // 01:00 IST
    expect(nightlySlot(cycle, new Date('2026-10-08T10:00:00.000Z'))).toBe('2026-10-08'); // a catch-up tick, same slot
    expect(nightlySlot({ tz: 'UTC' }, new Date('2026-10-07T19:30:00.000Z'))).toBe('2026-10-07');
  });

  it('runs a provisional scoring of every ASSESSMENT_OPEN cycle and skips the slot afterwards', async () => {
    const before = completed.length;
    const now = new Date('2026-10-07T19:30:00.000Z');
    await scoringNightly({ now, log: logger });
    const jobs = await JobModel.find({ type: 'scoring.nightly' }).lean();
    expect(jobs.map((job) => [job.refId, job.slot, job.status])).toEqual([[cur, '2026-10-08', 'DONE']]);
    expect(jobs[0]?.detail).toBe('4 operators, 2 airports, 32 rows');
    expect(completed.slice(before)).toEqual([{ cycleId: cur, provisional: true }]);
    expect((await ScoreModel.findOne({ cycleId: cur, level: 'OVERALL', acoId: delA._id }).lean())?.computedAt).toEqual(now);

    await scoringNightly({ now: new Date('2026-10-08T05:00:00.000Z'), log: logger });
    expect(await JobModel.countDocuments({ type: 'scoring.nightly' })).toBe(1);
    expect(completed).toHaveLength(before + 1);
    expect((await ScoreModel.findOne({ cycleId: cur, level: 'OVERALL', acoId: delA._id }).lean())?.computedAt).toEqual(now);
  });
});

describe('scoring.finalise', () => {
  it('redoes the final run of a cycle left ASSESSMENT_CLOSED beyond the grace period, which then becomes SCORED', async () => {
    // Older than the previous cycle, so it never becomes the "most recent SCORED cycle" of the current one.
    const window = { assessmentStart: new Date(Date.now() - 130 * DAY), assessmentEnd: new Date(Date.now() - 100 * DAY) };
    const stuck = await createCycle({ code: 'SCR-STUCK', status: 'ASSESSMENT_CLOSED', surveyId: v2.id, ...window }, [delA, delB]);
    const fresh = await createCycle({ code: 'SCR-FRESH', status: 'ASSESSMENT_CLOSED', surveyId: v2.id, ...window }, [bomD]);
    await submit({ cycleId: stuck, operator: delA, survey: v2, kind: 'CUSTOMER', customerType: 'FF', answers: all(2) });
    await submit({ cycleId: stuck, operator: delA, survey: v2, kind: 'CUSTOMER', customerType: 'CB', answers: all(2) });
    // As if the listener's run had failed twenty minutes ago.
    await CycleModel.updateOne({ _id: toId(stuck) }, { $set: { updatedAt: new Date(Date.now() - 20 * 60 * 1000) } }, { timestamps: false });

    const before = completed.length;
    await scoringFinalise({ now: new Date(), log: logger });

    expect((await CycleModel.findById(stuck).lean())?.status).toBe('SCORED');
    expect(rowOf((await getScores(stuck, idString(delA._id), 'DOMESTIC')).rows, 'OVERALL')).toMatchObject({ customer: { mean: 2, n: 2 }, rank: 1, rankOf: 1 });
    expect(await ScoreModel.countDocuments({ cycleId: stuck, provisional: true })).toBe(0);
    expect(completed.slice(before)).toEqual([{ cycleId: stuck, provisional: false }]);
    const jobs = await JobModel.find({ type: 'scoring.finalise' }).lean();
    expect(jobs.map((job) => [job.refId, job.slot, job.status])).toEqual([[stuck, window.assessmentEnd.toISOString(), 'DONE']]);
    // Freshly closed: the listener is still the one to run it.
    expect((await CycleModel.findById(fresh).lean())?.status).toBe('ASSESSMENT_CLOSED');
    expect(await ScoreModel.countDocuments({ cycleId: fresh })).toBe(0);
  });
});

// --- the route ----------------------------------------------------------------------------------

describe('POST /scoring/cycles/:cycleId/run', () => {
  it('requires cycles.operate on a PLATFORM organisation, a visible cycle and an assessment that has opened', async () => {
    expectError(await analyst.post(RUN(cur)).send({}), 403, 'FORBIDDEN');
    expectError(await acoAdmin.post(RUN(cur)).send({}), 403, 'FORBIDDEN');
    expectError(await t.anon.post(RUN(cur)).send({}), 401, 'UNAUTHENTICATED');
    expectError(await superAdmin.post(RUN(idString(newId()))).send({}), 404, 'NOT_FOUND');
    expectError(await superAdmin.post(RUN('not-an-id')).send({}), 400, 'VALIDATION');
    expectError(await superAdmin.post(RUN(cur)).send({ provisional: 'yes' }), 400, 'VALIDATION');

    const draft = await createCycle({ code: 'SCR-DRAFT', status: 'DRAFT', surveyId: v2.id, assessmentStart: new Date(Date.now() + 30 * DAY), assessmentEnd: new Date(Date.now() + 60 * DAY) }, [delA]);
    const refused = expectError(await superAdmin.post(RUN(draft)).send({}), 412, 'PRECONDITION_FAILED');
    expect(refused.details).toEqual({ cycleId: draft, status: 'DRAFT' });
    expect(await ScoreModel.countDocuments({ cycleId: draft })).toBe(0);
  });

  it('recomputes in place (idempotent) and audits scoring.run with the actor', async () => {
    const key = { cycleId: cur, acoId: delA._id, surveyType: 'DOMESTIC', level: 'OVERALL' };
    const before = await ScoreModel.findOne(key).lean();
    const res = await superAdmin.post(RUN(cur));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ cycleId: cur, provisional: true, surveyTypes: ['DOMESTIC'], operators: 4, airports: 2, rows: 32, airportRows: 16 });

    const after = await ScoreModel.findOne(key).lean();
    expect(idString(after!._id)).toBe(idString(before!._id));
    expect(after!.customer).toEqual(before!.customer);
    expect(after!.computedAt.toISOString()).toBe(res.body.data.computedAt);
    expect(await ScoreModel.countDocuments({ cycleId: cur })).toBe(32);
    expect(await AirportScoreModel.countDocuments({ cycleId: cur })).toBe(16);

    const audit = await AuditModel.findOne({ action: 'scoring.run', entityId: cur, actorEmail: superAdmin.user.email }).lean();
    expect(audit).toMatchObject({ entity: 'cycle', orgId: null });
    expect(audit?.after).toMatchObject({ provisional: true, trigger: 'request', status: 'ASSESSMENT_OPEN' });
  });

  it('is final once the assessment has closed (the cycle becomes SCORED) and a re-run keeps the figures', async () => {
    await transition(systemContext('test: clock'), cur, 'ASSESSMENT_CLOSED', 'assessment window ended', { trigger: 'CLOCK' });
    expect((await CycleModel.findById(cur).lean())?.status).toBe('SCORED');
    expect(await ScoreModel.countDocuments({ cycleId: cur, provisional: true })).toBe(0);
    expect(await AirportScoreModel.countDocuments({ cycleId: cur, provisional: true })).toBe(0);
    expect(completed.at(-1)).toEqual({ cycleId: cur, provisional: false });

    const res = await superAdmin.post(RUN(cur));
    expect(res.status).toBe(200);
    expect(res.body.data.provisional).toBe(false);
    expect((await CycleModel.findById(cur).lean())?.status).toBe('SCORED');
    expect((await nationalTable(cur, 'DOMESTIC')).map((row) => [row.iata, row.mean, row.rank, row.provisional])).toEqual([
      ['DEL', 4.15, 1, false],
      ['BOM', 3, 2, false],
    ]);
    expect(rowOf((await getScores(cur, idString(delA._id), 'DOMESTIC')).rows, 'OVERALL')).toMatchObject({ customer: { mean: 4.5, n: 4 }, rank: 1, previous: { cycleId: prev, mean: 4 }, delta: 0.5 });

    const forced = await superAdmin.post(RUN(cur)).send({ provisional: true });
    expect(forced.status).toBe(200);
    expect(forced.body.data.provisional).toBe(true);
    expect((await CycleModel.findById(cur).lean())?.status).toBe('SCORED');
  });
});
