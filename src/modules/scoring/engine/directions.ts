import type { AnswerMode, ScoreDirection, SubmittedAssessment } from './types.js';

/** The directions a cycle is scored in: SINGLE, or IMPORT and EXPORT side by side. */
export function directionsFor(answerMode: AnswerMode): ScoreDirection[] {
  return answerMode === 'IMPORT_EXPORT' ? ['IMPORT', 'EXPORT'] : ['SINGLE'];
}

/**
 * The assessments behind one direction's figures, each reduced to that
 * direction's answers: SINGLE takes the SINGLE assessments, IMPORT / EXPORT
 * the IMPORT_EXPORT ones, so the two modes are never mixed.
 */
export function selectForDirection(assessments: readonly SubmittedAssessment[], direction: ScoreDirection): SubmittedAssessment[] {
  const mode: AnswerMode = direction === 'SINGLE' ? 'SINGLE' : 'IMPORT_EXPORT';
  return assessments
    .filter((assessment) => (assessment.answerMode ?? 'SINGLE') === mode)
    .map((assessment) => ({
      ...assessment,
      answers: assessment.answers
        .filter((answer) => (direction === 'SINGLE' ? answer.direction === undefined : answer.direction === direction))
        .map(({ questionId, rating, na }) => ({ questionId, rating, na })),
    }));
}
