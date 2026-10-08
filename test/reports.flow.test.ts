// The reports part of the cycle flow (WAVE1-BRIEF §4): the lower features are
// the real ones — a published survey, a cycle published and moved through its
// statuses, participants, customers and assessments submitted through the
// assessments service — so every reader in `reports.sources.ts` runs against
// the documents those modules write. Only the scoring service is replaced:
// its rows are the contract of WAVE1-BRIEF §2 (`getScores`, `getAirportScores`,
// `nationalTable`) shaped like ARCHITECTURE §5 `scores` / `airport_scores`.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LinkSession } from '../src/core/auth/link.js';
import { systemContext } from '../src/core/auth/system.js';
import { clearEventHandlers, emit } from '../src/core/events.js';
import { idString, newId, toId } from '../src/core/ids.js';
import type { AnswerInput } from '../src/modules/assessments/assessments.form.js';
import { getOrCreateForInvitation, patchAnswers, submit } from '../src/modules/assessments/assessments.service.js';
import { registerCycleHandlers } from '../src/modules/cycles/cycles.handlers.js';
import { getParticipant } from '../src/modules/cycles/cycles.service.js';
import { fromInstant } from '../src/modules/cycles/domain/windows.js';
import { setCurrentShare } from '../src/modules/organisations/market-share.service.js';

import { createTestCustomer, createTestSurvey, type TestSurvey } from './assessments.fixtures.js';
import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, createTestOperator, expectError } from './helpers/fixtures.js';

// --- the scoring stand-in ------------------------------------------------------

interface MeanWithN {
  mean: number | null;
  n: number;
}

/** A `scores` row as `getScores` returns it: `refId` is the survey node's code. */
interface ScoreRow {
  level: 'QUESTION' | 'SUBCATEGORY' | 'CATEGORY' | 'OVERALL';
  refId: string;
  customer: MeanWithN & { naCount: number; byType: { FF: MeanWithN; CB: MeanWithN } };
  self: MeanWithN;
  suppressed?: 'INSUFFICIENT_RESPONSES';
  rank?: number | null;
  rankOf?: number;
}

interface DistributionBucket {
  rating: number | null;
  label: string;
  count: number;
  pct: number;
}

interface ScoreSet {
  rows: ScoreRow[];
  distribution: DistributionBucket[];
}

interface AirportScoreRow {
  cycleId: string;
  airportId: string;
  surveyType: 'DOMESTIC' | 'INTERNATIONAL';
  level: ScoreRow['level'];
  refId: string;
  mean: number | null;
  marketShareApplied: boolean;
  coveredSharePct: number;
  operators: { acoId: string; mean: number | null; sharePct: number | null; suppressed: boolean }[];
  rank: number | null;
  rankOf: number;
  provisional: boolean;
  computedAt: string;
}

interface NationalRow {
  airportId: string;
  iata: string;
  name: string;
  mean: number | null;
  rank: number | null;
  rankOf: number;
  marketShareApplied: boolean;
  coveredSharePct: number;
  provisional: boolean;
  computedAt: string;
}

const COMPUTED_AT = '2026-10-07T01:00:00.000Z';

const scoring = vi.hoisted(() => ({
  scores: new Map<string, ScoreSet>(),
  airportScores: new Map<string, AirportScoreRow[]>(),
  national: new Map<string, NationalRow[]>(),
}));

vi.mock('../src/modules/scoring/scoring.service.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    runCycle: async () => undefined,
    getScores: async (cycleId: string, acoId: string, surveyType: string) => {
      const set = scoring.scores.get(`${cycleId}:${acoId}:${surveyType}`);
      return {
        cycleId,
        acoId,
        surveyType,
        surveyId: set ? 'pinned' : null,
        provisional: set ? true : null,
        computedAt: set ? COMPUTED_AT : null,
        rows: set?.rows ?? [],
        distribution: set?.distribution ?? [],
        counts: { customer: 0, self: 0, FF: 0, CB: 0 },
      };
    },
    getAirportScores: async (cycleId: string, airportId: string) => scoring.airportScores.get(`${cycleId}:${airportId}`) ?? [],
    nationalTable: async (cycleId: string, surveyType: string) => scoring.national.get(`${cycleId}:${surveyType}`) ?? [],
  };
});

function row(level: ScoreRow['level'], refId: string, mean: number | null, n: number, extra: Partial<ScoreRow> = {}): ScoreRow {
  return {
    level,
    refId,
    customer: { mean, n, naCount: 0, byType: { FF: { mean, n: Math.ceil(n / 2) }, CB: { mean, n: Math.floor(n / 2) } } },
    self: { mean: null, n: 0 },
    ...extra,
  };
}

// --- the flow ------------------------------------------------------------------

const DAY = 86_400_000;
const TZ = 'Asia/Kolkata';

let t: TestApp;
let superAdmin: TestUser;
let adminA: TestUser;
let adminB: TestUser;
let airportDel: TestUser;
let survey: TestSurvey;
let del: string;
let bom: string;
let a: string;
let b: string;
let c: string;
let cycleId: string;
let draftCycleId: string;
let nodeIds: { INFRA: string; STORAGE: string; PROC: string };

async function createCycle(code: string, acoIds: string[], airportIds: string[]): Promise<string> {
  const now = Date.now();
  const res = await superAdmin.post('/api/v1/cycles').send({
    name: `Reports flow ${code}`,
    code,
    type: 'DOMESTIC',
    sampling: { start: fromInstant(new Date(now - DAY), TZ), end: fromInstant(new Date(now + DAY), TZ) },
    assessment: { start: fromInstant(new Date(now + DAY), TZ), end: fromInstant(new Date(now + 31 * DAY), TZ) },
    minSampleSize: 1,
    participatingAirportIds: airportIds,
    participatingAcoIds: acoIds,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function transition(to: string): Promise<void> {
  const res = await superAdmin.post(`/api/v1/cycles/${cycleId}/transition`).send({ to, reason: 'Reports flow test' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.data.status).toBe(to);
}

/** One customer's assessment, created as the invitations flow would and submitted through its link session. */
async function submitCustomerAssessment(acoId: string, customerId: string, answers: AnswerInput[]): Promise<string> {
  const invitationId = newId();
  const created = await getOrCreateForInvitation({ _id: invitationId, cycleId, acoId, customerId, surveyType: 'DOMESTIC' });
  await patchAnswers(created.id, answers);
  const link: LinkSession = {
    audience: 'participant',
    subject: idString(invitationId),
    claims: { inv: idString(invitationId), asg: created.id, aco: acoId },
    expiresAt: new Date(Date.now() + 3_600_000),
  };
  const submitted = await submit(link, created.id);
  expect(submitted.status).toBe('SUBMITTED');
  return created.id;
}

/** What the answers submitted below add up to, as the scoring run would store it (rows keyed by code). */
function seedScores(): void {
  scoring.scores.set(`${cycleId}:${a}:DOMESTIC`, {
    rows: [
      row('OVERALL', 'OVERALL', 4.25, 2, { rank: 1, rankOf: 1, self: { mean: 4.5, n: 1 } }),
      row('CATEGORY', 'INFRA', 4.3, 2),
      row('SUBCATEGORY', 'STORAGE', 4.33, 2),
      row('QUESTION', 'Q.OPT', 4.5, 2),
      row('QUESTION', 'Q.REQ', 4, 1, { customer: { mean: 4, n: 1, naCount: 1, byType: { FF: { mean: 4, n: 1 }, CB: { mean: null, n: 0 } } } }),
      row('CATEGORY', 'PROC', 4.2, 2),
      row('QUESTION', 'Q.PLAIN', 4, 1, { customer: { mean: 4, n: 1, naCount: 1, byType: { FF: { mean: null, n: 0 }, CB: { mean: 4, n: 1 } } } }),
    ],
    distribution: [
      { rating: 5, label: 'Excellent', count: 2, pct: 25 },
      { rating: 4, label: 'Very Good', count: 3, pct: 37.5 },
      { rating: 3, label: 'Good', count: 1, pct: 12.5 },
      { rating: 2, label: 'Fair', count: 0, pct: 0 },
      { rating: 1, label: 'Poor', count: 0, pct: 0 },
      { rating: null, label: 'NA', count: 2, pct: 25 },
    ],
  });
  scoring.scores.set(`${cycleId}:${b}:DOMESTIC`, {
    rows: [row('OVERALL', 'OVERALL', null, 1, { suppressed: 'INSUFFICIENT_RESPONSES', rank: null, rankOf: 1 })],
    distribution: [],
  });
  scoring.airportScores.set(`${cycleId}:${del}`, [
    {
      cycleId,
      airportId: del,
      surveyType: 'DOMESTIC',
      level: 'OVERALL',
      refId: 'OVERALL',
      mean: 4.25,
      marketShareApplied: true,
      coveredSharePct: 60,
      operators: [
        { acoId: a, mean: 4.25, sharePct: 60, suppressed: false },
        { acoId: b, mean: null, sharePct: 40, suppressed: true },
      ],
      rank: 1,
      rankOf: 1,
      provisional: true,
      computedAt: COMPUTED_AT,
    },
    {
      cycleId,
      airportId: del,
      surveyType: 'DOMESTIC',
      level: 'CATEGORY',
      refId: 'INFRA',
      mean: 4.3,
      marketShareApplied: true,
      coveredSharePct: 60,
      operators: [],
      rank: 1,
      rankOf: 1,
      provisional: true,
      computedAt: COMPUTED_AT,
    },
  ]);
  scoring.national.set(`${cycleId}:DOMESTIC`, [
    { airportId: del, iata: 'DEL', name: 'Indira Gandhi International Airport', mean: 4.25, rank: 1, rankOf: 1, marketShareApplied: true, coveredSharePct: 60, provisional: true, computedAt: COMPUTED_AT },
    { airportId: bom, iata: 'BOM', name: 'Chhatrapati Shivaji Maharaj International Airport', mean: null, rank: null, rankOf: 1, marketShareApplied: false, coveredSharePct: 0, provisional: true, computedAt: COMPUTED_AT },
  ]);
}

beforeAll(async () => {
  t = await createTestApp();
  // Only cycles listens here: participant stats on submit, SCORED on scoring.completed.
  clearEventHandlers();
  registerCycleHandlers();

  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  [del, bom] = await Promise.all([airportIdByIata('DEL'), airportIdByIata('BOM')]);
  const [orgA, orgB, orgC] = await Promise.all([
    createTestOperator({ code: 'RPTF-A', name: 'Alpha Flow Cargo', airportIata: 'DEL' }),
    createTestOperator({ code: 'RPTF-B', name: 'Bravo Flow Cargo', airportIata: 'DEL' }),
    createTestOperator({ code: 'RPTF-C', name: 'Charlie Flow Cargo', airportIata: 'BOM' }),
  ]);
  [a, b, c] = [idString(orgA._id), idString(orgB._id), idString(orgC._id)];
  await setCurrentShare({ airportId: toId(del), acoId: orgA._id, sharePct: 60, setBy: null });
  await setCurrentShare({ airportId: toId(del), acoId: orgB._id, sharePct: 40, setBy: null });
  await setCurrentShare({ airportId: toId(bom), acoId: orgC._id, sharePct: 100, setBy: null });
  adminA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: a });
  adminB = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: b });
  airportDel = await t.asUser({ orgType: 'AIRPORT', roleCode: 'AIRPORT_ADMIN', orgCode: 'RPTF-AIRPORT-DEL', airportIata: 'DEL' });

  survey = await createTestSurvey('DOMESTIC');
  const tree = await superAdmin.get(`/api/v1/surveys/${survey.id}`);
  const categories = tree.body.data.categories as { code: string; id: string; subcategories: { code: string; id: string }[] }[];
  const infra = categories.find((category) => category.code === 'INFRA')!;
  nodeIds = { INFRA: infra.id, STORAGE: infra.subcategories[0]!.id, PROC: categories.find((category) => category.code === 'PROC')!.id };

  cycleId = await createCycle('RPTF-2026-1', [a, b, c], [del, bom]);
  draftCycleId = await createCycle('RPTF-DRAFT', [a], [del]);
  const published = await superAdmin.post(`/api/v1/cycles/${cycleId}/publish`);
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  expect(published.body.data.status).toBe('SAMPLING_OPEN');
  await transition('SAMPLING_CLOSED');
  await transition('ASSESSMENT_OPEN');

  const ff1 = await createTestCustomer({ acoId: a, airportId: del, name: 'FF One', contactPerson: 'Meera Nair', email: 'meera@ff-one.test', type: 'FF' });
  const cb1 = await createTestCustomer({ acoId: a, airportId: del, name: 'CB One', contactPerson: 'Ravi Shah', email: 'ravi@cb-one.test', type: 'CB' });
  const ff2 = await createTestCustomer({ acoId: b, airportId: del, name: 'FF Two', contactPerson: 'Anil Kumar', email: 'anil@ff-two.test', type: 'FF' });
  const q = survey.q;
  await submitCustomerAssessment(a, ff1, [
    { questionId: q['Q.OPT']!, rating: 5, comment: 'Excellent storage' },
    { questionId: q['Q.REQ']!, rating: 4, comment: 'Fine' },
    { questionId: q['Q.LOW']!, rating: 3 },
    { questionId: q['Q.PLAIN']!, na: true },
  ]);
  await submitCustomerAssessment(a, cb1, [
    { questionId: q['Q.OPT']!, rating: 4 },
    { questionId: q['Q.REQ']!, na: true, comment: 'Not used this quarter' },
    { questionId: q['Q.NONE']!, rating: 5 },
    { questionId: q['Q.PLAIN']!, rating: 4, comment: 'Smooth' },
  ]);
  await submitCustomerAssessment(b, ff2, [
    { questionId: q['Q.OPT']!, rating: 3 },
    { questionId: q['Q.REQ']!, rating: 3, comment: 'ok' },
    { questionId: q['Q.LOW']!, rating: 2, comment: 'Slow' },
    { questionId: q['Q.PLAIN']!, rating: 3 },
  ]);
  seedScores();
});
afterAll(() => t.close());

describe('reports over the real cycle, survey and assessment documents', () => {
  it('the submissions reached the participant through the cycles listener', async () => {
    expect((await getParticipant(cycleId, a))?.stats).toEqual({ invited: 0, started: 0, completed: 2 });
    expect((await getParticipant(cycleId, b))?.stats).toEqual({ invited: 0, started: 0, completed: 1 });
    expect((await getParticipant(cycleId, c))?.stats).toEqual({ invited: 0, started: 0, completed: 0 });
  });

  it('operator dashboard: the live cycle by default, flagged provisional, with the real survey, funnel and answers', async () => {
    const res = await adminA.get(`/api/v1/reports/operator/${a}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const report = res.body.data;
    expect(report).toMatchObject({
      cycle: { id: cycleId, code: 'RPTF-2026-1', type: 'DOMESTIC', status: 'ASSESSMENT_OPEN', scoredAt: null },
      surveyType: 'DOMESTIC',
      provisional: true,
      operator: { id: a, code: 'RPTF-A', name: 'Alpha Flow Cargo', airport: { id: del, iata: 'DEL' } },
      overall: { customer: { mean: 4.25, n: 2 }, self: { mean: 4.5 }, rank: 1, rankOf: 1 },
      comparison: { current: { cycleId, customer: 4.25, self: 4.5 }, previous: null },
      byStakeholder: { FF: { mean: 4.25, n: 1 }, CB: { mean: 4.25, n: 1 } },
      assessorStats: { total: 0, completed: 2, inProgress: 0, yetToStart: 0 },
      // Counted live from the real assessments module: two customers submitted, no self-assessment yet.
      assessments: { total: 2, customer: 2, self: 0 },
      // The seeded Phase-I airports, whether or not they took part.
      airportsTotal: 14,
    });
    expect(new Date(report.cycle.assessment.start).getTime()).toBeGreaterThan(Date.now());
    expect(report.feedbackDistribution).toEqual([
      { rating: 5, label: 'Excellent', count: 2, pct: 25 },
      { rating: 4, label: 'Very Good', count: 3, pct: 37.5 },
      { rating: 3, label: 'Good', count: 1, pct: 12.5 },
      { rating: 2, label: 'Fair', count: 0, pct: 0 },
      { rating: 1, label: 'Poor', count: 0, pct: 0 },
      { rating: null, label: 'NA', count: 2, pct: 25 },
    ]);
    expect(report.categories).toEqual([
      {
        id: nodeIds.INFRA,
        code: 'INFRA',
        name: 'Infrastructure',
        customer: { mean: 4.3, n: 2 },
        self: { mean: null },
        previous: null,
        delta: null,
        subcategories: [{ id: nodeIds.STORAGE, code: 'STORAGE', name: 'Storage', customer: { mean: 4.33, n: 2 }, self: { mean: null }, previous: null, delta: null }],
      },
      { id: nodeIds.PROC, code: 'PROC', name: 'Processes', customer: { mean: 4.2, n: 2 }, self: { mean: null }, previous: null, delta: null, subcategories: [] },
    ]);
    expect(report.nationalTable).toEqual([
      { airportIata: 'DEL', airportName: 'Indira Gandhi International Airport', rating: 4.25, rank: 1, rankOf: 1, isOwn: true },
      { airportIata: 'BOM', airportName: 'Chhatrapati Shivaji Maharaj International Airport', rating: null, rank: null, rankOf: 1, isOwn: false },
    ]);
    expect(JSON.stringify(report)).not.toContain('Bravo');
  });

  it('question table: the active questions of the pinned version in survey order, with comment counts from the answers', async () => {
    const res = await adminA.get(`/api/v1/reports/operator/${a}/questions`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const questions = res.body.data.questions as { code: string; comments: number; subcategory: { code: string } | null; customer: { mean: number | null; n: number; naCount: number } }[];
    expect(questions.map((q) => [q.code, q.subcategory?.code ?? null, q.comments])).toEqual([
      ['Q.OPT', 'STORAGE', 1],
      ['Q.REQ', 'STORAGE', 2],
      ['Q.LOW', null, 0],
      ['Q.NONE', null, 0],
      ['Q.PLAIN', null, 1],
    ]);
    expect(questions[1]!.customer).toEqual({ mean: 4, n: 1, naCount: 1 });
    expect(questions[2]!.customer).toEqual({ mean: null, n: 0, naCount: 0 });
  });

  it('cycle visibility comes from cycles: a DRAFT cycle is 404 for the operator and for the platform without a participant', async () => {
    expectError(await adminA.get(`/api/v1/reports/operator/${a}?cycleId=${draftCycleId}`), 404, 'NOT_FOUND');
    expectError(await superAdmin.get(`/api/v1/reports/operator/${a}?cycleId=${draftCycleId}`), 404, 'NOT_FOUND');
    expectError(await adminB.get(`/api/v1/reports/operator/${a}`), 404, 'NOT_FOUND');
    expectError(await adminA.get(`/api/v1/reports/operator/${a}?surveyType=INTERNATIONAL`), 404, 'NOT_FOUND');
  });

  it('airport report: the cycle’s participants at the airport, the operators table for the airport organisation only', async () => {
    const own = await airportDel.get(`/api/v1/reports/airport/${del}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data).toMatchObject({
      cycle: { id: cycleId },
      provisional: true,
      airport: { id: del, iata: 'DEL' },
      overall: { mean: 4.25, coveredSharePct: 60, marketShareApplied: true, rank: 1, rankOf: 1 },
      operators: [
        { acoId: a, code: 'RPTF-A', name: 'Alpha Flow Cargo', mean: 4.25, sharePct: 60, suppressed: false },
        { acoId: b, code: 'RPTF-B', name: 'Bravo Flow Cargo', mean: null, sharePct: 40, suppressed: true },
      ],
    });
    expect(own.body.data.categories).toEqual([
      { id: nodeIds.INFRA, code: 'INFRA', name: 'Infrastructure', mean: 4.3, coveredSharePct: 60, marketShareApplied: true },
      { id: nodeIds.PROC, code: 'PROC', name: 'Processes', mean: null, coveredSharePct: 0, marketShareApplied: false },
    ]);
    expectError(await airportDel.get(`/api/v1/reports/airport/${bom}`), 404, 'NOT_FOUND');

    const unscored = await superAdmin.get(`/api/v1/reports/airport/${bom}`);
    expect(unscored.status).toBe(200);
    expect(unscored.body.data).toMatchObject({ overall: { mean: null, coveredSharePct: 0, marketShareApplied: false, rank: null, rankOf: 0 } });
    expect(unscored.body.data.operators).toEqual([{ acoId: c, code: 'RPTF-C', name: 'Charlie Flow Cargo', mean: null, sharePct: null, suppressed: true }]);
  });

  it('national report: participation counted from the real participants, operators ranked with names', async () => {
    const res = await superAdmin.get('/api/v1/reports/national');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ cycle: { id: cycleId }, surveyType: 'DOMESTIC', provisional: true });
    expect(res.body.data.participation).toEqual({ airports: 2, operators: 3, sampleLocked: 0, invited: 0, started: 0, completed: 3, pending: 0, completionRate: 0 });
    expect((res.body.data.operators as { code: string; rating: number | null; rank: number | null }[]).map((o) => [o.code, o.rating, o.rank])).toEqual([
      ['RPTF-A', 4.25, 1],
      ['RPTF-B', null, null],
      ['RPTF-C', null, null],
    ]);
    expect((res.body.data.airports as { iata: string; rank: number | null }[]).map((o) => [o.iata, o.rank])).toEqual([['DEL', 1], ['BOM', null]]);
    expect(res.body.data.categories).toEqual([
      { id: nodeIds.INFRA, code: 'INFRA', name: 'Infrastructure', mean: 4.3, n: 1 },
      { id: nodeIds.PROC, code: 'PROC', name: 'Processes', mean: 4.2, n: 1 },
    ]);
  });

  it('once scoring completes and cycles marks the cycle SCORED, the default report is final', async () => {
    await transition('ASSESSMENT_CLOSED');
    await emit('scoring.completed', { cycleId, provisional: false }, { ctx: systemContext('reports flow test') });
    const res = await adminA.get(`/api/v1/reports/operator/${a}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ cycle: { id: cycleId, status: 'SCORED' }, provisional: false });
    expect(res.body.data.cycle.scoredAt).not.toBeNull();

    const comparison = await adminA.get(`/api/v1/reports/comparison?acoId=${a}&cycleIds=${cycleId}`);
    expect(comparison.status).toBe(200);
    expect(comparison.body.data.cycles).toEqual([expect.objectContaining({ id: cycleId, status: 'SCORED', provisional: false })]);
    expect((comparison.body.data.questions as { code: string; parentCode: string }[]).map((q) => [q.code, q.parentCode])).toEqual([
      ['Q.OPT', 'STORAGE'],
      ['Q.REQ', 'STORAGE'],
      ['Q.LOW', 'INFRA'],
      ['Q.NONE', 'PROC'],
      ['Q.PLAIN', 'PROC'],
    ]);

    const csv = await adminA.get(`/api/v1/reports/export?scope=operator&acoId=${a}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="csq-operator-RPTF-A-RPTF-2026-1-DOMESTIC.csv"');
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toBe('level,code,name,customer_mean,customer_n,self_mean,previous_mean,delta,suppressed,comments');
    expect(lines[1]).toBe('OVERALL,OVERALL,Overall,4.25,2,4.5,,,,');
    expect(lines).toHaveLength(1 + 1 + 2 + 1 + 5);
  });
});
