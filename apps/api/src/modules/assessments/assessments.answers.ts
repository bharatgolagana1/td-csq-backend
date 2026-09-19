import { Answer, type Direction, type RatingKey } from '@csq/contracts';
import { fail } from '../../kernel/errors.js';
import type { AnswerOp } from './assessments.contracts.js';
import type {
  InstrumentDoc,
  InstrumentQuestionDoc,
  StoredAnswerDoc,
  StoredDirectionalRatingDoc,
} from './assessments.models.js';

/**
 * The answer document as data, with no database and no clock of its own.
 *
 * Everything that decides whether a return may be submitted lives here, because
 * these are the rules a bug would be most expensive in: a progress bar that
 * counts questions instead of directions lets a half-answered form through, and
 * a follow-up that outlives the rating that revealed it puts an explanation for
 * a POOR next to a rating of EXCELLENT.
 */

export interface AnswerContext {
  readonly now: Date;
  readonly userId: string;
}

export interface Progress {
  readonly applicableDirections: number;
  readonly answeredDirections: number;
  readonly percentBp: number;
}

export type BlockerReason =
  | 'DIRECTION_UNANSWERED'
  | 'FOLLOW_UP_MISSING'
  | 'UNKNOWN_QUESTION'
  | 'DIRECTION_NOT_APPLICABLE';

export interface SubmitBlocker {
  readonly questionCode: string;
  readonly direction: Direction | null;
  readonly reason: BlockerReason;
  readonly message: string;
}

const BP = 10_000;

export function indexQuestions(instrument: InstrumentDoc): ReadonlyMap<string, InstrumentQuestionDoc> {
  return new Map(instrument.questions.map((q) => [q.code, q]));
}

/** A question counts toward progress only if it is required and actually rated. */
function countsTowardProgress(question: InstrumentQuestionDoc): boolean {
  return question.required && question.answerType === 'RATING_5';
}

/**
 * Progress is measured in applicable directions, never in questions. A question
 * rated on export and left blank on import is not half done for the purpose of
 * submitting: the import column is unanswered and must block.
 */
export function computeProgress(instrument: InstrumentDoc, answers: readonly StoredAnswerDoc[]): Progress {
  const byCode = new Map(answers.map((a) => [a.questionCode, a]));
  let applicableDirections = 0;
  let answeredDirections = 0;

  for (const question of instrument.questions) {
    if (!countsTowardProgress(question)) continue;
    const answer = byCode.get(question.code);
    for (const direction of question.applicableDirections) {
      applicableDirections += 1;
      if (answer?.ratings.some((r) => r.direction === direction)) answeredDirections += 1;
    }
  }

  return {
    applicableDirections,
    answeredDirections,
    // an instrument with nothing required is complete rather than undefined
    percentBp:
      applicableDirections === 0 ? BP : Math.round((answeredDirections / applicableDirections) * BP),
  };
}

function revealsFollowUp(revealOn: readonly RatingKey[], rating: RatingKey): boolean {
  return revealOn.includes(rating);
}

/**
 * Drops follow-up answers the current rating no longer reveals. Called after
 * every rating change and once more at submit, so a comment written under POOR
 * cannot survive the assessor changing that rating to EXCELLENT.
 */
export function pruneFollowUps(
  question: InstrumentQuestionDoc,
  rating: StoredDirectionalRatingDoc,
): StoredDirectionalRatingDoc {
  const declared = new Map(question.followUps.map((f) => [f.code, f]));
  const kept = rating.followUps.filter((answer) => {
    const followUp = declared.get(answer.code);
    return followUp !== undefined && revealsFollowUp(followUp.revealOn, rating.rating);
  });
  return kept.length === rating.followUps.length ? rating : { ...rating, followUps: kept };
}

/** The follow-ups a rating currently reveals, for the form to render. */
export function revealedFollowUps(
  question: InstrumentQuestionDoc,
  rating: RatingKey,
): InstrumentQuestionDoc['followUps'] {
  return question.followUps.filter((f) => revealsFollowUp(f.revealOn, rating));
}

interface Issue {
  path: string;
  message: string;
}

/**
 * Applies a batch of operations to a copy of the answers.
 *
 * The whole batch is accepted or refused together and every problem in it is
 * reported at once, so an autosave that fails tells the tab which fields to fix
 * rather than one of them per round trip.
 */
export function applyOps(
  instrument: InstrumentDoc,
  current: readonly StoredAnswerDoc[],
  ops: readonly AnswerOp[],
  context: AnswerContext,
): { answers: StoredAnswerDoc[]; touched: string[] } {
  const questions = indexQuestions(instrument);
  const answers: StoredAnswerDoc[] = structuredClone(current as StoredAnswerDoc[]);
  const issues: Issue[] = [];
  const touched = new Set<string>();

  ops.forEach((op, index) => {
    const at = `ops.${index}`;
    const question = questions.get(op.questionCode);
    if (!question) {
      issues.push({ path: `${at}.questionCode`, message: `${op.questionCode} is not on this form` });
      return;
    }

    if (op.op !== 'SET_COMMENT' && !question.applicableDirections.includes(op.direction)) {
      issues.push({
        path: `${at}.direction`,
        message: `${op.questionCode} is not asked for ${op.direction} on this form`,
      });
      return;
    }

    const answer = upsertAnswer(answers, op.questionCode, context.now);

    switch (op.op) {
      case 'SET_RATING': {
        if (question.answerType !== 'RATING_5') {
          issues.push({ path: `${at}.rating`, message: `${op.questionCode} is not a rated question` });
          return;
        }
        const existing = answer.ratings.find((r) => r.direction === op.direction);
        const next: StoredDirectionalRatingDoc = {
          direction: op.direction,
          rating: op.rating,
          options: existing?.options ?? [],
          followUps: existing?.followUps ?? [],
          updatedAt: context.now,
          updatedBy: context.userId,
        };
        replaceRating(answer, pruneFollowUps(question, next));
        break;
      }

      case 'CLEAR_RATING': {
        // options and follow-ups go with it: an unrated direction cannot have
        // revealed anything, and leaving them would resurrect on the next rating
        answer.ratings = answer.ratings.filter((r) => r.direction !== op.direction);
        break;
      }

      case 'SET_OPTIONS': {
        const existing = answer.ratings.find((r) => r.direction === op.direction);
        if (!existing) {
          issues.push({
            path: `${at}.options`,
            message: 'rate this direction before choosing sub-parameters',
          });
          return;
        }
        const declared = new Set(question.options.map((o) => o.key));
        const unknown = op.options.filter((key) => !declared.has(key));
        if (unknown.length > 0) {
          issues.push({
            path: `${at}.options`,
            message: `${unknown.join(', ')} is not a sub-parameter of ${op.questionCode}`,
          });
          return;
        }
        replaceRating(answer, {
          ...existing,
          options: [...new Set(op.options)],
          updatedAt: context.now,
          updatedBy: context.userId,
        });
        break;
      }

      case 'SET_FOLLOW_UP': {
        const existing = answer.ratings.find((r) => r.direction === op.direction);
        if (!existing) {
          issues.push({ path: `${at}.code`, message: 'rate this direction before answering its follow-up' });
          return;
        }
        const declared = question.followUps.find((f) => f.code === op.code);
        if (!declared) {
          issues.push({
            path: `${at}.code`,
            message: `${op.code} is not a follow-up of ${op.questionCode}`,
          });
          return;
        }
        if (!revealsFollowUp(declared.revealOn, existing.rating)) {
          issues.push({
            path: `${at}.code`,
            message: `${op.code} is not revealed by a rating of ${existing.rating}`,
          });
          return;
        }
        const value = op.value.trim();
        const others = existing.followUps.filter((f) => f.code !== op.code);
        const followUps =
          value.length === 0
            ? others
            : [...others, { code: op.code, value, updatedAt: context.now, updatedBy: context.userId }];
        replaceRating(answer, { ...existing, followUps });
        break;
      }

      case 'SET_COMMENT': {
        // the locked Answer shape carries a comment inside an answer that has at
        // least one rating, so there is no such thing as a comment on its own
        if (answer.ratings.length === 0) {
          issues.push({ path: `${at}.comment`, message: 'rate this question before commenting on it' });
          return;
        }
        const comment = op.comment === null ? null : op.comment.trim();
        answer.comment = comment === null || comment.length === 0 ? null : comment;
        break;
      }
    }

    answer.updatedAt = context.now;
    touched.add(op.questionCode);
  });

  if (issues.length > 0) {
    throw fail(
      'VALIDATION_FAILED',
      'Some of these changes do not fit the form',
      issues.map((i) => ({ path: i.path, message: i.message })),
    );
  }

  return { answers: answers.filter(carriesAnything), touched: [...touched] };
}

/**
 * An answer with no rating left is not an answer. Clearing the last direction
 * takes the comment with it, because a comment belongs to the answer and the
 * contract has no shape for one that stands alone.
 */
function carriesAnything(answer: StoredAnswerDoc): boolean {
  return answer.ratings.length > 0;
}

function upsertAnswer(answers: StoredAnswerDoc[], questionCode: string, now: Date): StoredAnswerDoc {
  const existing = answers.find((a) => a.questionCode === questionCode);
  if (existing) return existing;
  const created: StoredAnswerDoc = { questionCode, ratings: [], comment: null, updatedAt: now };
  answers.push(created);
  return created;
}

function replaceRating(answer: StoredAnswerDoc, rating: StoredDirectionalRatingDoc): void {
  const others = answer.ratings.filter((r) => r.direction !== rating.direction);
  answer.ratings = [...others, rating];
}

/** Prunes every answer against the instrument. Idempotent, and run again at submit. */
export function pruneAll(instrument: InstrumentDoc, answers: readonly StoredAnswerDoc[]): StoredAnswerDoc[] {
  const questions = indexQuestions(instrument);
  return answers.map((answer) => {
    const question = questions.get(answer.questionCode);
    if (!question) return answer;
    return { ...answer, ratings: answer.ratings.map((rating) => pruneFollowUps(question, rating)) };
  });
}

/**
 * Everything that stands between a draft and a submission. Returned as a list
 * rather than a boolean so the form can mark the fields, and computed server
 * side so a client that decides it is complete cannot make it so.
 */
export function submitBlockers(
  instrument: InstrumentDoc,
  answers: readonly StoredAnswerDoc[],
): SubmitBlocker[] {
  const questions = indexQuestions(instrument);
  const byCode = new Map(answers.map((a) => [a.questionCode, a]));
  const blockers: SubmitBlocker[] = [];

  for (const question of instrument.questions) {
    const answer = byCode.get(question.code);
    for (const direction of question.applicableDirections) {
      const rating = answer?.ratings.find((r) => r.direction === direction);
      if (!rating) {
        if (countsTowardProgress(question)) {
          blockers.push({
            questionCode: question.code,
            direction,
            reason: 'DIRECTION_UNANSWERED',
            message: `${question.code} has no ${direction} rating`,
          });
        }
        continue;
      }
      for (const followUp of question.followUps) {
        if (!followUp.required) continue;
        if (!revealsFollowUp(followUp.revealOn, rating.rating)) continue;
        const given = rating.followUps.find((f) => f.code === followUp.code);
        if (!given || given.value.trim().length === 0) {
          blockers.push({
            questionCode: question.code,
            direction,
            reason: 'FOLLOW_UP_MISSING',
            message: `${followUp.code} is required when ${direction} is rated ${rating.rating}`,
          });
        }
      }
    }
  }

  // defensive: an instrument is immutable once published, so these can only come
  // from a document edited outside the API. Better refused than silently scored
  for (const answer of answers) {
    const question = questions.get(answer.questionCode);
    if (!question) {
      blockers.push({
        questionCode: answer.questionCode,
        direction: null,
        reason: 'UNKNOWN_QUESTION',
        message: `${answer.questionCode} is not on this form`,
      });
      continue;
    }
    for (const rating of answer.ratings) {
      if (!question.applicableDirections.includes(rating.direction)) {
        blockers.push({
          questionCode: answer.questionCode,
          direction: rating.direction,
          reason: 'DIRECTION_NOT_APPLICABLE',
          message: `${answer.questionCode} is not asked for ${rating.direction} on this form`,
        });
      }
    }
  }

  return blockers;
}

export interface AnswerView {
  questionCode: string;
  ratings: Array<{
    direction: Direction;
    rating: RatingKey;
    options: string[];
    followUps: Array<{ code: string; value: string }>;
  }>;
  comment?: string;
  updatedAt: string;
}

/**
 * The stored shape carries who touched each leaf and when. The wire shape is the
 * locked Answer from @csq/contracts, validated on the way out for the same
 * reason the settings module re-validates its sections: a document that drifted
 * should be found here, not in the frontend.
 */
export function toAnswerViews(answers: readonly StoredAnswerDoc[]): AnswerView[] {
  return answers.map((stored) => {
    const candidate = {
      questionCode: stored.questionCode,
      ratings: stored.ratings.map((r) => ({
        direction: r.direction,
        rating: r.rating,
        options: [...r.options],
        followUps: r.followUps.map((f) => ({ code: f.code, value: f.value })),
      })),
      ...(stored.comment === null ? {} : { comment: stored.comment }),
    };

    const parsed = Answer.safeParse(candidate);
    if (!parsed.success) {
      throw fail('INTERNAL', `Stored answer for ${stored.questionCode} is not a valid answer`);
    }
    return { ...parsed.data, updatedAt: stored.updatedAt.toISOString() };
  });
}
