/**
 * Builders for the scoring engine tests. Everything is plain data; no clock,
 * no database.
 */

import type {
  CustomerType,
  Rating,
  ScoreLevel,
  ScoreRow,
  ScoringSettings,
  SubmittedAssessment,
  SurveyCategory,
  SurveyQuestion,
  SurveyStructure,
  SurveySubcategory,
} from '../../../src/modules/scoring/engine/index.js';

export function question(id: string, overrides: Partial<SurveyQuestion> = {}): SurveyQuestion {
  return { id, code: id.toUpperCase(), text: `Question ${id}`, mandatory: true, active: true, ...overrides };
}

export function subcategory(
  id: string,
  questions: readonly SurveyQuestion[],
  overrides: Partial<SurveySubcategory> = {},
): SurveySubcategory {
  return { id, code: id.toUpperCase(), name: `Subcategory ${id}`, order: 0, questions, ...overrides };
}

export function category(
  id: string,
  parts: { subcategories?: readonly SurveySubcategory[]; questions?: readonly SurveyQuestion[] } = {},
  overrides: Partial<SurveyCategory> = {},
): SurveyCategory {
  return {
    id,
    code: id.toUpperCase(),
    name: `Category ${id}`,
    order: 0,
    subcategories: parts.subcategories ?? [],
    questions: parts.questions ?? [],
    ...overrides,
  };
}

export function survey(categories: readonly SurveyCategory[]): SurveyStructure {
  return { categories };
}

/** `'NA'` marks a not-applicable answer; `null` an unanswered one. */
export type AnswerSpec = Rating | 'NA' | null;

function answers(spec: Record<string, AnswerSpec>): SubmittedAssessment['answers'] {
  return Object.entries(spec).map(([questionId, value]) => ({
    questionId,
    rating: value === 'NA' || value === null ? null : value,
    na: value === 'NA',
  }));
}

export function customer(
  id: string,
  type: CustomerType | undefined,
  spec: Record<string, AnswerSpec>,
): SubmittedAssessment {
  return type === undefined
    ? { id, kind: 'CUSTOMER', answers: answers(spec) }
    : { id, kind: 'CUSTOMER', customerType: type, answers: answers(spec) };
}

export function selfAssessment(id: string, spec: Record<string, AnswerSpec>): SubmittedAssessment {
  return { id, kind: 'SELF', answers: answers(spec) };
}

export function settings(overrides: Partial<ScoringSettings> = {}): ScoringSettings {
  return { minResponses: 1, weightingMode: 'EQUAL', ...overrides };
}

export function row(rows: readonly ScoreRow[], level: ScoreLevel, refId: string): ScoreRow {
  const found = rows.find((candidate) => candidate.level === level && candidate.refId === refId);
  if (!found) throw new Error(`no ${level} row for ${refId}`);
  return found;
}

/** The standard tree: C1 { S1 { q1, q2 }, S2 { q3 } }, C2 { q4 }. */
export function standardSurvey(): SurveyStructure {
  return survey([
    category('c1', {
      subcategories: [subcategory('s1', [question('q1'), question('q2')]), subcategory('s2', [question('q3')])],
    }),
    category('c2', { questions: [question('q4')] }),
  ]);
}

/** Deterministic PRNG (mulberry32) for the property-style tests. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

export function integer(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}
