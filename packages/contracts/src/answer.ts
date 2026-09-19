import { z } from 'zod';
import { Direction } from './direction.js';
import { RatingKey } from './rating.js';

/**
 * One answer carries one rating per applicable direction, plus optional free
 * text. It is deliberately not two separate answers: the question is one
 * question, and the pair is what the printed ACFI form actually asks for.
 */
export const DirectionalRating = z.object({
  direction: Direction,
  rating: RatingKey,
  /** Sub-parameter option keys the assessor ticked. Carry no weight. */
  options: z.array(z.string().min(1)).max(32).default([]),
  /** Answers to follow-ups revealed by a low rating. Unscored. */
  followUps: z
    .array(z.object({ code: z.string().min(1), value: z.string().max(2000) }))
    .max(16)
    .default([]),
});
export type DirectionalRating = z.infer<typeof DirectionalRating>;

export const Answer = z.object({
  questionCode: z.string().min(1).max(120),
  ratings: z.array(DirectionalRating).min(1).max(2),
  comment: z.string().max(2000).optional(),
});
export type Answer = z.infer<typeof Answer>;

/**
 * A question counts as complete only when every direction the form asks for has
 * a rating. A half-answered question must not let a submit through, which is why
 * the progress denominator is computed from applicable directions, not questions.
 */
export function isAnswerComplete(answer: Answer, applicable: readonly Direction[]): boolean {
  const seen = new Set(answer.ratings.map((r) => r.direction));
  return applicable.every((d) => seen.has(d));
}

export const AssessorKind = z.enum(['SELF', 'CUSTOMER', 'EXTERNAL']);
export type AssessorKind = z.infer<typeof AssessorKind>;

export const AssessmentState = z.enum(['DRAFT', 'SUBMITTED', 'DISCARDED']);
export type AssessmentState = z.infer<typeof AssessmentState>;
