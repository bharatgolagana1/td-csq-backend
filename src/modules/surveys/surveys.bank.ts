import { readFile } from 'node:fs/promises';

import yaml from 'js-yaml';
import { z } from 'zod';

import { AppError, zodIssues } from '../../core/errors.js';

import { SURVEY_TYPES, type SurveyType } from './surveys.model.js';
import { nodeCodeSchema } from './surveys.schemas.js';

/**
 * The vendored ACFI Phase 1 instrument: `data/heads.yaml` (the four heads)
 * and `data/acfi-csq-phase1.yaml` (27 parameters; `scopes` says which survey
 * type asks each one, `textByScope` overrides the wording per type). The
 * header comments of those files are the authority on their conventions.
 */
const HEADS_YAML = new URL('./data/heads.yaml', import.meta.url);
const BANK_YAML = new URL('./data/acfi-csq-phase1.yaml', import.meta.url);

const text = z.string().trim().min(1);

const headSchema = z.object({
  code: nodeCodeSchema,
  name: text.max(200),
  displayOrder: z.number().int().min(0),
  description: z.string().trim().default(''),
});

const bankQuestionSchema = z.object({
  code: nodeCodeSchema,
  categoryCode: nodeCodeSchema,
  scopes: z.array(z.enum(SURVEY_TYPES)).min(1),
  text: text.max(2000),
  textByScope: z.partialRecord(z.enum(SURVEY_TYPES), text.max(2000)).optional(),
  /** Either spelling becomes the question's `help`; neither is present in the Phase 1 transcription. */
  description: z.string().trim().optional(),
  help: z.string().trim().optional(),
});

const bankFileSchema = z.object({
  bank: z.object({ code: z.string(), title: z.string(), description: z.string().optional() }),
  questions: z.array(bankQuestionSchema).min(1),
});

export type BankHead = z.infer<typeof headSchema>;
export type BankQuestion = z.infer<typeof bankQuestionSchema>;

export interface SurveyBank {
  title: string;
  heads: BankHead[];
  questions: BankQuestion[];
}

function parseYaml<T>(schema: z.ZodType<T>, source: string, file: string): T {
  const result = schema.safeParse(yaml.load(source));
  if (!result.success) {
    throw new AppError('INTERNAL', `Vendored survey file ${file} is invalid`, { file, issues: zodIssues(result.error) });
  }
  return result.data;
}

function duplicates(codes: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const code of codes) {
    if (seen.has(code)) repeated.add(code);
    seen.add(code);
  }
  return [...repeated];
}

/** Reads and validates both files; every question must name a known head and codes must be unique. */
export async function loadSurveyBank(): Promise<SurveyBank> {
  const [headsSource, bankSource] = await Promise.all([readFile(HEADS_YAML, 'utf8'), readFile(BANK_YAML, 'utf8')]);
  const heads = parseYaml(z.array(headSchema).min(1), headsSource, 'heads.yaml');
  const bank = parseYaml(bankFileSchema, bankSource, 'acfi-csq-phase1.yaml');

  const problems: string[] = [];
  const headCodes = new Set(heads.map((head) => head.code));
  for (const code of duplicates(heads.map((head) => head.code))) problems.push(`head ${code} is listed twice`);
  for (const code of duplicates(bank.questions.map((question) => question.code))) problems.push(`question ${code} is listed twice`);
  for (const question of bank.questions) {
    if (!headCodes.has(question.categoryCode)) problems.push(`question ${question.code} names unknown head ${question.categoryCode}`);
  }
  if (problems.length > 0) throw new AppError('INTERNAL', 'Vendored survey bank is inconsistent', { problems });

  return { title: bank.bank.title, heads: [...heads].sort((a, b) => a.displayOrder - b.displayOrder), questions: bank.questions };
}

export interface BankQuestionForType {
  code: string;
  categoryCode: string;
  text: string;
  help: string | null;
}

/** The parameters one survey type asks, in file order, worded for that type. */
export function bankQuestionsFor(bank: SurveyBank, type: SurveyType): BankQuestionForType[] {
  return bank.questions
    .filter((question) => question.scopes.includes(type))
    .map((question) => ({
      code: question.code,
      categoryCode: question.categoryCode,
      text: question.textByScope?.[type] ?? question.text,
      help: question.description ?? question.help ?? null,
    }));
}
