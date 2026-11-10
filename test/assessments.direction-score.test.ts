
import { describe, expect, it } from 'vitest';

import { ownScoreByDirection } from '../src/modules/assessments/assessments.form.js';
import type { StoredAnswer } from '../src/modules/assessments/assessments.model.js';

describe('Import and Export assessment scoring', () => {
  const answers: StoredAnswer[] = [
    {
      questionId: 'q1',
      direction: 'IMPORT',
      rating: 5,
      na: false,
      comment: null,
      followUp: [],
    },
    {
      questionId: 'q1',
      direction: 'EXPORT',
      rating: 3,
      na: false,
      comment: null,
      followUp: [],
    },
    {
      questionId: 'q2',
      direction: 'IMPORT',
      rating: 4,
      na: false,
      comment: null,
      followUp: [],
    },
    {
      questionId: 'q2',
      direction: 'EXPORT',
      rating: 4,
      na: false,
      comment: null,
      followUp: [],
    },
    {
      questionId: 'q3',
      direction: 'IMPORT',
      rating: null,
      na: true,
      comment: null,
      followUp: [],
    },
    {
      questionId: 'q3',
      direction: 'EXPORT',
      rating: 2,
      na: false,
      comment: null,
      followUp: [],
    },
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
