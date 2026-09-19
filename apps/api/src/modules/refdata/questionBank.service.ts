import { z } from 'zod';
import { directionsFor, type Direction, type FormScope } from '@csq/contracts';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import {
  QuestionBankModel,
  QuestionBankVersionModel,
  SnapshotModel,
  type QuestionBankDoc,
  type QuestionBankVersionDoc,
} from './refdata.models.js';
import { hashContent, readVerifiedContent } from './refdata.hash.js';
import { resolveActiveCategories } from './categories.service.js';
import {
  BankQuestion,
  SnapshotContent,
  type QuestionBankInput,
} from './refdata.contracts.js';

/**
 * A question bank has versions; a published version has a snapshot. The
 * snapshot is the only thing an assessment ever reads, and it is content
 * addressed and append only, so the instrument a submitted assessment was
 * answered against cannot be edited afterwards. Editing the draft and
 * publishing again produces a different hash, which is a different document,
 * and the earlier one is still there to score the earlier submissions.
 */

const DUPLICATE_KEY = 11000;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY
  );
}

export interface BankView {
  code: string;
  title: string;
  description: string | null;
  sourceDocuments: string[];
  publishedVersion: number | null;
  publishedSnapshotId: string | null;
}

export interface BankVersionView {
  bankCode: string;
  version: number;
  state: QuestionBankVersionDoc['state'];
  questionCount: number;
  notes: string | null;
  snapshotId: string | null;
  publishedAt: string | null;
}

function toVersionView(doc: QuestionBankVersionDoc): BankVersionView {
  return {
    bankCode: doc.bankCode,
    version: doc.version,
    state: doc.state,
    questionCount: doc.questions.length,
    notes: doc.notes,
    snapshotId: doc.snapshotId,
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
  };
}

export async function listBanks(): Promise<BankView[]> {
  const banks = await QuestionBankModel.find({}).sort({ code: 1 }).lean().exec();
  const published = await QuestionBankVersionModel.find({ state: 'PUBLISHED' })
    .select('bankCode version snapshotId')
    .lean()
    .exec();

  const byBank = new Map(published.map((row) => [row.bankCode, row]));
  return banks.map((bank: QuestionBankDoc) => {
    const live = byBank.get(bank.code);
    return {
      code: bank.code,
      title: bank.title,
      description: bank.description,
      sourceDocuments: [...bank.sourceDocuments],
      publishedVersion: live?.version ?? null,
      publishedSnapshotId: live?.snapshotId ?? null,
    };
  });
}

export async function createBank(input: QuestionBankInput): Promise<BankView> {
  const existing = await QuestionBankModel.findOne({ code: input.code }).lean().exec();
  if (existing) throw conflict(`Question bank ${input.code} already exists`);

  await QuestionBankModel.create({ ...input });
  return {
    code: input.code,
    title: input.title,
    description: input.description,
    sourceDocuments: [...input.sourceDocuments],
    publishedVersion: null,
    publishedSnapshotId: null,
  };
}

async function requireBank(code: string): Promise<QuestionBankDoc> {
  const bank = await QuestionBankModel.findOne({ code }).lean().exec();
  if (!bank) throw notFound('No such question bank');
  return bank;
}

export async function listVersions(code: string): Promise<BankVersionView[]> {
  await requireBank(code);
  const rows = await QuestionBankVersionModel.find({ bankCode: code }).sort({ version: -1 }).lean().exec();
  return rows.map(toVersionView);
}

/**
 * A new draft always takes the next version number, and a bank may hold only
 * one draft at a time. Two open drafts means two people editing the instrument
 * with no way to say which one the next publish means.
 */
export async function createVersion(
  code: string,
  input: { questions: unknown[]; notes: string | null },
): Promise<BankVersionView> {
  await requireBank(code);

  const questions = parseQuestions(input.questions);

  const openDraft = await QuestionBankVersionModel.findOne({ bankCode: code, state: 'DRAFT' })
    .select('version')
    .lean()
    .exec();
  if (openDraft) {
    throw conflict(`Version ${openDraft.version} of ${code} is still a draft. Publish or retire it first.`);
  }

  const latest = await QuestionBankVersionModel.find({ bankCode: code })
    .sort({ version: -1 })
    .limit(1)
    .select('version')
    .lean()
    .exec();
  const version = (latest[0]?.version ?? 0) + 1;

  try {
    const created = await QuestionBankVersionModel.create({
      bankCode: code,
      version,
      state: 'DRAFT',
      questions,
      notes: input.notes,
    });
    return toVersionView(created.toObject());
  } catch (error) {
    if (isDuplicateKey(error)) throw conflict('Another version was created at the same moment. Try again.');
    throw error;
  }
}

/** Parses and cross-checks the instrument, reporting every problem at once. */
export function parseQuestions(raw: unknown): BankQuestion[] {
  const parsed = z.array(BankQuestion).min(1).safeParse(raw);
  if (!parsed.success) {
    throw fail(
      'VALIDATION_FAILED',
      'The instrument failed validation',
      parsed.error.issues.map((issue) => ({
        path: `questions.${issue.path.join('.')}`,
        message: issue.message,
      })),
    );
  }

  const problems: Array<{ path: string; message: string }> = [];
  const seen = new Map<string, number>();
  parsed.data.forEach((question, index) => {
    const first = seen.get(question.code);
    if (first !== undefined) {
      problems.push({ path: `questions.${index}.code`, message: `${question.code} also appears at ${first}` });
    } else {
      seen.set(question.code, index);
    }
    if (question.answerType !== 'RATING_5' && question.scored) {
      problems.push({
        path: `questions.${index}.scored`,
        message: 'only a RATING_5 question may be scored, because the scale is what carries the weight',
      });
    }
  });
  if (problems.length > 0) throw fail('VALIDATION_FAILED', 'The instrument is not consistent', problems);

  return parsed.data;
}

/** Assembles the exact value that gets hashed. Used by publish and by the seed. */
export function buildContent(
  bankCode: string,
  bankTitle: string,
  categories: ReadonlyArray<{ code: string; name: string; displayOrder: number }>,
  questions: readonly BankQuestion[],
): SnapshotContent {
  return SnapshotContent.parse({
    bankCode,
    bankTitle,
    categories: categories.map((category) => ({
      code: category.code,
      name: category.name,
      displayOrder: category.displayOrder,
    })),
    questions,
  });
}

export interface PublishOutcome extends BankVersionView {
  /** True when this exact instrument had already been published before. */
  reusedSnapshot: boolean;
}

export async function publishVersion(
  code: string,
  version: number,
  publishedBy: string | null,
): Promise<PublishOutcome> {
  const bank = await requireBank(code);
  const draft = await QuestionBankVersionModel.findOne({ bankCode: code, version }).lean().exec();
  if (!draft) throw notFound('No such question bank version');
  if (draft.state !== 'DRAFT') throw conflict(`Version ${version} is ${draft.state}, not a draft`);

  const questions = parseQuestions(draft.questions);
  const categories = await resolveActiveCategories(questions.map((question) => question.categoryCode));

  const content = buildContent(bank.code, bank.title, categories, questions);
  const snapshotId = hashContent(content);

  let reusedSnapshot = false;
  try {
    await SnapshotModel.create({ _id: snapshotId, bankCode: bank.code, firstVersion: version, content });
  } catch (error) {
    // the same instrument published twice is the same document, which is the
    // whole point of addressing it by its content
    if (!isDuplicateKey(error)) throw error;
    reusedSnapshot = true;
  }

  // retire first: the unique partial index allows one published version per
  // bank, so publishing before retiring would be refused by the database. If
  // the second step fails the bank is left with nothing published, which is
  // visible and fixable, rather than with the wrong thing published.
  await QuestionBankVersionModel.updateMany(
    { bankCode: code, state: 'PUBLISHED' },
    { $set: { state: 'RETIRED' } },
  ).exec();

  const published = await QuestionBankVersionModel.findOneAndUpdate(
    { bankCode: code, version, state: 'DRAFT' },
    { $set: { state: 'PUBLISHED', snapshotId, publishedAt: new Date(), publishedBy } },
    { new: true },
  )
    .lean()
    .exec();
  if (!published) throw conflict('The version changed while it was being published');

  return { ...toVersionView(published), reusedSnapshot };
}

export interface ScopedQuestion {
  code: string;
  categoryCode: string;
  text: string;
  /** Printed numbering on this form. Display only. */
  formRef: string;
  answerType: BankQuestion['answerType'];
  scored: boolean;
  options: BankQuestion['options'];
  helpText: string | null;
  /** Both directions of this form, so a client cannot guess the pair wrong. */
  directions: readonly Direction[];
}

export interface ScopedInstrument {
  snapshotId: string;
  bankCode: string;
  bankTitle: string;
  version: number;
  scope: FormScope;
  categories: SnapshotContent['categories'];
  questions: ScopedQuestion[];
}

export async function readSnapshot(
  snapshotId: string,
): Promise<{ id: string; firstVersion: number; content: SnapshotContent }> {
  const stored = await SnapshotModel.findOne({ _id: snapshotId }).lean().exec();
  if (!stored) throw notFound('No such question bank snapshot');
  return {
    id: stored._id,
    firstVersion: stored.firstVersion,
    content: readVerifiedContent(stored._id, stored.content),
  };
}

/**
 * The instrument as one form asks it. The scope decides which parameters appear
 * and which wording they carry: the same parameter is worded for EXIM on the
 * international sheet and for inbound and outbound on the domestic one, and it
 * is one question with two wordings rather than two questions, so analytics can
 * compare them.
 */
export function projectForScope(
  snapshotId: string,
  version: number,
  content: SnapshotContent,
  scope: FormScope,
): ScopedInstrument {
  const directions = directionsFor(scope);
  const questions: ScopedQuestion[] = [];

  for (const question of content.questions) {
    if (!question.scopes.includes(scope)) continue;
    const formRef = question.formRef[scope];
    if (formRef === undefined) {
      throw fail('INTERNAL', `${question.code} has no printed reference for the ${scope} form`);
    }
    questions.push({
      code: question.code,
      categoryCode: question.categoryCode,
      text: question.textByScope[scope] ?? question.text,
      formRef,
      answerType: question.answerType,
      scored: question.scored,
      options: question.options.map((option) => ({ ...option })),
      helpText: question.helpText,
      directions,
    });
  }

  const used = new Set(questions.map((question) => question.categoryCode));
  return {
    snapshotId,
    bankCode: content.bankCode,
    bankTitle: content.bankTitle,
    version,
    scope,
    categories: content.categories.filter((category) => used.has(category.code)),
    questions,
  };
}

export async function readPublishedInstrument(code: string, scope: FormScope): Promise<ScopedInstrument> {
  const live = await QuestionBankVersionModel.findOne({ bankCode: code, state: 'PUBLISHED' })
    .select('snapshotId version')
    .lean()
    .exec();
  if (!live || !live.snapshotId) {
    throw fail('QUESTION_BANK_NOT_PUBLISHED', `${code} has no published version`);
  }
  const snapshot = await readSnapshot(live.snapshotId);
  return projectForScope(snapshot.id, live.version, snapshot.content, scope);
}
