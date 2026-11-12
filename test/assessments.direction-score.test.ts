// An IMPORT_EXPORT assessment's own score per direction (the history grid's
// `importScore` / `exportScore`): NA-excluding mean, 1 dp.
import { describe, expect, it } from 'vitest';

import { ownScoreByDirection } from '../src/modules/assessments/assessments.form.js';
import type { StoredAnswer } from '../src/modules/assessments/assessments.model.js';

function answer(questionId: string, direction: 'IMPORT' | 'EXPORT', rating: StoredAnswer['rating']): StoredAnswer {
  return { questionId, direction, rating, na: rating === null, comment: null, followUp: [] };
}

describe('Import and Export assessment scoring', () => {
  const answers: StoredAnswer[] = [
    answer('q1', 'IMPORT', 5),
    answer('q1', 'EXPORT', 3),
    answer('q2', 'IMPORT', 4),
    answer('q2', 'EXPORT', 4),
    answer('q3', 'IMPORT', null),
    answer('q3', 'EXPORT', 2),
  ];

  it('calculates Import independently and excludes NA', () => {
    expect(ownScoreByDirection(answers, 'IMPORT')).toBe(4.5);
  });

  it('calculates Export independently', () => {
    expect(ownScoreByDirection(answers, 'EXPORT')).toBe(3);
  });

  it('returns null when a direction has no rated answers', () => {
    expect(ownScoreByDirection([], 'IMPORT')).toBeNull();
  });
});
