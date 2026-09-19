import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { RatingKey } from '@csq/contracts';
import { loadEnv } from '../src/config/env.js';
import { createDatabase, type Database } from '../src/db/connect.js';
import { runAsPrincipal, runSystem, type Principal } from '../src/kernel/requestContext.js';
import { newId } from '../src/kernel/ids.js';
import { checkModule, mountModules } from '../src/kernel/router.js';
import { INPUT_COLLECTIONS } from '../src/modules/scoring/scoring.inputs.js';
import { createMongoSources } from '../src/modules/scoring/scoring.sources.js';
import {
  CohortSnapshotModel,
  CycleRollupModel,
  ScoringRunModel,
} from '../src/modules/scoring/scoring.models.js';
import { dashboardModule, scoringModule } from '../src/modules/scoring/scoring.module.js';
import {
  readCohort,
  readDashboard,
  readPerceptionGap,
  readRollups,
  readTrend,
  runScoring,
} from '../src/modules/scoring/scoring.service.js';
import { closeDatabase, silentLog } from './mongo.js';

/**
 * The scoring module against a real MongoDB.
 *
 * The upstream collections are seeded with documents shaped exactly like the
 * ones the cycles, assessments, refdata and orgs modules store, because the
 * thing most worth proving is that a rollup written by a cross organisation run
 * is readable afterwards by exactly one tenant, and no in-memory substitute can
 * show that.
 *
 * The suite talks to its own database on the configured server rather than the
 * shared test database. Several modules are being built against one mongod at
 * once, and a suite that drops another suite's collections mid-run is a suite
 * that reports other people's bugs as its own.
 */

function scopedUri(): string {
  const uri = new URL(loadEnv().MONGO_URI);
  uri.pathname = `${uri.pathname.replace(/\/$/, '')}_scoring`;
  return uri.toString();
}

let database: Database | undefined;

const CATEGORIES = [
  { code: 'INFRASTRUCTURE_FACILITIES', name: 'Infrastructure / Facilities', count: 8 },
  { code: 'SECURITY_SAFETY', name: 'Security / Safety', count: 6 },
  { code: 'PROCESSES', name: 'Processes', count: 5 },
  { code: 'TRADE_FACILITATION', name: 'Trade Facilitation', count: 4 },
] as const;

const QUESTIONS = CATEGORIES.flatMap((category) =>
  Array.from({ length: category.count }, (_unused, index) => ({
    code: `ACFI.${category.code}.Q${index + 1}`,
    categoryCode: category.code,
    text: `Rate the terminal on ${category.name} parameter ${index + 1}`,
    answerType: 'RATING_5' as const,
    weightBp: 1000,
    scored: true,
    required: true,
    applicableDirections: ['EXPORT', 'IMPORT'],
    options: [],
    followUps: [],
  })),
);

const CATEGORY_WEIGHTS = {
  INFRASTRUCTURE_FACILITIES: 4000,
  SECURITY_SAFETY: 2000,
  PROCESSES: 2000,
  TRADE_FACILITATION: 2000,
};

const INSTRUMENT_ID = newId();
const PROFILE_ID = newId();
const CYCLE_OWNER_ORG = newId();
const PROGRAM_ID = newId();

type Rate = (categoryCode: string) => RatingKey;

const flat = (rating: RatingKey): Rate => () => rating;
const excellentInfrastructure: Rate = (code) =>
  code === 'INFRASTRUCTURE_FACILITIES' ? 'EXCELLENT' : 'VERY_GOOD';

interface SeedTerminal {
  orgId: string;
  airportId: string;
  iata: string;
  city: string;
  fullName: string;
  terminalName: string;
  customers: number;
  rate: Rate;
  self?: Rate;
}

function boundary(at: Date): { wall: string; tz: string; utc: Date } {
  return { wall: at.toISOString().slice(0, 19), tz: 'Asia/Kolkata', utc: at };
}

function answersFor(rate: Rate, at: Date): unknown[] {
  return QUESTIONS.map((question) => ({
    questionCode: question.code,
    ratings: ['EXPORT', 'IMPORT'].map((direction) => ({
      direction,
      rating: rate(question.categoryCode),
      options: [],
      followUps: [],
      updatedAt: at,
      updatedBy: 'assessor',
    })),
    comment: null,
    updatedAt: at,
  }));
}

async function insert(collection: string, docs: readonly unknown[]): Promise<void> {
  if (docs.length > 0) {
    await mongoose.connection.collection(collection).insertMany([...docs] as never[]);
  }
}

async function seedInstrument(): Promise<void> {
  await insert(INPUT_COLLECTIONS.instruments, [
    {
      _id: INSTRUMENT_ID,
      code: 'ACFI_CSQ',
      version: 2,
      formScope: 'INTERNATIONAL',
      sourceRef: null,
      publishedAt: new Date('2025-01-01T00:00:00.000Z'),
      questions: QUESTIONS,
    },
  ]);

  await insert(INPUT_COLLECTIONS.weightingProfiles, [
    {
      _id: PROFILE_ID,
      code: 'ACFI_CSQ',
      version: 3,
      title: 'ACFI CSQ phase 1',
      basis: 'CONFIGURED',
      state: 'PUBLISHED',
      snapshotId: 'a'.repeat(64),
      weights: {
        INTERNATIONAL: { categories: CATEGORY_WEIGHTS, questions: {} },
        DOMESTIC: { categories: {}, questions: {} },
      },
      notes: null,
      publishedAt: new Date('2025-01-01T00:00:00.000Z'),
    },
  ]);

  await insert(
    INPUT_COLLECTIONS.categories,
    CATEGORIES.map((category, index) => ({
      _id: newId(),
      code: category.code,
      name: category.name,
      description: null,
      displayOrder: index + 1,
      isActive: true,
    })),
  );
}

async function seedCycle(args: {
  cycleId: string;
  name: string;
  closesAt: Date;
  terminals: readonly SeedTerminal[];
}): Promise<void> {
  const opensAt = new Date(args.closesAt.getTime() - 30 * 24 * 3600 * 1000);

  await insert(INPUT_COLLECTIONS.cycles, [
    {
      _id: args.cycleId,
      orgId: CYCLE_OWNER_ORG,
      programId: PROGRAM_ID,
      code: args.name.replace(/\s+/g, '-'),
      codeKey: args.name.replace(/\s+/g, '-').toLowerCase(),
      name: args.name,
      state: 'ASSESSMENT_OPEN',
      formScope: 'INTERNATIONAL',
      minimumSamplingSize: 5,
      windows: {
        samplingOpens: boundary(new Date(opensAt.getTime() - 30 * 24 * 3600 * 1000)),
        samplingCloses: boundary(opensAt),
        assessmentOpens: boundary(opensAt),
        assessmentCloses: boundary(args.closesAt),
      },
      reminders: [],
      freezes: {},
      transitions: [],
    },
  ]);

  for (const terminal of args.terminals) {
    const airports = mongoose.connection.collection(INPUT_COLLECTIONS.airports);
    if ((await airports.countDocuments({ _id: terminal.airportId as never })) === 0) {
      await insert(INPUT_COLLECTIONS.airports, [
        {
          _id: terminal.airportId,
          iataCode: terminal.iata,
          icaoCode: null,
          name: terminal.fullName,
          city: terminal.city,
          country: 'IN',
          region: 'IN-MH',
          location: { type: 'Point', coordinates: [72.8, 19.0] },
          timezone: 'Asia/Kolkata',
          operatorRoster: [],
          isActive: true,
        },
      ]);
    }

    const organisations = mongoose.connection.collection(INPUT_COLLECTIONS.organisations);
    if ((await organisations.countDocuments({ _id: terminal.orgId as never })) === 0) {
      await insert(INPUT_COLLECTIONS.organisations, [
        {
          _id: terminal.orgId,
          type: 'ACO',
          state: 'APPROVED',
          legalName: `${terminal.terminalName} Private Limited`,
          legalNameLower: `${terminal.terminalName.toLowerCase()} private limited`,
          displayName: terminal.terminalName,
          code: terminal.terminalName.replace(/\s+/g, '_').toUpperCase(),
          airportId: terminal.airportId,
        },
      ]);
    }

    const participationId = newId();
    await insert(INPUT_COLLECTIONS.participations, [
      {
        _id: participationId,
        orgId: CYCLE_OWNER_ORG,
        cycleId: args.cycleId,
        acoOrgId: terminal.orgId,
        airportId: terminal.airportId,
        formScope: 'INTERNATIONAL',
        state: 'ACTIVE',
        sampling: { state: 'LOCKED', minimumSamplingSize: 5, lockedAt: opensAt, lockedCount: terminal.customers, eligibleCountAtLock: terminal.customers, shortfall: null },
        progress: { selfSubmittedAt: null, externalSubmittedAt: null, customerInvited: terminal.customers, customerSubmitted: terminal.customers },
        scoring: { state: 'NOT_SCORED', scoredAt: null, suppression: null },
        invitedAt: opensAt,
      },
    ]);

    const submittedAt = new Date(opensAt.getTime() + 24 * 3600 * 1000);
    const returns = Array.from({ length: terminal.customers }, () => ({
      assessorKind: 'CUSTOMER',
      rate: terminal.rate,
    }));
    if (terminal.self) returns.push({ assessorKind: 'SELF', rate: terminal.self });

    await insert(
      INPUT_COLLECTIONS.assessments,
      returns.map((entry) => ({
        _id: newId(),
        orgId: terminal.orgId,
        assignmentId: newId(),
        cycleId: args.cycleId,
        acoOrgId: terminal.orgId,
        participationId,
        assessorUserId: newId(),
        assessorKind: entry.assessorKind,
        formScope: 'INTERNATIONAL',
        instrumentId: INSTRUMENT_ID,
        state: 'SUBMITTED',
        answers: answersFor(entry.rate, submittedAt),
        revision: 4,
        startedAt: opensAt,
        lastSavedAt: submittedAt,
        submittedAt,
        openDraftKey: null,
        exclusiveSubmissionKey: entry.assessorKind === 'SELF' ? null : newId(),
        completeness: { applicableDirections: 46, answeredDirections: 46, percentBp: 10_000 },
      })),
    );
  }
}

const ORG_MUMBAI = newId();
const ORG_DELHI = newId();
const ORG_KOCHI = newId();
const ORG_OUTSIDER = newId();
const AIRPORT_BOM = newId();
const AIRPORT_DEL = newId();
const AIRPORT_COK = newId();

const MUMBAI: SeedTerminal = {
  orgId: ORG_MUMBAI,
  airportId: AIRPORT_BOM,
  iata: 'BOM',
  city: 'Mumbai',
  fullName: 'Chhatrapati Shivaji Maharaj International Airport',
  terminalName: 'Mumbai Cargo Terminal',
  customers: 6,
  rate: excellentInfrastructure,
  self: flat('EXCELLENT'),
};

const DELHI: SeedTerminal = {
  orgId: ORG_DELHI,
  airportId: AIRPORT_DEL,
  iata: 'DEL',
  city: 'Delhi',
  fullName: 'Indira Gandhi International Airport',
  terminalName: 'Delhi Cargo Terminal',
  customers: 5,
  rate: flat('VERY_GOOD'),
};

/** Three returns is below the publication minimum, on purpose. */
const KOCHI: SeedTerminal = {
  orgId: ORG_KOCHI,
  airportId: AIRPORT_COK,
  iata: 'COK',
  city: 'Kochi',
  fullName: 'Cochin International Airport',
  terminalName: 'Kochi Cargo Terminal',
  customers: 3,
  rate: flat('GOOD'),
};

function principal(userId: string, orgId: string): Principal {
  return {
    userId,
    subject: `sub-${userId}`,
    email: null,
    displayName: userId,
    memberships: [
      { orgId, roles: ['OPERATOR'], capabilities: ['scoring:read', 'dashboard:read'], active: true },
    ],
  };
}

function asOrg<T>(orgId: string, fn: () => T): T {
  return runAsPrincipal({ requestId: newId(), principal: principal('reader', orgId), orgId }, fn);
}

async function score(cycleId: string, mode: 'PROVISIONAL' | 'FINAL', now: Date) {
  return runSystem({ reason: `test scoring run for cycle ${cycleId}`, log: silentLog }, () =>
    runScoring({
      cycleId,
      mode,
      requestedByUserId: 'acfi-staff',
      requestedByOrgId: CYCLE_OWNER_ORG,
      reason: `test scoring run for cycle ${cycleId}`,
      sources: createMongoSources(),
      now,
    }),
  );
}

const PAST = new Date('2026-04-30T18:30:00.000Z');
const NOW = new Date('2026-05-02T09:00:00.000Z');
const STILL_OPEN = new Date(NOW.getTime() + 7 * 24 * 3600 * 1000);

describe('scoring module', () => {
  beforeAll(async () => {
    // another module's suite may already hold the shared connection
    await closeDatabase();
    database = createDatabase({ uri: scopedUri(), log: silentLog, maxPoolSize: 5, minPoolSize: 1 });
    await database.connect();
    await CycleRollupModel.syncIndexes();
    await CohortSnapshotModel.syncIndexes();
  });

  afterAll(async () => {
    await database?.disconnect();
    database = undefined;
  });

  beforeEach(async () => {
    for (const name of [
      ...Object.values(INPUT_COLLECTIONS),
      CycleRollupModel.collection.name,
      CohortSnapshotModel.collection.name,
      ScoringRunModel.collection.name,
    ]) {
      await mongoose.connection.collection(name).deleteMany({});
    }
    await seedInstrument();
  });

  it('refuses to read another module collection outside a recorded system scope', async () => {
    const sources = createMongoSources();
    await expect(asOrg(ORG_MUMBAI, () => sources.participations(newId()))).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('computes participation without computing a score while the window is open', async () => {
    const cycleId = newId();
    await seedCycle({ cycleId, name: 'FY 2026-27', closesAt: STILL_OPEN, terminals: [MUMBAI] });

    const run = await score(cycleId, 'PROVISIONAL', NOW);
    expect(run.frozen).toBe(false);
    expect(run.participationCount).toBe(1);

    const [rollup] = await asOrg(ORG_MUMBAI, () => readRollups({ limit: 20 }));
    expect(rollup?.overall.value).toBeNull();
    expect(rollup?.overall.suppression).toBe('NOT_YET_SCORED');
    // participation is what an operator needs during a window, and it is real
    expect(rollup?.counts).toEqual({ self: 1, customer: 6, external: 0, total: 7 });
    expect(rollup?.overall.scoreCoverageBp).toBe(10_000);
    expect(rollup?.rank).toBeNull();
    expect(rollup?.weightingProfile).toEqual({ profileId: PROFILE_ID, version: 3, basis: 'CONFIGURED' });
  });

  it('refuses to freeze a cycle whose assessment window is still open', async () => {
    const cycleId = newId();
    await seedCycle({ cycleId, name: 'FY 2026-27', closesAt: STILL_OPEN, terminals: [MUMBAI] });

    await expect(score(cycleId, 'FINAL', NOW)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('freezes a closed cycle, ranks the cohort and publishes the league table once', async () => {
    const cycleId = newId();
    await seedCycle({ cycleId, name: 'FY 2025-26', closesAt: PAST, terminals: [MUMBAI, DELHI, KOCHI] });

    const run = await score(cycleId, 'FINAL', NOW);
    expect(run.frozen).toBe(true);
    expect(run.publishedCount).toBe(2);
    expect(run.suppressedCount).toBe(1);

    const cohort = await asOrg(ORG_MUMBAI, () => readCohort(cycleId));
    expect(cohort.totalAirports).toBe(3);
    expect(cohort.rankedCount).toBe(2);
    expect(cohort.marketShareApplied).toBe(false);
    expect(cohort.statistics).toEqual({ count: 2, mean: 4.2, median: 4.2, p25: 4.1, p75: 4.3, min: 4, max: 4.4 });
    expect(cohort.rows.map((row) => [row.airportIata, row.rank, row.rating])).toEqual([
      ['BOM', 1, 4.4],
      ['DEL', 2, 4],
      ['COK', null, null],
    ]);

    await expect(score(cycleId, 'FINAL', NOW)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('serves the dashboard the page consumes, from the rollup and nothing else', async () => {
    const cycleId = newId();
    await seedCycle({ cycleId, name: 'FY 2025-26', closesAt: PAST, terminals: [MUMBAI, DELHI, KOCHI] });
    await score(cycleId, 'FINAL', NOW);

    const dashboard = await asOrg(ORG_MUMBAI, () => readDashboard({}));

    expect(dashboard.cycle).toEqual({ id: cycleId, label: 'FY 2025-26', state: 'SCORED' });
    expect(dashboard.terminal).toEqual({
      acoId: ORG_MUMBAI,
      terminalName: 'Mumbai Cargo Terminal',
      airportIata: 'BOM',
      airportName: 'Mumbai',
      airportFullName: 'Chhatrapati Shivaji Maharaj International Airport',
    });
    expect(dashboard.overall).toEqual({
      value: 4.4,
      suppression: 'NONE',
      rank: 1,
      rankOf: 3,
      assessmentCount: 7,
      selfCount: 1,
      customerCount: 6,
    });
    expect(dashboard.ratings.current).toEqual({ self: 5, customer: 4.4 });
    expect(dashboard.ratings.previous).toEqual({ self: null, customer: null });
    expect(dashboard.feedback.totalResponses).toBe(276);
    expect(dashboard.feedback.distribution.reduce((sum, row) => sum + row.percent, 0)).toBe(100);
    // the order is the one refdata publishes, not alphabetical
    expect(dashboard.categories.map((c) => [c.code, c.current, c.parameterCount])).toEqual([
      ['INFRASTRUCTURE_FACILITIES', 5, 8],
      ['SECURITY_SAFETY', 4, 6],
      ['PROCESSES', 4, 5],
      ['TRADE_FACILITATION', 4, 4],
    ]);
    expect(dashboard.rankings.rows.filter((row) => row.isSelf)).toHaveLength(1);
    expect(dashboard.rankings.footnote).toContain('Kochi');
  });

  it('tells a suppressed operator why, and leaves it out of the ranking', async () => {
    const cycleId = newId();
    await seedCycle({ cycleId, name: 'FY 2025-26', closesAt: PAST, terminals: [MUMBAI, DELHI, KOCHI] });
    await score(cycleId, 'FINAL', NOW);

    const dashboard = await asOrg(ORG_KOCHI, () => readDashboard({}));

    expect(dashboard.overall.value).toBeNull();
    expect(dashboard.overall.suppression).toBe('BELOW_MIN_RESPONSES');
    expect(dashboard.overall.rank).toBeNull();
    expect(dashboard.overall.customerCount).toBe(3);
    expect(dashboard.rankings.rows.some((row) => row.isSelf)).toBe(false);
    expect(dashboard.categories.every((category) => category.current === null)).toBe(true);
  });

  it('never shows one operator another operator rollup', async () => {
    const cycleId = newId();
    await seedCycle({ cycleId, name: 'FY 2025-26', closesAt: PAST, terminals: [MUMBAI, DELHI] });
    await score(cycleId, 'FINAL', NOW);

    const delhi = await asOrg(ORG_DELHI, () => readDashboard({}));
    expect(delhi.terminal.airportIata).toBe('DEL');
    expect(delhi.overall.value).toBe(4);

    const rollups = await asOrg(ORG_DELHI, () => readRollups({ limit: 20 }));
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.terminal.airportIata).toBe('DEL');

    // an organisation that took no part cannot read the table at all
    await expect(asOrg(ORG_OUTSIDER, () => readCohort(cycleId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(asOrg(ORG_OUTSIDER, () => readDashboard({}))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reports the gap between the operator own view and its customers', async () => {
    const cycleId = newId();
    await seedCycle({ cycleId, name: 'FY 2025-26', closesAt: PAST, terminals: [MUMBAI, DELHI] });
    await score(cycleId, 'FINAL', NOW);

    const gap = await asOrg(ORG_MUMBAI, () => readPerceptionGap({}));

    expect(gap.overall).toEqual({ self: 5, customer: 4.4, gap: 0.6 });
    expect(gap.categories.find((row) => row.categoryCode === 'TRADE_FACILITATION')).toEqual({
      categoryCode: 'TRADE_FACILITATION',
      label: 'Trade Facilitation',
      self: 5,
      customer: 4,
      gap: 1,
    });
  });

  it('carries a trend across cycles, with the previous cycle beside the current one', async () => {
    const firstCycle = newId();
    await seedCycle({
      cycleId: firstCycle,
      name: 'FY 2024-25',
      closesAt: new Date('2025-04-30T18:30:00.000Z'),
      terminals: [{ ...MUMBAI, rate: flat('GOOD'), self: flat('VERY_GOOD') }],
    });
    await score(firstCycle, 'FINAL', new Date('2025-05-02T09:00:00.000Z'));

    const secondCycle = newId();
    await seedCycle({
      cycleId: secondCycle,
      name: 'FY 2025-26',
      closesAt: PAST,
      terminals: [{ ...MUMBAI, rate: flat('VERY_GOOD'), self: flat('EXCELLENT') }],
    });
    await score(secondCycle, 'FINAL', NOW);

    const dashboard = await asOrg(ORG_MUMBAI, () => readDashboard({}));
    expect(dashboard.cycle.id).toBe(secondCycle);
    expect(dashboard.ratings.current).toEqual({ self: 5, customer: 4 });
    expect(dashboard.ratings.previous).toEqual({ self: 4, customer: 3 });
    // the all time figure is the mean of the cycles that published one
    expect(dashboard.ratings.overall).toEqual({ self: 4.5, customer: 3.5 });
    expect(dashboard.categories[0]?.delta).toBe(1);

    const trend = await asOrg(ORG_MUMBAI, () => readTrend({ limit: 12 }));
    expect(trend.points.map((point) => [point.cycleLabel, point.customer, point.self, point.gap])).toEqual([
      ['FY 2024-25', 3, 4, 1],
      ['FY 2025-26', 4, 5, 1],
    ]);
    expect(trend.points.every((point) => point.rank === 1)).toBe(true);
  });

  it('combines two terminals at one airport by published market share', async () => {
    const second = newId();
    const cycleId = newId();
    await seedCycle({
      cycleId,
      name: 'FY 2025-26',
      closesAt: PAST,
      terminals: [
        { ...MUMBAI, rate: flat('EXCELLENT'), self: undefined },
        {
          ...MUMBAI,
          orgId: second,
          terminalName: 'Sahar Cargo Terminal',
          customers: 5,
          rate: flat('GOOD'),
          self: undefined,
        },
      ],
    });

    await insert(INPUT_COLLECTIONS.marketShares, [
      {
        _id: newId(),
        airportId: AIRPORT_BOM,
        iataCode: 'BOM',
        derivation: 'DECLARED',
        operatorsAtAirport: 2,
        subscribedOperators: 2,
        lines: [
          { orgId: ORG_MUMBAI, operatorKey: 'bom-1', operatorName: 'Mumbai Cargo Terminal', shareBp: 9000 },
          { orgId: second, operatorKey: 'bom-2', operatorName: 'Sahar Cargo Terminal', shareBp: 1000 },
        ],
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        note: null,
        createdBy: null,
      },
    ]);

    await score(cycleId, 'FINAL', NOW);
    const cohort = await asOrg(ORG_MUMBAI, () => readCohort(cycleId));

    expect(cohort.totalAirports).toBe(1);
    expect(cohort.marketShareApplied).toBe(true);
    // 5 at 90 percent and 3 at 10 percent, not their unweighted mean of 4
    expect(cohort.rows[0]?.rating).toBe(4.8);
    expect(cohort.rows[0]?.terminalName).toBe('2 terminals');
  });

  it('replaces rollups on a rerun rather than accumulating them', async () => {
    const cycleId = newId();
    await seedCycle({ cycleId, name: 'FY 2026-27', closesAt: STILL_OPEN, terminals: [MUMBAI, DELHI] });

    await score(cycleId, 'PROVISIONAL', NOW);
    await score(cycleId, 'PROVISIONAL', new Date(NOW.getTime() + 3600 * 1000));

    const all = await runSystem({ reason: 'test counts every tenant rollup', log: silentLog }, () =>
      CycleRollupModel.countDocuments({ cycleId }).exec(),
    );
    expect(all).toBe(2);
    expect(await ScoringRunModel.countDocuments({ cycleId }).exec()).toBe(2);
  });

  it('passes the boot policy check and mounts', () => {
    expect(() => checkModule(scoringModule)).not.toThrow();
    expect(() => checkModule(dashboardModule)).not.toThrow();

    const router = mountModules([scoringModule, dashboardModule], {
      authenticate: (_req, _res, next) => next(),
      enterSelfScope: (_req, _res, next) => next(),
      enterOrgScope: (_req, _res, next) => next(),
      log: silentLog,
    });
    expect(router).toBeTypeOf('function');
  });
});
