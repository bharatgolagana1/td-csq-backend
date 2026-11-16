import { describe, expect, it } from 'vitest';

import { mergeAnswers, sharedAnswers, readinessOf, validateAnswers, type AnswerInput, type AssessmentForm, type CommentMode, type FormQuestion } from '../../../src/modules/assessments/assessments.form.js';
import { AssessmentModel } from '../../../src/modules/assessments/assessments.model.js';
import { answerInputSchema } from '../../../src/modules/assessments/assessments.schemas.js';

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

function issuesOf(inputs: AnswerInput[], mode: 'SINGLE' | 'IMPORT_EXPORT'): string[] {
  const result = validateAnswers(FORM, inputs, mode);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

describe.each(['SINGLE', 'IMPORT_EXPORT'] as const)('%s optional question comments', (mode) => {
  const direction = mode === 'IMPORT_EXPORT' ? { direction: 'IMPORT' as const } : {};

  it.each([undefined, null, '', '   ', '  Helpful  '])('accepts comment %j for every legacy comment mode on ratings and NA', (comment) => {
    for (const rating of [1, 2, 5, null]) {
      const inputs = IDS.flatMap((questionId) => (mode === 'IMPORT_EXPORT' ? ['IMPORT', 'EXPORT'] as const : [undefined]).map((direction) => ({ questionId, direction, rating, na: rating === null, comment })));
      const result = validateAnswers(FORM, inputs, mode);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.answers.every((answer) => answer.comment === (comment === undefined ? undefined : comment?.trim() ? comment.trim() : null))).toBe(true);
      expect(readinessOf(FORM, result.answers, mode).complete).toBe(true);
    }
  });

  it('allows 2000 characters after trimming and rejects 2001', () => {
    expect(issuesOf([{ questionId: 'req', ...direction, rating: 4, comment: `  ${'x'.repeat(2000)}  ` }], mode)).toEqual([]);
    expect(issuesOf([{ questionId: 'req', ...direction, rating: 4, comment: 'x'.repeat(2001) }], mode)).toEqual(['answers.0.comment: must be at most 2000 characters']);
  });

  it('keeps rating and follow-up validation', () => {
    expect(issuesOf([{ questionId: 'low', ...direction, rating: 2, followUp: ['Queues'] }], mode)).toEqual([]);
    expect(issuesOf([{ questionId: 'low', ...direction, rating: 4, comment: 'Fine', followUp: ['Queues'] }], mode)).toEqual(['answers.0.followUp: follow-up options apply to a Fair or Poor rating only']);
    expect(issuesOf([{ questionId: 'low', ...direction, rating: 1, followUp: ['Rude'] }], mode)).toEqual(['answers.0.followUp.0: "Rude" is not one of the listed options']);
    expect(issuesOf([{ questionId: 'req', ...direction, comment: 'Comment alone' }], mode)).toEqual(['answers.0.rating: needs a rating from 1 to 5 or NA']);
  });
});

describe('comment boundary and persistence validation', () => {
  it('trims before checking the limit and accepts optional, blank and null input', () => {
    for (const comment of [undefined, null, '', '   ', `  ${'x'.repeat(2000)}  `]) {
      expect(answerInputSchema.safeParse({ questionId: 'req', rating: 4, comment }).success).toBe(true);
    }
    expect(answerInputSchema.parse({ questionId: 'req', rating: 4, comment: '  Note  ' }).comment).toBe('Note');
    for (const comment of [123, {}, 'x'.repeat(2001)]) {
      expect(answerInputSchema.safeParse({ questionId: 'req', rating: 4, comment }).success).toBe(false);
    }
  });

  it('persists trimmed comments with a length limit on each answer', () => {
    const doc = new AssessmentModel({ answers: [
      { questionId: 'req', direction: 'IMPORT', rating: 4, comment: '  Import  ' },
      { questionId: 'req', direction: 'EXPORT', rating: 5, comment: '  Export  ' },
    ] });
    expect(doc.answers.map((answer) => answer.comment)).toEqual(['Import', 'Export']);
    expect(doc.validateSync(['answers'])).toBeUndefined();
    doc.answers[0]!.comment = 'x'.repeat(2001);
    expect(doc.validateSync(['answers'])?.errors['answers.0.comment']).toBeDefined();
  });
});

it.each(['', '   ', null])('clears the shared comment with %j', (comment) => {
  const saved = validateAnswers(FORM, [
    { questionId: 'req', direction: 'IMPORT', rating: 2, comment: 'Shared note' },
    { questionId: 'req', direction: 'EXPORT', rating: 5, comment: 'Shared note' },
  ], 'IMPORT_EXPORT');
  const cleared = validateAnswers(FORM, [{ questionId: 'req', direction: 'IMPORT', rating: 2, comment }], 'IMPORT_EXPORT');
  expect(saved.ok && cleared.ok).toBe(true);
  if (!saved.ok || !cleared.ok) return;
  expect(mergeAnswers(mergeAnswers([], saved.answers), cleared.answers).map((answer) => [answer.direction, answer.comment])).toEqual([['IMPORT', null], ['EXPORT', null]]);
});


describe('shared comment merge semantics', () => {
  const saved = [
    { questionId: 'req', direction: 'IMPORT' as const, rating: 2 as const, na: false, comment: 'Saved', followUp: ['Queues'] },
    { questionId: 'req', direction: 'EXPORT' as const, rating: 5 as const, na: false, comment: 'Saved', followUp: [] },
  ];
  it('preserves omitted comments and independent ratings/follow-ups', () => {
    const validated = validateAnswers(FORM, [{ questionId: 'req', direction: 'EXPORT', rating: 3 }], 'IMPORT_EXPORT');
    if (!validated.ok) throw new Error('invalid fixture');
    expect(mergeAnswers(saved, validated.answers)).toEqual([saved[0], { ...saved[1]!, rating: 3 }]);
    expect(mergeAnswers(saved, [{ ...saved[1]!, comment: 'Changed' }]).map((a) => a.comment)).toEqual(['Changed', 'Changed']);
    expect(mergeAnswers([{ ...saved[0]!, direction: null }], [{ questionId: 'req', rating: 4, na: false, followUp: [] }])[0]?.comment).toBe('Saved');
  });
  it('rejects conflicting explicit values but accepts mirrored normalized values', () => {
    expect(issuesOf(saved, 'IMPORT_EXPORT')).toEqual(['answers.0.followUp: this question has no follow-up options']);
    const conflict = validateAnswers(FORM, saved.map((a, i) => ({ ...a, followUp: [], comment: i ? null : 'Note' })), 'IMPORT_EXPORT');
    expect(conflict).toMatchObject({ ok: false, issues: [{ path: 'answers.1.comment', message: 'conflicting comments for the same question' }] });
    expect(validateAnswers(FORM, saved.map((a) => ({ ...a, followUp: [], comment: ' Note ' })), 'IMPORT_EXPORT').ok).toBe(true);
  });
  it('consolidates distinct legacy notes without truncation and is idempotent', () => {
    const legacy = saved.map((a, i) => ({ ...a, comment: (i ? 'e' : 'i').repeat(2000) }));
    const shared = sharedAnswers(legacy);
    expect(shared[0]?.comment).toContain('IMPORT: ' + 'i'.repeat(2000));
    expect(shared[0]?.comment).toContain('EXPORT: ' + 'e'.repeat(2000));
    expect(shared[1]?.comment).toBe(shared[0]?.comment);
    expect(sharedAnswers(shared)).toEqual(shared);
  });
});
