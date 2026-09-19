import { loadEnv } from '../../../config/env.js';
import { createDatabase } from '../../../db/connect.js';
import { createLogger, type Logger } from '../../../kernel/logger.js';
import { runSystem } from '../../../kernel/requestContext.js';
import { canonicalise } from '../refdata.hash.js';
import {
  QuestionBankModel,
  QuestionBankVersionModel,
  WeightingProfileModel,
} from '../refdata.models.js';
import { bulkUpsertAirports } from '../airports.service.js';
import { createCategory, listCategories, patchCategory, resolveActiveCategories } from '../categories.service.js';
import {
  buildContent,
  createBank,
  createVersion,
  parseQuestions,
  publishVersion,
  readPublishedInstrument,
} from '../questionBank.service.js';
import { createProfile, publishProfile, putWeights } from '../weighting.service.js';
import { hashContent } from '../refdata.hash.js';
import { AIRPORT_DATASET, loadAirports, loadCategories, loadQuestionBank, loadWeightingProfile } from './load.js';

/**
 * Loads the real reference data: the OurAirports extract, the four ACFI heads,
 * the instrument transcribed from the two published survey forms, and the
 * weighting profile derived from it.
 *
 * It writes through the ordinary service functions rather than straight to the
 * collections, so the seed is held to the same validation an administrator's
 * upload is, and it is safe to run twice: airports are keyed by IATA code, and
 * the instrument is content addressed, so a second run that changes nothing
 * writes nothing.
 *
 * Operator rosters and market shares are deliberately NOT seeded. Who operates
 * at an airport and how the traffic divides between them is a commercial fact
 * ACFI records, not something a public dataset knows, and inventing a roster
 * would put a fabricated competitor into the national roll-up.
 */

export interface SeedReport {
  categories: { created: number; updated: number };
  airports: { rows: number; created: number; updated: number; rejected: number };
  questionBank: { bankCode: string; version: number; snapshotId: string; changed: boolean };
  weightingProfile: { code: string; version: number; profileId: string; changed: boolean };
  instrument: { international: number; domestic: number; perHeadDomestic: Record<string, number> };
}

async function seedCategories(log: Logger): Promise<SeedReport['categories']> {
  const wanted = loadCategories();
  const existing = new Map((await listCategories(true)).map((category) => [category.code, category]));

  let created = 0;
  let updated = 0;
  for (const category of wanted) {
    const current = existing.get(category.code);
    if (!current) {
      await createCategory(category);
      created += 1;
      continue;
    }
    const changes: Record<string, unknown> = {};
    if (current.name !== category.name) changes['name'] = category.name;
    if (current.description !== category.description) changes['description'] = category.description;
    if (current.displayOrder !== category.displayOrder) changes['displayOrder'] = category.displayOrder;
    if (current.isActive !== category.isActive) changes['isActive'] = category.isActive;
    if (Object.keys(changes).length > 0) {
      await patchCategory(category.code, changes);
      updated += 1;
    }
  }
  log.info({ created, updated, total: wanted.length }, 'categories seeded');
  return { created, updated };
}

async function seedAirports(log: Logger): Promise<SeedReport['airports']> {
  const { rows, rejected } = loadAirports();
  for (const row of rejected) log.warn({ ident: row.ident, reason: row.reason }, 'airport row refused');

  const outcome = await bulkUpsertAirports(rows, { dryRun: false, source: { dataset: AIRPORT_DATASET } });
  log.info({ ...outcome, rejected: rejected.length }, 'airports seeded');
  return { rows: outcome.rows, created: outcome.created, updated: outcome.updated, rejected: rejected.length };
}

async function seedQuestionBank(log: Logger): Promise<SeedReport['questionBank']> {
  const file = loadQuestionBank();
  const questions = parseQuestions(file.questions);

  const existingBank = await QuestionBankModel.findOne({ code: file.bank.code }).lean().exec();
  if (!existingBank) {
    await createBank({
      code: file.bank.code,
      title: file.bank.title,
      description: file.bank.description,
      sourceDocuments: file.bank.sourceDocuments,
    });
  }

  const categories = await resolveActiveCategories(questions.map((question) => question.categoryCode));
  const wantedId = hashContent(buildContent(file.bank.code, file.bank.title, categories, questions));

  const live = await QuestionBankVersionModel.findOne({ bankCode: file.bank.code, state: 'PUBLISHED' })
    .select('version snapshotId')
    .lean()
    .exec();
  if (live && live.snapshotId === wantedId) {
    log.info({ bankCode: file.bank.code, version: live.version, snapshotId: wantedId }, 'question bank already current');
    return { bankCode: file.bank.code, version: live.version, snapshotId: wantedId, changed: false };
  }

  const openDraft = await QuestionBankVersionModel.findOne({ bankCode: file.bank.code, state: 'DRAFT' })
    .select('version')
    .lean()
    .exec();
  if (openDraft) {
    // someone is mid-edit. Publishing over it would freeze a half finished
    // instrument under their version number
    throw new Error(
      `${file.bank.code} has an open draft at version ${openDraft.version}. Publish or retire it before seeding.`,
    );
  }

  const draft = await createVersion(file.bank.code, { questions, notes: file.notes });
  const published = await publishVersion(file.bank.code, draft.version, null);
  if (published.snapshotId !== wantedId) {
    throw new Error('The published snapshot does not match the instrument that was loaded');
  }
  log.info({ bankCode: file.bank.code, version: published.version, snapshotId: wantedId }, 'question bank published');
  return { bankCode: file.bank.code, version: published.version, snapshotId: wantedId, changed: true };
}

async function seedWeightingProfile(log: Logger, snapshotId: string): Promise<SeedReport['weightingProfile']> {
  const file = loadWeightingProfile();

  const live = await WeightingProfileModel.findOne({ code: file.profile.code, state: 'PUBLISHED' }).lean().exec();
  if (live && live.snapshotId === snapshotId && canonicalise(live.weights) === canonicalise(file.weights)) {
    log.info({ code: file.profile.code, version: live.version }, 'weighting profile already current');
    return { code: file.profile.code, version: live.version, profileId: live._id, changed: false };
  }

  const draft = await createProfile({
    code: file.profile.code,
    title: file.profile.title,
    basis: file.profile.basis,
    snapshotId,
    notes: file.profile.notes,
  });
  await putWeights(draft.profileId, file.weights);
  const published = await publishProfile(draft.profileId, null);
  log.info({ code: published.code, version: published.version }, 'weighting profile published');
  return { code: published.code, version: published.version, profileId: published.profileId, changed: true };
}

/**
 * The shape the published ACFI forms actually have. It is asserted rather than
 * assumed, because a transcription that quietly loses a parameter produces a
 * perfectly valid instrument that scores the wrong thing.
 */
async function assertPhase1Shape(bankCode: string): Promise<SeedReport['instrument']> {
  const international = await readPublishedInstrument(bankCode, 'INTERNATIONAL');
  const domestic = await readPublishedInstrument(bankCode, 'DOMESTIC');

  const perHeadDomestic: Record<string, number> = {};
  for (const question of domestic.questions) {
    perHeadDomestic[question.categoryCode] = (perHeadDomestic[question.categoryCode] ?? 0) + 1;
  }

  const expected: Record<string, number> = { INFRA: 8, SEC: 6, PROC: 5, TRADE: 4 };
  const problems: string[] = [];
  if (domestic.questions.length !== 23) {
    problems.push(`the domestic form should ask 23 parameters, found ${domestic.questions.length}`);
  }
  if (international.questions.length !== 27) {
    problems.push(`the international form should ask 27 parameters, found ${international.questions.length}`);
  }
  for (const [head, count] of Object.entries(expected)) {
    const actual = perHeadDomestic[head] ?? 0;
    if (actual !== count) problems.push(`${head} should carry ${count} parameters on the domestic form, found ${actual}`);
  }
  if (problems.length > 0) {
    throw new Error(`The seeded instrument does not match the published forms:\n  ${problems.join('\n  ')}`);
  }

  return {
    international: international.questions.length,
    domestic: domestic.questions.length,
    perHeadDomestic,
  };
}

export async function seedReferenceData(log: Logger): Promise<SeedReport> {
  const categories = await seedCategories(log);
  const airports = await seedAirports(log);
  const questionBank = await seedQuestionBank(log);
  const weightingProfile = await seedWeightingProfile(log, questionBank.snapshotId);
  const instrument = await assertPhase1Shape(questionBank.bankCode);
  return { categories, airports, questionBank, weightingProfile, instrument };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL, env.NODE_ENV !== 'production');
  const db = createDatabase({ uri: env.MONGO_URI, log, maxPoolSize: 5, minPoolSize: 1 });

  await db.connect();
  try {
    const report = await runSystem(
      { reason: 'reference data seed: global collections have no organisation', log },
      () => seedReferenceData(log),
    );
    log.info({ report }, 'reference data seeded');
  } finally {
    await db.disconnect();
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      // stderr rather than the logger: a seed can fail while validating the
      // environment, which is before there is a logger to fail into
      console.error(error);
      process.exit(1);
    },
  );
}
