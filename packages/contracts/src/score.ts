import { z } from 'zod';

/**
 * Every score the API emits travels in this envelope. A bare number is never
 * returned, because a score is meaningless without the coverage and response
 * count that produced it, and without knowing whether it is publishable.
 *
 * `scoreCoverageBp` is the share of the instrument's weight that was actually
 * answered, after NA redistribution. A composite built from half the questions
 * is not comparable to one built from all of them, and the dashboards need to
 * say so rather than quietly render both as "3.4".
 */
export const ScoreEnvelope = z.object({
  /** 1.0 to 5.0, rounded to one decimal for display. Null when suppressed. */
  value: z.number().min(1).max(5).nullable(),
  /** Basis points of instrument weight answered, 0-10000. */
  scoreCoverageBp: z.number().int().min(0).max(10000),
  /** Distinct assessors whose submissions fed this number. */
  responseCount: z.number().int().min(0),
  /** Why a null value is null, so the UI can say something useful. */
  suppression: z.enum(['NONE', 'BELOW_MIN_RESPONSES', 'BELOW_MIN_COVERAGE', 'NOT_YET_SCORED']),
  /** Which weighting profile produced it, so a score is always reproducible. */
  weightingProfile: z.object({ profileId: z.string(), version: z.number().int() }),
  /** True when the market-share stage participated. See H1/H7. */
  marketShareApplied: z.boolean(),
});
export type ScoreEnvelope = z.infer<typeof ScoreEnvelope>;

export const CategoryScore = ScoreEnvelope.extend({ categoryCode: z.string() });
export type CategoryScore = z.infer<typeof CategoryScore>;

/**
 * Publication thresholds. A score computed from too few voices is not a score,
 * it is an anecdote with a decimal point, and publishing it would be the fastest
 * way to destroy the standard's credibility.
 */
export const MIN_RESPONSES_TO_PUBLISH = 5;
export const MIN_COVERAGE_BP_TO_PUBLISH = 6000;
