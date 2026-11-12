// The demo's answer generator: one answer per question on a SINGLE form, an
// IMPORT and an EXPORT answer per question on an IMPORT_EXPORT one (export a
// touch lower), every batch valid against the form rules.
import { describe, expect, it } from 'vitest';

import { readinessOf, validateAnswers, type AssessmentForm, type FormQuestion } from '../../../src/modules/assessments/assessments.form.js';
import { Rng } from '../../../src/seed/demo/prng.js';
import { generateAnswers, type RatingProfile } from '../../../src/seed/demo/responses.js';

function question(id: string, order: number): FormQuestion {
  return { id, categoryId: 'c1', subcategoryId: null, code: id.toUpperCase(), text: id, help: null, order, weightPct: null, mandatory: true, commentMode: 'OPTIONAL', followUp: null };
}

function formOf(count: number): AssessmentForm {
  const questions = Array.from({ length: count }, (_, i) => question(`q${i + 1}`, i + 1));
  return {
    survey: { id: 's1', code: 'DOMESTIC', name: 'Domestic', version: 1, status: 'PUBLISHED' },
    stakeholderType: 'FF',
    scale: [],
    questionCount: count,
    categories: [{ id: 'c1', code: 'INFRA', name: 'Infrastructure', order: 1, weightPct: null, questions, subcategories: [] }],
  };
}

const PROFILE: RatingProfile = { quality: 0.6, bias: {} };

describe('generateAnswers', () => {
  it('answers a SINGLE form once per question, without a direction', () => {
    const form = formOf(3);
    const answers = generateAnswers(form, PROFILE, new Rng('single'), { naRate: 0.1, self: false });
    expect(answers.map((answer) => [answer.questionId, answer.direction])).toEqual([
      ['q1', undefined],
      ['q2', undefined],
      ['q3', undefined],
    ]);
    expect(generateAnswers(form, PROFILE, new Rng('single'), { naRate: 0.1, self: false, answerMode: 'SINGLE' })).toEqual(answers);
    expect(validateAnswers(form, answers).ok).toBe(true);
  });

  it('answers an IMPORT_EXPORT form for import and for export, completing it', () => {
    const form = formOf(3);
    const answers = generateAnswers(form, PROFILE, new Rng('split'), { naRate: 0.1, self: false, answerMode: 'IMPORT_EXPORT' });
    expect(answers.map((answer) => [answer.questionId, answer.direction])).toEqual([
      ['q1', 'IMPORT'],
      ['q1', 'EXPORT'],
      ['q2', 'IMPORT'],
      ['q2', 'EXPORT'],
      ['q3', 'IMPORT'],
      ['q3', 'EXPORT'],
    ]);
    const validation = validateAnswers(form, answers, 'IMPORT_EXPORT');
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(readinessOf(form, validation.answers, 'IMPORT_EXPORT')).toMatchObject({ answered: 6, total: 6, complete: true });
  });

  it('rates export a little below import', () => {
    const answers = generateAnswers(formOf(400), PROFILE, new Rng('shift'), { naRate: 0, self: false, answerMode: 'IMPORT_EXPORT' });
    const mean = (direction: 'IMPORT' | 'EXPORT'): number => {
      const ratings = answers.filter((answer) => answer.direction === direction).map((answer) => answer.rating ?? 0);
      return ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
    };
    expect(mean('EXPORT')).toBeLessThan(mean('IMPORT'));
  });
});
