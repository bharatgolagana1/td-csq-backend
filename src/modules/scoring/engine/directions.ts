
import type { SubmittedAssessment } from './types.js';

export type ScoreDirection = 'SINGLE' | 'IMPORT' | 'EXPORT';

/**
 * Select assessments and answers for one independent score.
 * Legacy SINGLE assessments are never mixed into Import/Export.
 */
export function selectForDirection(
  assessments: readonly SubmittedAssessment[],
  direction: ScoreDirection,
): SubmittedAssessment[] {
  const mode =
    direction === 'SINGLE' ? 'SINGLE' : 'IMPORT_EXPORT';

  return assessments
    .filter(
      (assessment) =>
        (assessment.answerMode ?? 'SINGLE') === mode,
    )
    .map((assessment) => ({
      ...assessment,
      answers: assessment.answers
        .filter((answer) =>
          direction === 'SINGLE'
            ? !answer.direction
            : answer.direction === direction,
        )
        .map(({ questionId, rating, na }) => ({
          questionId,
          rating,
          na,
        })),
    }));
}
