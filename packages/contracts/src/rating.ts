import { z } from 'zod';

/**
 * The rating scale is five points plus NA. This is a locked product decision:
 * the ACFI paper forms print a 1-10 column, but CSQ renders that question text
 * on the five-point scale from the CSQ requirements, so there is no ten-point
 * engine anywhere in this system.
 *
 * NA is not a sixth score. It removes the question from the calculation entirely
 * and its weight is redistributed across the remaining answered questions, so a
 * terminal is never penalised for a parameter that does not apply to it.
 */
export const RATING_SCALE = [
  { key: 'EXCELLENT', score: 5, label: 'Excellent' },
  { key: 'VERY_GOOD', score: 4, label: 'Very good' },
  { key: 'GOOD', score: 3, label: 'Good' },
  { key: 'FAIR', score: 2, label: 'Fair' },
  { key: 'POOR', score: 1, label: 'Poor' },
  { key: 'NA', score: null, label: 'Not applicable' },
] as const;

export const RatingKey = z.enum(['EXCELLENT', 'VERY_GOOD', 'GOOD', 'FAIR', 'POOR', 'NA']);
export type RatingKey = z.infer<typeof RatingKey>;

const SCORE_BY_KEY: Readonly<Record<RatingKey, number | null>> = Object.freeze(
  Object.fromEntries(RATING_SCALE.map((r) => [r.key, r.score])) as Record<RatingKey, number | null>,
);

/** Numeric score for a rating, or null when the rating is NA. */
export function scoreOf(key: RatingKey): number | null {
  return SCORE_BY_KEY[key];
}

export function isScored(key: RatingKey): boolean {
  return SCORE_BY_KEY[key] !== null;
}

/** The ratings that reveal follow-up questions by default (H4 makes this configurable). */
export const DEFAULT_REVEAL_ON: readonly RatingKey[] = ['FAIR', 'POOR'] as const;

export const MIN_SCORE = 1;
export const MAX_SCORE = 5;
