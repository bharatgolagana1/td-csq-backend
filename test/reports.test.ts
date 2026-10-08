// Route-level tests of the reports module. The lower features reports composes
// over (cycles, scoring, assessments, surveys) are replaced at the module's
// one seam, `reports.sources.ts`, with in-memory fixtures shaped exactly like
// the `scores` / `airport_scores` / `cycles` / `cycle_participants` documents
// of ARCHITECTURE §5 (score rows keyed by the survey node's code, as the
// scoring module publishes them); organisations and airports are the real ones.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { idString } from '../src/core/ids.js';
import type {
  AirportScoreView,
  CycleView,
  NationalRowView,
  ParticipantView,
  ScoreLevel,
  ScoreRowView,
  ScoreSetView,
  SubmittedAssessmentView,
  SurveyTreeView,
} from '../src/modules/reports/reports.sources.js';

import { createTestApp, type TestApp, type TestUser } from './helpers/app.js';
import { airportIdByIata, createTestOperator, expectError, grantTasks } from './helpers/fixtures.js';

// --- fixtures (hoisted so the mock factory can see them) ---------------------

const store = vi.hoisted(() => ({
  cycles: new Map<string, CycleView>(),
  participants: [] as ParticipantView[],
  scores: new Map<string, ScoreSetView>(),
  airportScores: new Map<string, AirportScoreView[]>(),
  national: new Map<string, NationalRowView[]>(),
  trees: new Map<string, SurveyTreeView>(),
  assessments: new Map<string, SubmittedAssessmentView[]>(),
  /** SUBMITTED self-assessments per `cycle:aco:surveyType` (the customer ones are counted from `assessments`). */
  selfSubmitted: new Map<string, number>(),
}));

vi.mock('../src/modules/reports/reports.sources.js', async () => {
  const { idString: asString } = await import('../src/core/ids.js');
  const { AppError } = await import('../src/core/errors.js');
  const { findOrganisationById, findOrganisationsByIds } = await import('../src/modules/organisations/organisations.service.js');
  const { findAirportById, findAirportsByIds, listAirports } = await import('../src/modules/airports/airports.service.js');
  interface Ctx {
    scope: { kind: 'PLATFORM' } | { kind: 'ACO'; acoId: string } | { kind: 'AIRPORT'; airportId: string };
  }

  const visible = (ctx: Ctx, cycle: CycleView): boolean => {
    const members = store.participants.filter((p) => p.cycleId === cycle.id);
    switch (ctx.scope.kind) {
      case 'PLATFORM':
        return true;
      case 'ACO':
        return members.some((p) => p.acoId === (ctx.scope as { acoId: string }).acoId);
      case 'AIRPORT':
        return members.some((p) => p.airportId === (ctx.scope as { airportId: string }).airportId);
    }
  };
  const includes = (cycle: CycleView, filter: { acoId?: string; airportId?: string }): boolean =>
    store.participants.some(
      (p) => p.cycleId === cycle.id && (!filter.acoId || p.acoId === filter.acoId) && (!filter.airportId || p.airportId === filter.airportId),
    );

  return {
    OVERALL_REF_ID: 'OVERALL',
    loadCycle: async (ctx: Ctx, id: string) => {
      const cycle = store.cycles.get(id);
      return cycle && visible(ctx, cycle) ? cycle : null;
    },
    loadCycleRefs: async (ctx: Ctx, filter: { acoId?: string; airportId?: string }) =>
      [...store.cycles.values()].filter((cycle) => visible(ctx, cycle) && includes(cycle, filter)),
    loadParticipant: async (cycleId: string, acoId: string) =>
      store.participants.find((p) => p.cycleId === cycleId && p.acoId === acoId) ?? null,
    loadParticipants: async (cycleId: string) => store.participants.filter((p) => p.cycleId === cycleId),
    loadScores: async (cycleId: string, acoId: string, surveyType: string) =>
      store.scores.get(`${cycleId}:${acoId}:${surveyType}`) ?? { rows: [], distribution: [] },
    loadAirportScores: async (cycleId: string, airportId: string, surveyType: string) =>
      (store.airportScores.get(`${cycleId}:${airportId}`) ?? []).filter((row) => row.surveyType === surveyType),
    loadNationalTable: async (cycleId: string, surveyType: string) => store.national.get(`${cycleId}:${surveyType}`) ?? [],
    loadSurveyTree: async (surveyId: string) => {
      const tree = store.trees.get(surveyId);
      if (!tree) throw new AppError('NOT_FOUND', 'Survey not found');
      return tree;
    },
    loadSubmittedCustomerAssessments: async (cycleId: string, acoId: string, surveyType: string) =>
      store.assessments.get(`${cycleId}:${acoId}:${surveyType}`) ?? [],
    loadSubmittedAssessmentCounts: async (cycleId: string, acoId: string, surveyType: string) => {
      const customer = (store.assessments.get(`${cycleId}:${acoId}:${surveyType}`) ?? []).length;
      const self = store.selfSubmitted.get(`${cycleId}:${acoId}:${surveyType}`) ?? 0;
      return { total: customer + self, customer, self };
    },
    countActiveAirports: async () => (await listAirports({ page: 1, pageSize: 1, active: true })).meta.total,
    loadOperator: async (acoId: string) => {
      const doc = await findOrganisationById(acoId);
      return doc?.type === 'ACO'
        ? { id: asString(doc._id), code: doc.code, name: doc.name, airportId: doc.airportId ? asString(doc.airportId) : null, status: doc.status }
        : null;
    },
    loadOperators: async (acoIds: Iterable<string>) => {
      const docs = await findOrganisationsByIds(acoIds);
      return new Map(
        [...docs.values()].map((doc) => [
          asString(doc._id),
          { id: asString(doc._id), code: doc.code, name: doc.name, airportId: doc.airportId ? asString(doc.airportId) : null, status: doc.status },
        ]),
      );
    },
    loadAirport: async (airportId: string) => {
      const doc = await findAirportById(airportId);
      return doc ? { id: asString(doc._id), iata: doc.iata, name: doc.name } : null;
    },
    loadAirports: async (airportIds: Iterable<string>) => {
      const docs = await findAirportsByIds(airportIds);
      return new Map([...docs.values()].map((doc) => [asString(doc._id), { id: asString(doc._id), iata: doc.iata, name: doc.name }]));
    },
  };
});

const hex = (n: number): string => n.toString(16).padStart(24, '0');
const CYCLE = { prev: hex(1), scored: hex(2), live: hex(3), draft: hex(4) } as const;
const OVERALL = 'OVERALL';
const DEL_NAME = 'Indira Gandhi International Airport';
const BOM_NAME = 'Chhatrapati Shivaji Maharaj International Airport';

function question(id: string, code: string, text: string, order: number, active = true) {
  return { id, code, text, order, active };
}

/** The same survey structure under two version ids: node ids differ, codes match (as a new version does). */
function tree(prefix: string): SurveyTreeView {
  return {
    id: prefix,
    categories: [
      {
        id: `${prefix}-SEC`,
        code: 'SEC',
        name: 'Security and safety',
        order: 20,
        subcategories: [],
        questions: [question(`${prefix}-Q4`, 'ACFI.SEC.SCREENING', 'Screening of cargo', 1), question(`${prefix}-Q5`, 'ACFI.SEC.OLD', 'Retired', 2, false)],
      },
      {
        id: `${prefix}-INFRA`,
        code: 'INFRA',
        name: 'Infrastructure and facilities',
        order: 10,
        subcategories: [
          {
            id: `${prefix}-STORAGE`,
            code: 'INFRA.STORAGE',
            name: 'Storage',
            order: 1,
            questions: [question(`${prefix}-Q1`, 'ACFI.INFRA.CAPACITY', 'Storage capacity', 1), question(`${prefix}-Q2`, 'ACFI.INFRA.COLD', 'Cold storage', 2)],
          },
        ],
        questions: [question(`${prefix}-Q3`, 'ACFI.INFRA.AMENITIES', 'User amenities', 3)],
      },
    ],
  };
}

interface RowOptions {
  n?: number;
  naCount?: number;
  self?: number | null;
  FF?: { mean: number | null; n: number };
  CB?: { mean: number | null; n: number };
  suppressed?: true;
  rank?: number | null;
  rankOf?: number;
  previous?: { cycleId: string; mean: number | null };
  delta?: number;
}

/** A `scores` row; `refId` is the node's code. */
function row(level: ScoreLevel, refId: string, mean: number | null, options: RowOptions = {}): ScoreRowView {
  const n = options.n ?? 8;
  return {
    level,
    refId,
    customer: {
      mean,
      n,
      naCount: options.naCount ?? 0,
      byType: { FF: options.FF ?? { mean, n: Math.ceil(n / 2) }, CB: options.CB ?? { mean, n: Math.floor(n / 2) } },
    },
    self: { mean: options.self ?? null, n: options.self === null || options.self === undefined ? 0 : 1 },
    ...(options.suppressed ? { suppressed: 'INSUFFICIENT_RESPONSES' as const } : {}),
    ...(options.rank !== undefined ? { rank: options.rank } : {}),
    ...(options.rankOf !== undefined ? { rankOf: options.rankOf } : {}),
    ...(options.previous ? { previous: options.previous } : {}),
    ...(options.delta !== undefined ? { delta: options.delta } : {}),
  };
}

function set(rows: ScoreRowView[], distribution: ScoreSetView['distribution'] = []): ScoreSetView {
  return { rows, distribution };
}

const DISTRIBUTION_A: ScoreSetView['distribution'] = [
  { rating: 5, label: 'Excellent', count: 4, pct: 33.33 },
  { rating: 4, label: 'Very Good', count: 5, pct: 41.67 },
  { rating: 3, label: 'Good', count: 1, pct: 8.33 },
  { rating: 2, label: 'Fair', count: 0, pct: 0 },
  { rating: 1, label: 'Poor', count: 0, pct: 0 },
  { rating: null, label: 'NA', count: 2, pct: 16.67 },
];

function cycle(id: string, patch: Partial<CycleView> & Pick<CycleView, 'code' | 'name' | 'type' | 'status'>): CycleView {
  return {
    id,
    assessment: { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-03-31T23:59:00Z') },
    scoredAt: null,
    createdAt: new Date('2026-02-01T00:00:00Z'),
    surveyVersions: { DOMESTIC: 'S1' },
    ...patch,
  };
}

function participant(cycleId: string, acoId: string, airportId: string, patch: Partial<ParticipantView> = {}): ParticipantView {
  return {
    cycleId,
    acoId,
    airportId,
    surveyTypes: ['DOMESTIC'],
    sampling: { status: 'LOCKED', selectedCount: 50 },
    stats: { invited: 0, started: 0, completed: 0 },
    ...patch,
  };
}

function assessment(id: string, customerType: 'FF' | 'CB', answers: [string, number | null, string?][]): SubmittedAssessmentView {
  return {
    id,
    kind: 'CUSTOMER',
    surveyType: 'DOMESTIC',
    customerType,
    answers: answers.map(([questionId, rating, comment]) => ({
      questionId,
      rating: rating as SubmittedAssessmentView['answers'][number]['rating'],
      na: rating === null,
      comment: comment ?? null,
    })),
  };
}

// --- suite -------------------------------------------------------------------

let t: TestApp;
let superAdmin: TestUser;
let adminA: TestUser;
let adminB: TestUser;
let airportDel: TestUser;
let airportBom: TestUser;
let del: string;
let bom: string;
let hyd: string;
let a: string;
let b: string;
let c: string;
let d: string;

function seedFixtures(): void {
  store.cycles.set(CYCLE.prev, cycle(CYCLE.prev, { code: 'CSQ-2025-2', name: 'Cycle 2025 H2', type: 'DOMESTIC', status: 'SCORED', scoredAt: new Date('2025-11-01T00:00:00Z'), createdAt: new Date('2025-09-01T00:00:00Z'), assessment: { start: new Date('2025-10-01T00:00:00Z'), end: new Date('2025-10-31T23:59:00Z') }, surveyVersions: { DOMESTIC: 'S0' } }));
  store.cycles.set(CYCLE.scored, cycle(CYCLE.scored, { code: 'CSQ-2026-1', name: 'Cycle 2026 H1', type: 'BOTH', status: 'SCORED', scoredAt: new Date('2026-04-01T00:00:00Z'), surveyVersions: { DOMESTIC: 'S1', INTERNATIONAL: 'S1' } }));
  store.cycles.set(CYCLE.live, cycle(CYCLE.live, { code: 'CSQ-2026-2', name: 'Cycle 2026 H2', type: 'DOMESTIC', status: 'ASSESSMENT_OPEN', createdAt: new Date('2026-08-01T00:00:00Z'), assessment: { start: new Date('2026-09-15T00:00:00Z'), end: new Date('2026-10-15T23:59:00Z') } }));
  store.cycles.set(CYCLE.draft, cycle(CYCLE.draft, { code: 'CSQ-2027-1', name: 'Cycle 2027 H1', type: 'DOMESTIC', status: 'DRAFT', createdAt: new Date('2026-10-01T00:00:00Z'), surveyVersions: {} }));

  store.participants.push(
    participant(CYCLE.prev, a, del, { stats: { invited: 10, started: 8, completed: 6 } }),
    participant(CYCLE.prev, b, del, { stats: { invited: 10, started: 10, completed: 9 } }),
    participant(CYCLE.scored, a, del, { surveyTypes: ['DOMESTIC', 'INTERNATIONAL'], stats: { invited: 20, started: 12, completed: 8 } }),
    participant(CYCLE.scored, b, del, { stats: { invited: 10, started: 10, completed: 10 } }),
    participant(CYCLE.scored, c, bom, { sampling: { status: 'IN_PROGRESS', selectedCount: 12 }, stats: { invited: 5, started: 1, completed: 1 } }),
    participant(CYCLE.live, a, del, { stats: { invited: 30, started: 5, completed: 2 } }),
    participant(CYCLE.live, d, hyd),
  );

  store.trees.set('S0', tree('S0'));
  store.trees.set('S1', tree('S1'));

  store.scores.set(
    `${CYCLE.scored}:${a}:DOMESTIC`,
    set(
      [
        row('OVERALL', OVERALL, 4.25, { self: 4.6, FF: { mean: 4.5, n: 5 }, CB: { mean: 4, n: 3 }, rank: 1, rankOf: 2, previous: { cycleId: CYCLE.prev, mean: 4 }, delta: 0.25 }),
        row('CATEGORY', 'INFRA', 4.4, { self: 4.7, previous: { cycleId: CYCLE.prev, mean: 4.1 }, delta: 0.3 }),
        row('SUBCATEGORY', 'INFRA.STORAGE', 4.3, { previous: { cycleId: CYCLE.prev, mean: 4.3 }, delta: 0 }),
        row('QUESTION', 'ACFI.INFRA.CAPACITY', 4.5, { naCount: 1, previous: { cycleId: CYCLE.prev, mean: 4.2 }, delta: 0.3 }),
        row('QUESTION', 'ACFI.INFRA.COLD', 4.1),
        row('QUESTION', 'ACFI.INFRA.AMENITIES', 4.4),
        row('CATEGORY', 'SEC', 4.1, { self: 4.5, previous: { cycleId: CYCLE.prev, mean: null } }),
        row('QUESTION', 'ACFI.SEC.SCREENING', null, { n: 2, suppressed: true }),
      ],
      DISTRIBUTION_A,
    ),
  );
  store.scores.set(`${CYCLE.scored}:${a}:INTERNATIONAL`, set([row('OVERALL', OVERALL, 3.95, { n: 4, rank: 1, rankOf: 1 })]));
  store.scores.set(
    `${CYCLE.scored}:${b}:DOMESTIC`,
    set([
      row('OVERALL', OVERALL, 3.9, { n: 10, self: 4.1, rank: 2, rankOf: 2, previous: { cycleId: CYCLE.prev, mean: 4.2 }, delta: -0.3 }),
      row('CATEGORY', 'INFRA', 3.8, { n: 10 }),
      row('CATEGORY', 'SEC', 4, { n: 10 }),
    ]),
  );
  store.scores.set(`${CYCLE.scored}:${c}:DOMESTIC`, set([row('OVERALL', OVERALL, null, { n: 1, suppressed: true, rank: null, rankOf: 2 })]));
  store.scores.set(
    `${CYCLE.prev}:${a}:DOMESTIC`,
    set([
      row('OVERALL', OVERALL, 4, { n: 6, self: 4.2, rank: 2, rankOf: 2 }),
      row('CATEGORY', 'INFRA', 4.1, { n: 6 }),
      row('SUBCATEGORY', 'INFRA.STORAGE', 4.3, { n: 6 }),
      row('QUESTION', 'ACFI.INFRA.CAPACITY', 4.2, { n: 6 }),
      row('CATEGORY', 'SEC', null, { n: 2, suppressed: true }),
    ]),
  );
  store.scores.set(`${CYCLE.live}:${a}:DOMESTIC`, set([row('OVERALL', OVERALL, 3.75, { n: 3, rank: 1, rankOf: 1 })]));

  store.airportScores.set(`${CYCLE.scored}:${del}`, [
    {
      surveyType: 'DOMESTIC',
      level: 'OVERALL',
      refId: OVERALL,
      mean: 4.11,
      marketShareApplied: true,
      coveredSharePct: 100,
      operators: [
        { acoId: b, mean: 3.9, sharePct: 40, suppressed: false },
        { acoId: a, mean: 4.25, sharePct: 60, suppressed: false },
      ],
      rank: 1,
      rankOf: 1,
    },
    { surveyType: 'DOMESTIC', level: 'CATEGORY', refId: 'INFRA', mean: 4.16, marketShareApplied: true, coveredSharePct: 100, operators: [], rank: 1, rankOf: 1 },
    { surveyType: 'INTERNATIONAL', level: 'OVERALL', refId: OVERALL, mean: 3.95, marketShareApplied: false, coveredSharePct: 100, operators: [{ acoId: a, mean: 3.95, sharePct: null, suppressed: false }], rank: 1, rankOf: 1 },
  ]);
  store.airportScores.set(`${CYCLE.scored}:${bom}`, [
    { surveyType: 'DOMESTIC', level: 'OVERALL', refId: OVERALL, mean: null, marketShareApplied: true, coveredSharePct: 0, operators: [{ acoId: c, mean: null, sharePct: 100, suppressed: true }], rank: null, rankOf: 1 },
  ]);
  store.national.set(`${CYCLE.scored}:DOMESTIC`, [
    { airportId: bom, iata: 'BOM', name: BOM_NAME, mean: null, rank: null, rankOf: 1, marketShareApplied: true, coveredSharePct: 0 },
    { airportId: del, iata: 'DEL', name: DEL_NAME, mean: 4.11, rank: 1, rankOf: 1, marketShareApplied: true, coveredSharePct: 100 },
  ]);

  store.assessments.set(`${CYCLE.scored}:${a}:DOMESTIC`, [
    assessment('as1', 'FF', [['S1-Q1', 5], ['S1-Q2', 4, 'Great cold rooms'], ['S1-Q3', 4], ['S1-Q4', null]]),
    assessment('as2', 'CB', [['S1-Q1', 4, 'ok'], ['S1-Q2', null], ['S1-Q3', 5], ['S1-Q4', 3]]),
    assessment('as3', 'FF', [['S1-Q1', 5], ['S1-Q2', 5], ['S1-Q3', 4], ['S1-Q4', 4, '  '], ['S1-Q5', 1, 'retired question']]),
  ]);
  store.selfSubmitted.set(`${CYCLE.scored}:${a}:DOMESTIC`, 1);
}

beforeAll(async () => {
  t = await createTestApp();
  superAdmin = await t.asUser({ orgType: 'ACFI', roleCode: 'SUPER_ADMIN', name: 'Platform Admin' });
  [del, bom, hyd] = await Promise.all([airportIdByIata('DEL'), airportIdByIata('BOM'), airportIdByIata('HYD')]);
  a = idString((await createTestOperator({ code: 'RPT-A', name: 'Alpha Cargo', airportIata: 'DEL' }))._id);
  b = idString((await createTestOperator({ code: 'RPT-B', name: 'Bravo Cargo', airportIata: 'DEL' }))._id);
  c = idString((await createTestOperator({ code: 'RPT-C', name: 'Charlie Cargo', airportIata: 'BOM' }))._id);
  d = idString((await createTestOperator({ code: 'RPT-D', name: 'Delta Cargo', airportIata: 'HYD' }))._id);
  adminA = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_ADMIN', orgId: a });
  adminB = await t.asUser({ orgType: 'ACO', roleCode: 'ACO_USER', orgId: b });
  airportDel = await t.asUser({ orgType: 'AIRPORT', roleCode: 'AIRPORT_ADMIN', orgCode: 'RPT-AIRPORT-DEL', airportIata: 'DEL' });
  airportBom = await t.asUser({ orgType: 'AIRPORT', roleCode: 'AIRPORT_VIEWER', orgCode: 'RPT-AIRPORT-BOM', airportIata: 'BOM' });
  seedFixtures();
});
afterAll(() => t.close());

describe('GET /reports/operator/:acoId', () => {
  it('returns the dashboard payload of ARCHITECTURE §6 with every figure at 2 dp', async () => {
    const res = await superAdmin.get(`/api/v1/reports/operator/${a}?cycleId=${CYCLE.scored}&surveyType=DOMESTIC`);
    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(Object.keys(report).sort()).toEqual(
      [
        'airportsTotal',
        'assessments',
        'assessorStats',
        'byStakeholder',
        'categories',
        'comparison',
        'cycle',
        'feedbackDistribution',
        'nationalTable',
        'operator',
        'overall',
        'provisional',
        'surveyType',
      ].sort(),
    );
    expect(report.cycle).toEqual({
      id: CYCLE.scored,
      code: 'CSQ-2026-1',
      name: 'Cycle 2026 H1',
      type: 'BOTH',
      status: 'SCORED',
      assessment: { start: '2026-03-01T00:00:00.000Z', end: '2026-03-31T23:59:00.000Z' },
      scoredAt: '2026-04-01T00:00:00.000Z',
    });
    expect(report.surveyType).toBe('DOMESTIC');
    expect(report.provisional).toBe(false);
    expect(report.operator).toEqual({ id: a, code: 'RPT-A', name: 'Alpha Cargo', airport: { id: del, iata: 'DEL', name: DEL_NAME } });
    expect(report.overall).toEqual({ customer: { mean: 4.25, n: 8 }, self: { mean: 4.6 }, rank: 1, rankOf: 2 });
    expect(report.comparison).toEqual({
      current: { cycleId: CYCLE.scored, cycleName: 'Cycle 2026 H1', customer: 4.25, self: 4.6 },
      previous: { cycleId: CYCLE.prev, cycleName: 'Cycle 2025 H2', customer: 4, self: 4.2 },
    });
    expect(report.byStakeholder).toEqual({ FF: { mean: 4.5, n: 5 }, CB: { mean: 4, n: 3 } });
    expect(report.assessorStats).toEqual({ total: 20, completed: 8, inProgress: 4, yetToStart: 8 });
    // "4 assessments · 1 self · 3 customer" — the SUBMITTED assessments behind the figures, by kind.
    expect(report.assessments).toEqual({ total: 4, customer: 3, self: 1 });
    // The Phase-I airports live on the platform, in the table or not ("+ N more airports live under Phase I").
    expect(report.airportsTotal).toBe(14);
  });

  it('orders categories and subcategories by the survey, matching score rows on code, with previous / delta / suppressed per level', async () => {
    const res = await superAdmin.get(`/api/v1/reports/operator/${a}?cycleId=${CYCLE.scored}`);
    const categories = res.body.data.categories as { code: string; subcategories: unknown[] }[];
    expect(categories.map((category) => category.code)).toEqual(['INFRA', 'SEC']);
    expect(categories[0]).toEqual({
      id: 'S1-INFRA',
      code: 'INFRA',
      name: 'Infrastructure and facilities',
      customer: { mean: 4.4, n: 8 },
      self: { mean: 4.7 },
      previous: 4.1,
      delta: 0.3,
      subcategories: [{ id: 'S1-STORAGE', code: 'INFRA.STORAGE', name: 'Storage', customer: { mean: 4.3, n: 8 }, self: { mean: null }, previous: 4.3, delta: 0 }],
    });
    expect(categories[1]).toMatchObject({ code: 'SEC', customer: { mean: 4.1, n: 8 }, previous: null, delta: null, subcategories: [] });
  });

  it('carries the feedback distribution of the scoring run, or six empty buckets before one exists', async () => {
    const scored = await superAdmin.get(`/api/v1/reports/operator/${a}?cycleId=${CYCLE.scored}`);
    expect(scored.body.data.feedbackDistribution).toEqual(DISTRIBUTION_A);
    const unscored = await superAdmin.get(`/api/v1/reports/operator/${d}?cycleId=${CYCLE.live}`);
    expect(unscored.body.data.feedbackDistribution).toEqual([
      { rating: 5, label: 'Excellent', count: 0, pct: 0 },
      { rating: 4, label: 'Very Good', count: 0, pct: 0 },
      { rating: 3, label: 'Good', count: 0, pct: 0 },
      { rating: 2, label: 'Fair', count: 0, pct: 0 },
      { rating: 1, label: 'Poor', count: 0, pct: 0 },
      { rating: null, label: 'NA', count: 0, pct: 0 },
    ]);
  });

  it('gives an ACO its national table as airport ratings and ranks only, never another operator, with its own airport flagged', async () => {
    const res = await adminA.get(`/api/v1/reports/operator/${a}?cycleId=${CYCLE.scored}`);
    expect(res.status).toBe(200);
    expect(res.body.data.nationalTable).toEqual([
      { airportIata: 'DEL', airportName: DEL_NAME, rating: 4.11, rank: 1, rankOf: 1, isOwn: true },
      { airportIata: 'BOM', airportName: BOM_NAME, rating: null, rank: null, rankOf: 1, isOwn: false },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('Bravo');
    expect(JSON.stringify(res.body)).not.toContain(b);

    // Charlie works at BOM: the same table, the other row flagged.
    const charlie = await superAdmin.get(`/api/v1/reports/operator/${c}?cycleId=${CYCLE.scored}`);
    expect((charlie.body.data.nationalTable as { airportIata: string; isOwn: boolean }[]).map((row) => [row.airportIata, row.isOwn])).toEqual([
      ['DEL', false],
      ['BOM', true],
    ]);
  });

  it('defaults to the latest SCORED cycle the operator took part in, else the live one flagged provisional', async () => {
    const latest = await adminA.get(`/api/v1/reports/operator/${a}`);
    expect(latest.status).toBe(200);
    expect(latest.body.data.cycle.id).toBe(CYCLE.scored);
    expect(latest.body.data.provisional).toBe(false);

    const explicit = await adminA.get(`/api/v1/reports/operator/${a}?cycleId=${CYCLE.live}`);
    expect(explicit.body.data).toMatchObject({ provisional: true, overall: { customer: { mean: 3.75, n: 3 } }, assessorStats: { total: 30, completed: 2, inProgress: 3, yetToStart: 25 } });
    expect(explicit.body.data.comparison.previous).toBeNull();

    const onlyLive = await superAdmin.get(`/api/v1/reports/operator/${d}`);
    expect(onlyLive.status).toBe(200);
    expect(onlyLive.body.data).toMatchObject({
      cycle: { id: CYCLE.live },
      provisional: true,
      overall: { customer: { mean: null, n: 0 }, rank: null, rankOf: 0 },
      assessments: { total: 0, customer: 0, self: 0 },
      nationalTable: [],
      airportsTotal: 14,
    });
    expect(onlyLive.body.data.categories).toHaveLength(2);
  });

  it('picks the operator’s first survey type by default and 404s on one it did not run', async () => {
    const dflt = await superAdmin.get(`/api/v1/reports/operator/${a}?cycleId=${CYCLE.scored}`);
    expect(dflt.body.data.surveyType).toBe('DOMESTIC');
    const intl = await superAdmin.get(`/api/v1/reports/operator/${a}?cycleId=${CYCLE.scored}&surveyType=INTERNATIONAL`);
    expect(intl.body.data.overall.customer).toEqual({ mean: 3.95, n: 4 });
    const missing = await superAdmin.get(`/api/v1/reports/operator/${b}?cycleId=${CYCLE.scored}&surveyType=INTERNATIONAL`);
    expect(expectError(missing, 404, 'NOT_FOUND').message).toContain('INTERNATIONAL');
    expectError(await superAdmin.get(`/api/v1/reports/operator/${a}?cycleId=${CYCLE.draft}`), 404, 'NOT_FOUND');
    expectError(await superAdmin.get(`/api/v1/reports/operator/${a}?cycleId=nope`), 400, 'VALIDATION');
    expectError(await superAdmin.get(`/api/v1/reports/operator/${a}?surveyType=COASTAL`), 400, 'VALIDATION');
  });

  it('an ACO reads only its own operator: another one is 404, never 403', async () => {
    expectError(await adminA.get(`/api/v1/reports/operator/${b}?cycleId=${CYCLE.scored}`), 404, 'NOT_FOUND');
    expectError(await adminB.get(`/api/v1/reports/operator/${a}?cycleId=${CYCLE.scored}`), 404, 'NOT_FOUND');
    expectError(await adminB.get(`/api/v1/reports/operator/${a}/questions?cycleId=${CYCLE.scored}`), 404, 'NOT_FOUND');
    expectError(await superAdmin.get(`/api/v1/reports/operator/${idString(superAdmin.org._id)}`), 404, 'NOT_FOUND');
    expectError(await superAdmin.get('/api/v1/reports/operator/0123456789abcdef01234567'), 404, 'NOT_FOUND');
  });
});

describe('GET /reports/operator/:acoId/questions', () => {
  it('lists active questions in survey order with figures, NA and comment counts', async () => {
    const res = await adminA.get(`/api/v1/reports/operator/${a}/questions?cycleId=${CYCLE.scored}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ cycle: { id: CYCLE.scored }, surveyType: 'DOMESTIC', provisional: false, operator: { code: 'RPT-A' } });
    const questions = res.body.data.questions as Record<string, unknown>[];
    expect(questions.map((q) => q['code'])).toEqual(['ACFI.INFRA.CAPACITY', 'ACFI.INFRA.COLD', 'ACFI.INFRA.AMENITIES', 'ACFI.SEC.SCREENING']);
    expect(questions[0]).toEqual({
      id: 'S1-Q1',
      code: 'ACFI.INFRA.CAPACITY',
      text: 'Storage capacity',
      category: { code: 'INFRA', name: 'Infrastructure and facilities' },
      subcategory: { code: 'INFRA.STORAGE', name: 'Storage' },
      customer: { mean: 4.5, n: 8, naCount: 1 },
      self: { mean: null },
      previous: 4.2,
      delta: 0.3,
      comments: 1,
    });
    expect(questions[1]).toMatchObject({ comments: 1, subcategory: { code: 'INFRA.STORAGE' } });
    expect(questions[2]).toMatchObject({ subcategory: null, comments: 0 });
    expect(questions[3]).toEqual({
      id: 'S1-Q4',
      code: 'ACFI.SEC.SCREENING',
      text: 'Screening of cargo',
      category: { code: 'SEC', name: 'Security and safety' },
      subcategory: null,
      customer: { mean: null, n: 2, naCount: 0 },
      self: { mean: null },
      previous: null,
      delta: null,
      suppressed: 'INSUFFICIENT_RESPONSES',
      comments: 0,
    });
  });
});

describe('GET /reports/airport/:airportId', () => {
  it('returns the weighted score, the operators table and the categories for a platform caller', async () => {
    const res = await superAdmin.get(`/api/v1/reports/airport/${del}?cycleId=${CYCLE.scored}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      cycle: { id: CYCLE.scored },
      surveyType: 'DOMESTIC',
      provisional: false,
      airport: { id: del, iata: 'DEL' },
      overall: { mean: 4.11, coveredSharePct: 100, marketShareApplied: true, rank: 1, rankOf: 1 },
    });
    expect(res.body.data.operators).toEqual([
      { acoId: a, code: 'RPT-A', name: 'Alpha Cargo', mean: 4.25, sharePct: 60, suppressed: false },
      { acoId: b, code: 'RPT-B', name: 'Bravo Cargo', mean: 3.9, sharePct: 40, suppressed: false },
    ]);
    expect(res.body.data.categories).toEqual([
      { id: 'S1-INFRA', code: 'INFRA', name: 'Infrastructure and facilities', mean: 4.16, coveredSharePct: 100, marketShareApplied: true },
      { id: 'S1-SEC', code: 'SEC', name: 'Security and safety', mean: null, coveredSharePct: 0, marketShareApplied: false },
    ]);
    const intl = await superAdmin.get(`/api/v1/reports/airport/${del}?cycleId=${CYCLE.scored}&surveyType=INTERNATIONAL`);
    expect(intl.body.data.overall).toMatchObject({ mean: 3.95, marketShareApplied: false });
  });

  it('an airport sees its own airport with operators; another airport is 404; an ACO sees no operators table', async () => {
    const own = await airportDel.get(`/api/v1/reports/airport/${del}?cycleId=${CYCLE.scored}`);
    expect(own.status).toBe(200);
    expect(own.body.data.operators).toHaveLength(2);
    expectError(await airportBom.get(`/api/v1/reports/airport/${del}?cycleId=${CYCLE.scored}`), 404, 'NOT_FOUND');
    const suppressed = await airportBom.get(`/api/v1/reports/airport/${bom}?cycleId=${CYCLE.scored}`);
    expect(suppressed.body.data.overall).toMatchObject({ mean: null, coveredSharePct: 0, rank: null });
    expect(suppressed.body.data.operators).toEqual([{ acoId: c, code: 'RPT-C', name: 'Charlie Cargo', mean: null, sharePct: 100, suppressed: true }]);

    await grantTasks('ACO_ADMIN', ['reports.airport']);
    const aco = await adminA.get(`/api/v1/reports/airport/${del}?cycleId=${CYCLE.scored}`);
    expect(aco.status).toBe(200);
    expect(aco.body.data.overall.mean).toBe(4.11);
    expect(aco.body.data).not.toHaveProperty('operators');
    expectError(await adminA.get(`/api/v1/reports/airport/${bom}?cycleId=${CYCLE.scored}`), 404, 'NOT_FOUND');
    expectError(await adminA.get(`/api/v1/reports/airport/${hyd}?cycleId=${CYCLE.scored}`), 404, 'NOT_FOUND');
  });

  it('defaults to the latest scored cycle with a participant at the airport, listing participants before scoring', async () => {
    const dflt = await airportDel.get(`/api/v1/reports/airport/${del}`);
    expect(dflt.body.data).toMatchObject({ cycle: { id: CYCLE.scored }, provisional: false });
    const live = await superAdmin.get(`/api/v1/reports/airport/${hyd}`);
    expect(live.body.data).toMatchObject({ cycle: { id: CYCLE.live }, provisional: true, overall: { mean: null, rankOf: 0 } });
    expect(live.body.data.operators).toEqual([{ acoId: d, code: 'RPT-D', name: 'Delta Cargo', mean: null, sharePct: null, suppressed: true }]);
    expectError(await superAdmin.get(`/api/v1/reports/airport/${await airportIdByIata('MAA')}`), 404, 'NOT_FOUND');
  });
});

describe('GET /reports/national', () => {
  it('ranks airports and operators, averages categories and counts the participation funnel', async () => {
    const res = await superAdmin.get(`/api/v1/reports/national?cycleId=${CYCLE.scored}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ cycle: { id: CYCLE.scored }, surveyType: 'DOMESTIC', provisional: false });
    expect(res.body.data.airports).toEqual([
      { id: del, iata: 'DEL', name: DEL_NAME, rating: 4.11, rank: 1, rankOf: 1, coveredSharePct: 100, marketShareApplied: true },
      { id: bom, iata: 'BOM', name: BOM_NAME, rating: null, rank: null, rankOf: 1, coveredSharePct: 0, marketShareApplied: true },
    ]);
    expect(res.body.data.operators).toEqual([
      { acoId: a, code: 'RPT-A', name: 'Alpha Cargo', airport: { id: del, iata: 'DEL', name: DEL_NAME }, rating: 4.25, n: 8, rank: 1, rankOf: 2 },
      { acoId: b, code: 'RPT-B', name: 'Bravo Cargo', airport: { id: del, iata: 'DEL', name: DEL_NAME }, rating: 3.9, n: 10, rank: 2, rankOf: 2 },
      { acoId: c, code: 'RPT-C', name: 'Charlie Cargo', airport: { id: bom, iata: 'BOM', name: BOM_NAME }, rating: null, n: 1, rank: null, rankOf: 2, suppressed: 'INSUFFICIENT_RESPONSES' },
    ]);
    expect(res.body.data.categories).toEqual([
      { id: 'S1-INFRA', code: 'INFRA', name: 'Infrastructure and facilities', mean: 4.1, n: 2 },
      { id: 'S1-SEC', code: 'SEC', name: 'Security and safety', mean: 4.05, n: 2 },
    ]);
    expect(res.body.data.participation).toEqual({ airports: 2, operators: 3, sampleLocked: 2, invited: 35, started: 23, completed: 19, pending: 16, completionRate: 54.29 });
  });

  it('defaults to the newest scored cycle; lists unscored airports from the participants; requires the reports.national task', async () => {
    const dflt = await superAdmin.get('/api/v1/reports/national');
    expect(dflt.body.data.cycle.id).toBe(CYCLE.scored);
    const live = await superAdmin.get(`/api/v1/reports/national?cycleId=${CYCLE.live}`);
    expect(live.body.data).toMatchObject({ provisional: true, participation: { operators: 2, invited: 30, completionRate: 6.67 } });
    expect((live.body.data.airports as { iata: string; rating: number | null; rank: number | null }[]).map((row) => [row.iata, row.rating, row.rank])).toEqual([
      ['DEL', null, null],
      ['HYD', null, null],
    ]);
    expectError(await adminA.get('/api/v1/reports/national'), 403, 'FORBIDDEN');
    expectError(await airportDel.get('/api/v1/reports/national'), 403, 'FORBIDDEN');
  });
});

describe('GET /reports/comparison', () => {
  it('puts the operator side by side across cycles, matching survey nodes by code across versions', async () => {
    const res = await adminA.get(`/api/v1/reports/comparison?acoId=${a}&cycleIds=${CYCLE.prev},${CYCLE.scored}`);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.operator.code).toBe('RPT-A');
    expect(data.surveyType).toBe('DOMESTIC');
    expect((data.cycles as { id: string; provisional: boolean }[]).map((c) => [c.id, c.provisional])).toEqual([[CYCLE.prev, false], [CYCLE.scored, false]]);
    expect(data.overall).toEqual([
      { cycleId: CYCLE.prev, customer: { mean: 4, n: 6 }, self: { mean: 4.2 }, rank: 2, rankOf: 2 },
      { cycleId: CYCLE.scored, customer: { mean: 4.25, n: 8 }, self: { mean: 4.6 }, rank: 1, rankOf: 2 },
    ]);
    expect(data.categories).toEqual([
      { code: 'INFRA', name: 'Infrastructure and facilities', parentCode: null, values: [{ cycleId: CYCLE.prev, customer: { mean: 4.1, n: 6 }, self: { mean: null } }, { cycleId: CYCLE.scored, customer: { mean: 4.4, n: 8 }, self: { mean: 4.7 } }] },
      { code: 'SEC', name: 'Security and safety', parentCode: null, values: [{ cycleId: CYCLE.prev, customer: { mean: null, n: 2 }, self: { mean: null }, suppressed: 'INSUFFICIENT_RESPONSES' }, { cycleId: CYCLE.scored, customer: { mean: 4.1, n: 8 }, self: { mean: 4.5 } }] },
    ]);
    expect(data.subcategories).toEqual([{ code: 'INFRA.STORAGE', name: 'Storage', parentCode: 'INFRA', values: [{ cycleId: CYCLE.prev, customer: { mean: 4.3, n: 6 }, self: { mean: null } }, { cycleId: CYCLE.scored, customer: { mean: 4.3, n: 8 }, self: { mean: null } }] }]);
    const questions = data.questions as { code: string; parentCode: string; values: { customer: { mean: number | null } }[] }[];
    expect(questions.map((q) => [q.code, q.parentCode])).toEqual([['ACFI.INFRA.CAPACITY', 'INFRA.STORAGE'], ['ACFI.INFRA.COLD', 'INFRA.STORAGE'], ['ACFI.INFRA.AMENITIES', 'INFRA'], ['ACFI.SEC.SCREENING', 'SEC']]);
    expect(questions[0]!.values.map((v) => v.customer.mean)).toEqual([4.2, 4.5]);
  });

  it('shows a cycle the operator ran without this survey type as empty; unknown or foreign cycles are 404', async () => {
    const intl = await superAdmin.get(`/api/v1/reports/comparison?acoId=${a}&cycleIds=${CYCLE.scored},${CYCLE.prev}&surveyType=INTERNATIONAL`);
    expect(intl.status).toBe(200);
    expect(intl.body.data.overall).toEqual([
      { cycleId: CYCLE.scored, customer: { mean: 3.95, n: 4 }, self: { mean: null }, rank: 1, rankOf: 1 },
      { cycleId: CYCLE.prev, customer: { mean: null, n: 0 }, self: { mean: null }, rank: null, rankOf: 0 },
    ]);
    expectError(await superAdmin.get(`/api/v1/reports/comparison?acoId=${a}&cycleIds=${CYCLE.scored},${hex(99)}`), 404, 'NOT_FOUND');
    expectError(await adminB.get(`/api/v1/reports/comparison?acoId=${a}&cycleIds=${CYCLE.scored}`), 404, 'NOT_FOUND');
    expectError(await superAdmin.get(`/api/v1/reports/comparison?acoId=${a}&cycleIds=`), 400, 'VALIDATION');
    expectError(await superAdmin.get(`/api/v1/reports/comparison?acoId=${a}&cycleIds=${CYCLE.scored},x`), 400, 'VALIDATION');
    expectError(await superAdmin.get(`/api/v1/reports/comparison?cycleIds=${CYCLE.scored}`), 400, 'VALIDATION');
  });
});

describe('GET /reports/export', () => {
  function lines(res: { text: string }): string[][] {
    return res.text.trim().split('\r\n').map((line) => line.split(','));
  }

  it('exports the operator report as CSV with one row per level', async () => {
    const res = await adminA.get(`/api/v1/reports/export?scope=operator&acoId=${a}&cycleId=${CYCLE.scored}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe('attachment; filename="csq-operator-RPT-A-CSQ-2026-1-DOMESTIC.csv"');
    const rows = lines(res);
    expect(rows[0]).toEqual(['level', 'code', 'name', 'customer_mean', 'customer_n', 'self_mean', 'previous_mean', 'delta', 'suppressed', 'comments']);
    expect(rows[1]).toEqual(['OVERALL', 'OVERALL', 'Overall', '4.25', '8', '4.6', '4', '0.25', '', '']);
    expect(rows.map((row) => row[0])).toEqual(['level', 'OVERALL', 'CATEGORY', 'SUBCATEGORY', 'CATEGORY', 'QUESTION', 'QUESTION', 'QUESTION', 'QUESTION']);
    expect(rows[5]).toEqual(['QUESTION', 'ACFI.INFRA.CAPACITY', 'Storage capacity', '4.5', '8', '', '4.2', '0.3', '', '1']);
    expect(rows[8]).toEqual(['QUESTION', 'ACFI.SEC.SCREENING', 'Screening of cargo', '', '2', '', '', '', 'INSUFFICIENT_RESPONSES', '0']);
  });

  it('exports the airport report (operators for platform / airport only) and the national report', async () => {
    const airport = await airportDel.get(`/api/v1/reports/export?scope=airport&airportId=${del}&cycleId=${CYCLE.scored}`);
    expect(airport.status).toBe(200);
    expect(airport.headers['content-disposition']).toContain('csq-airport-DEL-CSQ-2026-1-DOMESTIC.csv');
    const rows = lines(airport);
    expect(rows[0]).toEqual(['level', 'code', 'name', 'mean', 'share_pct', 'covered_share_pct', 'market_share_applied', 'suppressed']);
    expect(rows[1]).toEqual(['OVERALL', 'OVERALL', 'Overall', '4.11', '', '100', 'true', '']);
    expect(rows.filter((row) => row[0] === 'OPERATOR')).toEqual([
      ['OPERATOR', 'RPT-A', 'Alpha Cargo', '4.25', '60', '', '', 'false'],
      ['OPERATOR', 'RPT-B', 'Bravo Cargo', '3.9', '40', '', '', 'false'],
    ]);
    const aco = await adminA.get(`/api/v1/reports/export?scope=airport&airportId=${del}&cycleId=${CYCLE.scored}`);
    expect(aco.status).toBe(200);
    expect(lines(aco).some((row) => row[0] === 'OPERATOR')).toBe(false);

    const national = await superAdmin.get(`/api/v1/reports/export?scope=national&cycleId=${CYCLE.scored}`);
    expect(national.status).toBe(200);
    expect(national.headers['content-disposition']).toContain('csq-national-CSQ-2026-1-DOMESTIC.csv');
    const sections = lines(national);
    expect(sections[0]).toEqual(['section', 'code', 'name', 'airport', 'rating', 'n', 'rank', 'rank_of', 'suppressed']);
    expect(sections.map((row) => row[0])).toEqual(['section', 'AIRPORT', 'AIRPORT', 'OPERATOR', 'OPERATOR', 'OPERATOR', 'CATEGORY', 'CATEGORY']);
    expect(sections[3]).toEqual(['OPERATOR', 'RPT-A', 'Alpha Cargo', 'DEL', '4.25', '8', '1', '2', '']);
  });

  it('requires the task of the chosen scope and the id the scope needs', async () => {
    expectError(await adminA.get(`/api/v1/reports/export?scope=national&cycleId=${CYCLE.scored}`), 403, 'FORBIDDEN');
    expectError(await airportDel.get(`/api/v1/reports/export?scope=operator&acoId=${a}&cycleId=${CYCLE.scored}`), 403, 'FORBIDDEN');
    expectError(await adminA.get(`/api/v1/reports/export?scope=operator&acoId=${b}&cycleId=${CYCLE.scored}`), 404, 'NOT_FOUND');
    expectError(await superAdmin.get(`/api/v1/reports/export?scope=operator&cycleId=${CYCLE.scored}`), 400, 'VALIDATION');
    expectError(await superAdmin.get(`/api/v1/reports/export?scope=airport&cycleId=${CYCLE.scored}`), 400, 'VALIDATION');
    expectError(await superAdmin.get('/api/v1/reports/export?scope=galaxy'), 400, 'VALIDATION');
    expectError(await superAdmin.get(`/api/v1/reports/export?scope=national&format=xlsx`), 400, 'VALIDATION');
    expectError(await t.anon.get(`/api/v1/reports/export?scope=national`), 401, 'UNAUTHENTICATED');
  });
});
