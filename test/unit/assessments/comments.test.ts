// The comment rules of `validateAnswers` per answer mode: a SINGLE answer
// follows its question's comment mode; an IMPORT_EXPORT answer takes no
// comment whatever the mode (empty or null is fine, text is an issue) while
// its rating and follow-up rules still apply per direction.
import { describe, expect, it } from 'vitest';

import { readinessOf, validateAnswers, type AnswerInput, type AssessmentForm, type CommentMode, type FormQuestion } from '../../../src/modules/assessments/assessments.form.js';

const OPTIONS = ['Queues', 'Paperwork'];

function question(id: string, order: number, commentMode: CommentMode, followUp = false): FormQuestion {
  return {
    id,
    categoryId: 'c1',
    subcategoryId: null,
    code: id.toUpperCase(),
    text: id,
    help: null,
    order,
    weightPct: null,
    mandatory: true,
    commentMode,
    followUp: followUp ? { prompt: 'What went wrong?', options: OPTIONS } : null,
  };
}

const FORM: AssessmentForm = {
  survey: { id: 's1', code: 'DOMESTIC', name: 'Domestic', version: 1, status: 'PUBLISHED' },
  stakeholderType: 'FF',
  scale: [],
  questionCount: 4,
  categories: [
    {
      id: 'c1',
      code: 'INFRA',
      name: 'Infrastructure',
      order: 1,
      weightPct: null,
      questions: [question('req', 1, 'REQUIRED'), question('low', 2, 'REQUIRED_ON_LOW', true), question('opt', 3, 'OPTIONAL'), question('none', 4, 'NONE')],
      subcategories: [],
    },
  ],
};

const IDS = ['req', 'low', 'opt', 'none'] as const;
const NO_COMMENT = 'an import / export answer takes no comment; write it in the section remark';

function issuesOf(inputs: AnswerInput[], mode: 'SINGLE' | 'IMPORT_EXPORT'): string[] {
  const result = validateAnswers(FORM, inputs, mode);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

describe('validateAnswers — IMPORT_EXPORT comments', () => {
  it('accepts every question without a comment, Poor on REQUIRED and REQUIRED_ON_LOW included, and the form is then complete', () => {
    const inputs = IDS.flatMap((questionId) => (['IMPORT', 'EXPORT'] as const).map((direction) => ({ questionId, direction, rating: 1 })));
    const result = validateAnswers(FORM, inputs, 'IMPORT_EXPORT');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.every((answer) => answer.comment === null)).toBe(true);
    expect(readinessOf(FORM, result.answers, 'IMPORT_EXPORT')).toEqual({ answered: 8, total: 8, missing: [], complete: true });
  });

  it('treats a null or blank comment as none', () => {
    expect(issuesOf([{ questionId: 'req', direction: 'IMPORT', rating: 3, comment: null }, { questionId: 'none', direction: 'EXPORT', na: true, comment: '  ' }], 'IMPORT_EXPORT')).toEqual([]);
  });

  it('refuses a comment on any question, whatever its comment mode', () => {
    const inputs = IDS.map((questionId) => ({ questionId, direction: 'EXPORT' as const, rating: 2, comment: 'Slow' }));
    expect(issuesOf(inputs, 'IMPORT_EXPORT')).toEqual(IDS.map((_, index) => `answers.${index}.comment: ${NO_COMMENT}`));
  });

  it('keeps the follow-up rule per direction: only on Fair or Poor, only listed options', () => {
    expect(issuesOf([{ questionId: 'low', direction: 'IMPORT', rating: 2, followUp: ['Queues'] }, { questionId: 'low', direction: 'EXPORT', rating: 5 }], 'IMPORT_EXPORT')).toEqual([]);
    expect(issuesOf([{ questionId: 'low', direction: 'EXPORT', rating: 4, followUp: ['Queues'] }], 'IMPORT_EXPORT')).toEqual(['answers.0.followUp: follow-up options apply to a Fair or Poor rating only']);
    expect(issuesOf([{ questionId: 'low', direction: 'IMPORT', rating: 1, followUp: ['Rude'] }], 'IMPORT_EXPORT')).toEqual(['answers.0.followUp.0: "Rude" is not one of the listed options']);
  });
});

describe('validateAnswers — SINGLE comments (unchanged)', () => {
  it('requires the comment REQUIRED and a low REQUIRED_ON_LOW ask for, and refuses one on NONE', () => {
    expect(issuesOf([{ questionId: 'req', rating: 4 }, { questionId: 'low', rating: 2 }, { questionId: 'opt', rating: 2 }, { questionId: 'none', rating: 3, comment: 'Fine' }], 'SINGLE')).toEqual([
      'answers.0.comment: a comment is required for this question',
      'answers.1.comment: a comment is required for a Fair or Poor rating',
      'answers.3.comment: this question takes no comment',
    ]);
    expect(issuesOf([{ questionId: 'req', rating: 4, comment: 'Fine' }, { questionId: 'low', rating: 2, comment: 'Slow' }, { questionId: 'opt', rating: 2 }], 'SINGLE')).toEqual([]);
  });
});
