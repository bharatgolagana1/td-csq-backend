import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import mongoose from 'mongoose';
import {
  composite,
  rollupCategories,
  scoreQuestions,
  type SubmittedAssessment,
} from '@csq/core';
import { checkModule } from '../src/kernel/router.js';
import { newId } from '../src/kernel/ids.js';
import { runWithoutOrg, type Principal } from '../src/kernel/requestContext.js';
import { refdataModule, REFDATA_READ } from '../src/modules/refdata/refdata.module.js';
import {
  PLATFORM_READ,
  PLATFORM_WRITE,
  assertPlatformCapability,
  guardedCapabilityOf,
  platform,
} from '../src/modules/refdata/refdata.platform.js';
import {
  AirportModel,
  CategoryModel,
  MarketShareSnapshotModel,
  QuestionBankModel,
  QuestionBankVersionModel,
  REFDATA_MODELS,
  SnapshotModel,
  WeightingProfileModel,
} from '../src/modules/refdata/refdata.models.js';
import { canonicalise, hashContent, readVerifiedContent } from '../src/modules/refdata/refdata.hash.js';
import { AirportInput, SnapshotContent } from '../src/modules/refdata/refdata.contracts.js';
import {
  bulkUpsertAirports,
  getAirportForPlatform,
  listAirports,
  replaceOperatorRoster,
} from '../src/modules/refdata/airports.service.js';
import {
  readPublishedInstrument,
  readSnapshot,
} from '../src/modules/refdata/questionBank.service.js';
import {
  checkWeights,
  listPublishedProfiles,
  toCoreProfile,
  toQuestionSpecs,
} from '../src/modules/refdata/weighting.service.js';
import {
  currentMarketShare,
  deriveCase,
  marketShareHistory,
  recordMarketShare,
} from '../src/modules/refdata/marketShare.service.js';
import { seedReferenceData } from '../src/modules/refdata/seed/seed.js';
import { loadAirports, loadQuestionBank } from '../src/modules/refdata/seed/load.js';
import { parseCsv } from '../src/modules/refdata/seed/csv.js';
import { closeDatabase, openDatabase, silentLog } from './mongo.js';

const BANK_CODE = 'ACFI_CSQ';

function member(...capabilities: string[]): Principal {
  return {
    userId: newId(),
    subject: 'sub',
    email: null,
    displayName: 'tester',
    memberships: [{ orgId: newId(), roles: ['ADMIN'], capabilities, active: true }],
  };
}

function airportRow(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    iataCode: 'BOM',
    icaoCode: 'VABB',
    name: 'Chhatrapati Shivaji Maharaj International Airport',
    city: 'Mumbai',
    country: 'IN',
    region: 'IN-MH',
    latitude: 19.0886993408,
    longitude: 72.8678970337,
    timezone: 'Asia/Kolkata',
    ...overrides,
  };
}

function rows(...values: unknown[]) {
  return values.map((value) => AirportInput.parse(value));
}

async function clearAll(): Promise<void> {
  for (const model of REFDATA_MODELS) {
    await mongoose.connection.collection(model.collection.name).deleteMany({});
  }
}

describe('refdata module contract', () => {
  it('passes the kernel route policy check', () => {
    expect(() => checkModule(refdataModule)).not.toThrow();
  });

  it('guards every staff route in the handler, where it is actually enforceable', () => {
    const staffRoutes = refdataModule.routes.filter((route) => route.policy.tenancy !== 'ORG');
    expect(staffRoutes.length).toBeGreaterThan(0);

    for (const route of staffRoutes) {
      const where = `${route.method.toUpperCase()} ${route.path}`;
      expect(guardedCapabilityOf(route.handler), `${where} is not wrapped in platform()`).toBeDefined();
      // the kernel guard is deliberately not asked for a capability here; the
      // route has to say so in writing, and the wrapper has to do the work
      expect(route.policy.requiredCapability, where).toBeNull();
      expect(route.policy.openReason ?? '', where).toContain('asserted in the handler');
    }
  });

  it('never wraps a route that any organisation may read', () => {
    const orgRoutes = refdataModule.routes.filter((route) => route.policy.tenancy === 'ORG');
    for (const route of orgRoutes) {
      expect(guardedCapabilityOf(route.handler)).toBeUndefined();
    }
  });

  it('asks only for refdata:read on the routes any organisation may read', () => {
    const orgRoutes = refdataModule.routes.filter((route) => route.policy.tenancy === 'ORG');
    for (const route of orgRoutes) {
      expect(route.policy.requiredCapability).toBe(REFDATA_READ);
    }
    // market share is never one of them: it names a competitor's share
    expect(orgRoutes.some((route) => route.path.includes('market-share'))).toBe(false);
    expect(orgRoutes.some((route) => route.path.includes('operators'))).toBe(false);
  });

  it('refuses a caller that holds the capability nowhere', () => {
    expect(() => assertPlatformCapability(member(PLATFORM_WRITE), PLATFORM_WRITE)).not.toThrow();
    expect(() => assertPlatformCapability(member(REFDATA_READ), PLATFORM_WRITE)).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => assertPlatformCapability(member(PLATFORM_READ), PLATFORM_WRITE)).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('refuses before the handler runs, whoever the caller turns out to be', async () => {
    let reached = false;
    const guarded = platform(PLATFORM_WRITE, () => {
      reached = true;
      return null;
    });
    const request = {} as Request;

    await expect(
      runWithoutOrg({ requestId: newId(), principal: null }, () => guarded(request)),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    await expect(
      runWithoutOrg({ requestId: newId(), principal: member(REFDATA_READ) }, () => guarded(request)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(reached).toBe(false);

    await expect(
      runWithoutOrg({ requestId: newId(), principal: member(PLATFORM_WRITE) }, () => guarded(request)),
    ).resolves.toBeNull();
    expect(reached).toBe(true);
  });
});

describe('content addressing', () => {
  const content = SnapshotContent.parse({
    bankCode: 'ACFI_CSQ',
    bankTitle: 'ACFI Cargo Service Quality assessment',
    categories: [{ code: 'INFRA', name: 'Infrastructure and facilities', displayOrder: 10 }],
    questions: [
      {
        code: 'ACFI.INFRA.SCALE_CALIBRATION',
        categoryCode: 'INFRA',
        text: 'Periodically Calibrated Weighing Scales.',
        scopes: ['INTERNATIONAL', 'DOMESTIC'],
        answerType: 'RATING_5',
        scored: true,
        formRef: { INTERNATIONAL: '1.6', DOMESTIC: '1.6' },
      },
    ],
  });

  it('does not depend on key order', () => {
    const reordered = JSON.parse(
      JSON.stringify({ questions: content.questions, categories: content.categories, bankTitle: content.bankTitle, bankCode: content.bankCode }),
    ) as unknown;
    expect(hashContent(SnapshotContent.parse(reordered))).toBe(hashContent(content));
  });

  it('changes when a single word of the instrument changes', () => {
    const edited = SnapshotContent.parse({
      ...content,
      questions: [{ ...content.questions[0], text: 'Periodically calibrated weighing scales, checked.' }],
    });
    expect(hashContent(edited)).not.toBe(hashContent(content));
  });

  it('refuses content that no longer matches the identifier it is filed under', () => {
    const id = hashContent(content);
    expect(() => readVerifiedContent(id, content)).not.toThrow();
    expect(() =>
      readVerifiedContent(id, { ...content, bankTitle: 'Edited underneath a submitted assessment' }),
    ).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
  });

  it('treats an absent key and an undefined key as the same content', () => {
    expect(canonicalise({ a: 1, b: undefined })).toBe(canonicalise({ a: 1 }));
  });
});

describe('the vendored source data', () => {
  it('reads every Indian airport row without repairing any of them', () => {
    const { rows: loaded, rejected } = loadAirports();
    expect(rejected).toEqual([]);
    expect(loaded.length).toBeGreaterThanOrEqual(100);
    expect(loaded.every((row) => /^[A-Z]{3}$/.test(row.iataCode))).toBe(true);
    expect(loaded.every((row) => row.timezone === 'Asia/Kolkata')).toBe(true);
  });

  it('skips the provenance header but keeps every data row', () => {
    const parsed = parseCsv('# a comment\n"a","b"\n"1","2"\n');
    expect(parsed).toEqual([{ a: '1', b: '2' }]);
  });

  it('refuses a malformed row rather than guessing at it', () => {
    expect(() => parseCsv('"a","b"\n"1"\n')).toThrow(/expected 2 fields/);
    expect(() => parseCsv('"a"\n"unterminated\n')).toThrow(/unterminated/);
  });

  it('carries the 23 shared parameters plus the 4 the international form adds', () => {
    const { questions } = loadQuestionBank();
    const domestic = questions.filter((question) => question.scopes.includes('DOMESTIC'));
    const international = questions.filter((question) => question.scopes.includes('INTERNATIONAL'));

    expect(domestic).toHaveLength(23);
    expect(international).toHaveLength(27);

    const perHead = new Map<string, number>();
    for (const question of domestic) {
      perHead.set(question.categoryCode, (perHead.get(question.categoryCode) ?? 0) + 1);
    }
    expect(Object.fromEntries(perHead)).toEqual({ INFRA: 8, SEC: 6, PROC: 5, TRADE: 4 });
  });

  it('numbers the same parameter differently on the two printed forms', () => {
    const { questions } = loadQuestionBank();
    const grievance = questions.find((question) => question.code === 'ACFI.TRADE.GRIEVANCE_REDRESSAL');

    // the exact reason a code may not carry a section number
    expect(grievance?.formRef).toEqual({ INTERNATIONAL: '5.1', DOMESTIC: '4.1' });
    expect(questions.every((question) => !/\.\d/.test(question.code))).toBe(true);
  });
});

describe('refdata against MongoDB', () => {
  beforeAll(async () => {
    await openDatabase();
    for (const model of REFDATA_MODELS) await model.syncIndexes();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(async () => {
    await clearAll();
  });

  describe('airports', () => {
    it('refuses the whole upload when one row would have to be repaired', async () => {
      const good = AirportInput.parse(airportRow());
      const bad = AirportInput.safeParse(airportRow({ iataCode: 'bom' }));

      expect(bad.success).toBe(false);
      await bulkUpsertAirports([good], { dryRun: false });
      expect(await AirportModel.countDocuments({}).exec()).toBe(1);
    });

    it('names the row and the column when a code appears twice', async () => {
      await expect(
        bulkUpsertAirports(rows(airportRow(), airportRow({ icaoCode: 'VOBL' })), { dryRun: false }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [{ path: 'rows.1.iataCode', message: 'BOM also appears on row 0' }],
      });
      expect(await AirportModel.countDocuments({}).exec()).toBe(0);
    });

    it('refuses an ICAO code that already belongs to another airport', async () => {
      await bulkUpsertAirports(rows(airportRow()), { dryRun: false });

      await expect(
        bulkUpsertAirports(rows(airportRow({ iataCode: 'DEL', icaoCode: 'VABB' })), { dryRun: false }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [{ path: 'rows.0.icaoCode', message: 'VABB already belongs to BOM' }],
      });
    });

    it('writes nothing on a dry run', async () => {
      const outcome = await bulkUpsertAirports(rows(airportRow()), { dryRun: true });
      expect(outcome).toMatchObject({ rows: 1, created: 1, dryRun: true });
      expect(await AirportModel.countDocuments({}).exec()).toBe(0);
    });

    it('converges on a second upload instead of duplicating', async () => {
      await bulkUpsertAirports(rows(airportRow()), { dryRun: false });
      const second = await bulkUpsertAirports(rows(airportRow({ name: 'Mumbai' })), { dryRun: false });

      expect(second).toMatchObject({ created: 0, updated: 1 });
      expect(await AirportModel.countDocuments({}).exec()).toBe(1);
    });

    it('keeps the operator roster when the file is uploaded again', async () => {
      await bulkUpsertAirports(rows(airportRow()), { dryRun: false });
      const orgId = newId();
      await replaceOperatorRoster('BOM', [
        { operatorKey: 'AISATS', name: 'AISATS', orgId, subscribed: true },
      ]);

      await bulkUpsertAirports(rows(airportRow()), { dryRun: false });

      const after = await getAirportForPlatform('BOM');
      expect(after.operatorRoster).toHaveLength(1);
      expect(after.operatorRoster[0]?.orgId).toBe(orgId);
    });

    it('never shows the roster on the view an operator reads', async () => {
      await bulkUpsertAirports(rows(airportRow()), { dryRun: false });
      await replaceOperatorRoster('BOM', [
        { operatorKey: 'AISATS', name: 'AISATS', orgId: newId(), subscribed: true },
      ]);

      const page = await listAirports({ includeInactive: false, limit: 10 });
      const [visible] = page.items;
      expect(visible).toBeDefined();
      expect(page.hasMore).toBe(false);
      expect(visible).not.toHaveProperty('operatorRoster');
      expect(visible?.latitude).toBeCloseTo(19.0886993408, 6);
    });

    it('refuses one organisation appearing twice on one roster', async () => {
      await bulkUpsertAirports(rows(airportRow()), { dryRun: false });
      const orgId = newId();

      await expect(
        replaceOperatorRoster('BOM', [
          { operatorKey: 'AISATS', name: 'AISATS', orgId, subscribed: true },
          { operatorKey: 'CELEBI', name: 'Celebi', orgId, subscribed: true },
        ]),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('the seeded instrument', () => {
    beforeEach(async () => {
      await seedReferenceData(silentLog);
    });

    it('says so when a listing was cut short rather than looking complete', async () => {
      const page = await listAirports({ includeInactive: false, limit: 5 });
      expect(page.items).toHaveLength(5);
      expect(page.hasMore).toBe(true);
    });

    it('loads the real reference data and publishes it', async () => {
      expect(await AirportModel.countDocuments({}).exec()).toBeGreaterThanOrEqual(100);
      expect(await CategoryModel.countDocuments({}).exec()).toBe(4);
      expect(await QuestionBankModel.countDocuments({ code: BANK_CODE }).exec()).toBe(1);
      expect(await QuestionBankVersionModel.countDocuments({ state: 'PUBLISHED' }).exec()).toBe(1);
      expect(await WeightingProfileModel.countDocuments({ state: 'PUBLISHED' }).exec()).toBe(1);
    });

    it('writes nothing at all on a second run', async () => {
      const before = await SnapshotModel.countDocuments({}).exec();
      const report = await seedReferenceData(silentLog);

      expect(report.questionBank.changed).toBe(false);
      expect(report.weightingProfile.changed).toBe(false);
      expect(report.airports.created).toBe(0);
      expect(await SnapshotModel.countDocuments({}).exec()).toBe(before);
      expect(await QuestionBankVersionModel.countDocuments({}).exec()).toBe(1);
    });

    it('asks each form the parameters that form prints', async () => {
      const international = await readPublishedInstrument(BANK_CODE, 'INTERNATIONAL');
      const domestic = await readPublishedInstrument(BANK_CODE, 'DOMESTIC');

      expect(international.questions).toHaveLength(27);
      expect(domestic.questions).toHaveLength(23);
      expect(international.questions[0]?.directions).toEqual(['EXPORT', 'IMPORT']);
      expect(domestic.questions[0]?.directions).toEqual(['INBOUND', 'OUTBOUND']);
    });

    it('carries the wording each form actually prints', async () => {
      const international = await readPublishedInstrument(BANK_CODE, 'INTERNATIONAL');
      const domestic = await readPublishedInstrument(BANK_CODE, 'DOMESTIC');

      const intlSop = international.questions.find((q) => q.code === 'ACFI.PROC.SOP_DISPLAY');
      const domSop = domestic.questions.find((q) => q.code === 'ACFI.PROC.SOP_DISPLAY');

      expect(intlSop?.text).toContain('EXIM operations');
      expect(domSop?.text).toContain('inbound/outbound');
      expect(intlSop?.formRef).toBe('3.5');
      expect(domSop?.formRef).toBe('3.4');
    });

    it('will not let a published instrument be edited underneath an assessment', async () => {
      const [published] = await QuestionBankVersionModel.find({ state: 'PUBLISHED' }).lean().exec();
      const snapshotId = published?.snapshotId ?? '';
      expect(snapshotId).toMatch(/^[0-9a-f]{64}$/);

      await expect(
        SnapshotModel.updateOne({ _id: snapshotId }, { $set: { bankCode: 'OTHER' } }).exec(),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
      await expect(SnapshotModel.deleteOne({ _id: snapshotId }).exec()).rejects.toMatchObject({
        code: 'INTERNAL',
      });

      const snapshot = await readSnapshot(snapshotId);
      expect(snapshot.content.questions).toHaveLength(27);
    });

    it('weights the instrument so every head and every question adds up', async () => {
      const [profile] = await listPublishedProfiles();
      expect(profile).toBeDefined();
      const snapshot = await readSnapshot(profile?.snapshotId ?? '');

      expect(checkWeights(snapshot.content, profile?.weights)).toEqual([]);
      const weights = profile?.weights;
      expect(weights).toBeDefined();
      if (!weights) return;

      for (const scope of ['INTERNATIONAL', 'DOMESTIC'] as const) {
        const categoryTotal = Object.values(weights[scope].categories).reduce((a, b) => a + b, 0);
        expect(categoryTotal).toBe(10_000);
      }
    });

    it('reports every problem at once when the weights stop describing the instrument', async () => {
      const [profile] = await listPublishedProfiles();
      const snapshot = await readSnapshot(profile?.snapshotId ?? '');
      const weights = JSON.parse(JSON.stringify(profile?.weights)) as Record<
        string,
        { categories: Record<string, number>; questions: Record<string, number> }
      >;

      const scope = weights['INTERNATIONAL'];
      expect(scope).toBeDefined();
      if (!scope) return;
      delete scope.questions['ACFI.INFRA.SCALE_CALIBRATION'];
      scope.categories['INFRA'] = 3000;
      scope.questions['ACFI.MADE.UP'] = 100;

      const problems = checkWeights(snapshot.content, weights);
      const paths = problems.map((problem) => problem.path);
      expect(paths).toContain('INTERNATIONAL.questions.ACFI.INFRA.SCALE_CALIBRATION');
      expect(paths).toContain('INTERNATIONAL.categories');
      expect(problems.some((p) => p.message.includes('is not a scored question on this form'))).toBe(true);
    });

    it('feeds the pure scorer an instrument and its weights as one pair', async () => {
      const [profile] = await listPublishedProfiles();
      expect(profile).toBeDefined();
      if (!profile) return;

      const snapshot = await readSnapshot(profile.snapshotId);
      const specs = toQuestionSpecs(snapshot.content, profile, 'DOMESTIC');
      expect(specs.size).toBe(23);

      const assessment: SubmittedAssessment = {
        assessmentId: newId(),
        assessorKind: 'CUSTOMER',
        formScope: 'DOMESTIC',
        answers: [...specs.values()].map((spec) => ({
          questionCode: spec.code,
          ratings: [
            { direction: 'INBOUND', rating: 'VERY_GOOD' },
            { direction: 'OUTBOUND', rating: 'GOOD' },
          ],
        })),
      };

      const scored = scoreQuestions(assessment, specs);
      const categories = rollupCategories(scored, specs, 'DOMESTIC');
      const result = composite(categories, toCoreProfile(profile), 'DOMESTIC');

      expect(categories).toHaveLength(4);
      expect(result.value).toBeCloseTo(3.5, 6);
      expect(result.coverageBp).toBe(10_000);
    });
  });

  describe('market share', () => {
    const aisats = newId();
    const celebi = newId();

    beforeEach(async () => {
      await bulkUpsertAirports(rows(airportRow()), { dryRun: false });
    });

    it('reads the case off the roster rather than taking it from the caller', () => {
      expect(deriveCase(1, 1)).toBe('SOLE_OPERATOR');
      expect(deriveCase(3, 1)).toBe('SOLE_SUBSCRIBER');
      expect(deriveCase(3, 2)).toBe('DISTRIBUTED');
    });

    it('gives the only operator at an airport all of it, with no lines sent', async () => {
      await replaceOperatorRoster('BOM', [
        { operatorKey: 'AISATS', name: 'AISATS', orgId: aisats, subscribed: true },
      ]);

      const recorded = await recordMarketShare('BOM', { note: null }, null);
      expect(recorded.derivation).toBe('SOLE_OPERATOR');
      expect(recorded.lines).toEqual([
        { orgId: aisats, operatorKey: 'AISATS', operatorName: 'AISATS', shareBp: 10_000 },
      ]);
    });

    it('gives the only subscriber all of it even where others operate', async () => {
      await replaceOperatorRoster('BOM', [
        { operatorKey: 'AISATS', name: 'AISATS', orgId: aisats, subscribed: true },
        { operatorKey: 'CELEBI', name: 'Celebi', orgId: null, subscribed: false },
      ]);

      const recorded = await recordMarketShare('BOM', { note: null }, null);
      expect(recorded.derivation).toBe('SOLE_SUBSCRIBER');
      expect(recorded.operatorsAtAirport).toBe(2);
      expect(recorded.lines).toHaveLength(1);
    });

    it('requires stated shares once two operators subscribe, and requires them to total 10000', async () => {
      await replaceOperatorRoster('BOM', [
        { operatorKey: 'AISATS', name: 'AISATS', orgId: aisats, subscribed: true },
        { operatorKey: 'CELEBI', name: 'Celebi', orgId: celebi, subscribed: true },
      ]);

      await expect(recordMarketShare('BOM', { note: null }, null)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await expect(
        recordMarketShare(
          'BOM',
          { lines: [{ orgId: aisats, shareBp: 6000 }, { orgId: celebi, shareBp: 3999 }], note: null },
          null,
        ),
      ).rejects.toMatchObject({ code: 'WEIGHTS_DO_NOT_SUM' });

      const recorded = await recordMarketShare(
        'BOM',
        { lines: [{ orgId: aisats, shareBp: 6000 }, { orgId: celebi, shareBp: 4000 }], note: null },
        null,
      );
      expect(recorded.derivation).toBe('DISTRIBUTED');
      expect(recorded.lines.map((line) => line.shareBp)).toEqual([6000, 4000]);
    });

    it('refuses a share for an operator that does not subscribe here', async () => {
      await replaceOperatorRoster('BOM', [
        { operatorKey: 'AISATS', name: 'AISATS', orgId: aisats, subscribed: true },
        { operatorKey: 'CELEBI', name: 'Celebi', orgId: celebi, subscribed: true },
      ]);

      await expect(
        recordMarketShare(
          'BOM',
          { lines: [{ orgId: aisats, shareBp: 5000 }, { orgId: newId(), shareBp: 5000 }], note: null },
          null,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('supersedes rather than edits, and refuses a snapshot that would never be read', async () => {
      await replaceOperatorRoster('BOM', [
        { operatorKey: 'AISATS', name: 'AISATS', orgId: aisats, subscribed: true },
      ]);
      const first = await recordMarketShare('BOM', { note: 'initial' }, null);

      await expect(
        recordMarketShare('BOM', { effectiveFrom: first.effectiveFrom, note: 'same instant' }, null),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      const later = new Date(Date.parse(first.effectiveFrom) + 60_000);
      const second = await recordMarketShare(
        'BOM',
        { effectiveFrom: later.toISOString(), note: 'revised' },
        null,
      );

      // a future dated share is recorded but is not yet the one in force
      expect(await currentMarketShare('BOM')).toMatchObject({ snapshotId: first.snapshotId });
      expect(await currentMarketShare('BOM', later)).toMatchObject({ snapshotId: second.snapshotId });
      expect(await marketShareHistory('BOM', 10)).toHaveLength(2);
      await expect(
        MarketShareSnapshotModel.updateOne({ _id: first.snapshotId }, { $set: { note: 'edited' } }).exec(),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
    });

    it('will not apportion an airport whose roster nobody is on', async () => {
      await expect(recordMarketShare('BOM', { note: null }, null)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await expect(currentMarketShare('BOM')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
