
import { describe, expect, it } from 'vitest';

import {
  scoreAssessments,
  selectForDirection,
  type SubmittedAssessment,
} from '../../../src/modules/scoring/engine/index.js';

import {
  category,
  question,
  row,
  settings,
  survey,
} from './fixtures.js';

const assessments: SubmittedAssessment[] = [
  {
    id: 'legacy',
    kind: 'CUSTOMER',
    customerType: 'FF',
    answers: [
      { questionId: 'q1', rating: 4, na: false },
    ],
  },
  {
    id: 'split',
    kind: 'CUSTOMER',
    customerType: 'FF',
    answerMode: 'IMPORT_EXPORT',
    answers: [
      {
        questionId: 'q1',
        direction: 'IMPORT',
        rating: 5,
        na: false,
      },
      {
        questionId: 'q1',
        direction: 'EXPORT',
        rating: 2,
        na: false,
      },
    ],
  },
];

const form = survey([
  category('c1', {
    questions: [question('q1')],
  }),
]);

describe('directional scoring', () => {
  it('calculates Import separately', () => {
    const result = scoreAssessments(
      form,
      selectForDirection(assessments, 'IMPORT'),
      settings(),
    );

    expect(row(result, 'QUESTION', 'q1').customer.mean).toBe(5);
    expect(row(result, 'QUESTION', 'q1').customer.n).toBe(1);
  });

  it('calculates Export separately', () => {
    const result = scoreAssessments(
      form,
      selectForDirection(assessments, 'EXPORT'),
      settings(),
    );

    expect(row(result, 'QUESTION', 'q1').customer.mean).toBe(2);
    expect(row(result, 'QUESTION', 'q1').customer.n).toBe(1);
  });

  it('preserves the original historical score', () => {
    const result = scoreAssessments(
      form,
      selectForDirection(assessments, 'SINGLE'),
      settings(),
    );

    expect(row(result, 'QUESTION', 'q1').customer.mean).toBe(4);
    expect(row(result, 'QUESTION', 'q1').customer.n).toBe(1);
  });
});
