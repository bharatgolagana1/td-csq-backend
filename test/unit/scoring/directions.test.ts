// Scoring per direction: a cycle's answer mode gives its directions, and each
// direction scores only its own mode's assessments and its own answers.
import { describe, expect, it } from 'vitest';

import { directionsFor, scoreAssessments, selectForDirection, type SubmittedAssessment } from '../../../src/modules/scoring/engine/index.js';

import { category, question, row, settings, survey } from './fixtures.js';

const assessments: SubmittedAssessment[] = [
  { id: 'legacy', kind: 'CUSTOMER', customerType: 'FF', answers: [{ questionId: 'q1', rating: 4, na: false }] },
  {
    id: 'split',
    kind: 'CUSTOMER',
    customerType: 'FF',
    answerMode: 'IMPORT_EXPORT',
    answers: [
      { questionId: 'q1', direction: 'IMPORT', rating: 5, na: false },
      { questionId: 'q1', direction: 'EXPORT', rating: 2, na: false },
    ],
  },
];

const form = survey([category('c1', { questions: [question('q1')] })]);

describe('directionsFor', () => {
  it('scores a SINGLE cycle once and an IMPORT_EXPORT cycle per direction', () => {
    expect(directionsFor('SINGLE')).toEqual(['SINGLE']);
    expect(directionsFor('IMPORT_EXPORT')).toEqual(['IMPORT', 'EXPORT']);
  });
});

describe('selectForDirection', () => {
  it('calculates Import separately', () => {
    const result = scoreAssessments(form, selectForDirection(assessments, 'IMPORT'), settings());
    expect(row(result, 'QUESTION', 'q1').customer).toMatchObject({ mean: 5, n: 1 });
  });

  it('calculates Export separately', () => {
    const result = scoreAssessments(form, selectForDirection(assessments, 'EXPORT'), settings());
    expect(row(result, 'QUESTION', 'q1').customer).toMatchObject({ mean: 2, n: 1 });
  });

  it('keeps SINGLE to the single-answer assessments, never mixing in an IMPORT_EXPORT one', () => {
    const selected = selectForDirection(assessments, 'SINGLE');
    expect(selected.map((assessment) => assessment.id)).toEqual(['legacy']);
    expect(row(scoreAssessments(form, selected, settings()), 'QUESTION', 'q1').customer).toMatchObject({ mean: 4, n: 1 });
  });
});
