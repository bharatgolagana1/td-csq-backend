// The form an assessor fills in and the rules its answers obey
// (ARCHITECTURE §5 `questions`, §7 "Form rules"). Pure: no IO.
//
// The form is the surveys module's stakeholder form served unchanged
// (`survey`, `stakeholderType`, `scale`, `questionCount`, `categories`); a
// self-assessment builds the same shape from the survey tree with every
// active question. Questions sit directly under a category or under one of
// its subcategories; display order is the category's direct questions, then
// its subcategories, each by `order`.
import type { SurveyType } from '../../core/events.js';

import { RATINGS, type CustomerType, type Rating, type StoredAnswer } from './assessments.model.js';

export const COMMENT_MODES = ['OPTIONAL', 'REQUIRED', 'REQUIRED_ON_LOW', 'NONE'] as const;
export type CommentMode = (typeof COMMENT_MODES)[number];

export const SURVEY_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];

/** Fair (2) and Poor (1) are the "low" ratings that ask for a comment / follow-up. */
export const LOW_RATING_MAX = 2;

export interface ScaleStep {
  value: number;
  label: string;
}

/** Poor = 1 … Excellent = 5 (ARCHITECTURE §7 "Scoring"); NA is offered alongside every question. */
export const RATING_SCALE: readonly ScaleStep[] = [
  { value: 1, label: 'Poor' },
  { value: 2, label: 'Fair' },
  { value: 3, label: 'Good' },
  { value: 4, label: 'Very Good' },
  { value: 5, label: 'Excellent' },
];

export interface FormFollowUp {
  prompt: string;
  options: string[];
}

export interface FormQuestion {
  id: string;
  categoryId: string;
  subcategoryId: string | null;
  code: string;
  text: string;
  help: string | null;
  order: number;
  weightPct: number | null;
  mandatory: boolean;
  commentMode: CommentMode;
  followUp: FormFollowUp | null;
}

export interface FormSubcategory {
  id: string;
  code: string;
  name: string;
  order: number;
  questions: FormQuestion[];
}

export interface FormCategory {
  id: string;
  code: string;
  name: string;
  order: number;
  weightPct: number | null;
  /** Questions directly under the category (no subcategory). */
  questions: FormQuestion[];
  subcategories: FormSubcategory[];
}

export interface FormSurvey {
  id: string;
  code: SurveyType;
  name: string;
  version: number;
  status: SurveyStatus;
}

/** Exactly what the web form renders. */
export interface AssessmentForm {
  survey: FormSurvey;
  /** The stakeholder type the questions were filtered for; null on a self-assessment (every active question). */
  stakeholderType: CustomerType | null;
  scale: ScaleStep[];
  questionCount: number;
  categories: FormCategory[];
}

// --- from the surveys module ------------------------------------------------

/** The fields the form needs from a question of the surveys module's tree or stakeholder form. */
export interface TreeQuestionLike {
  id: string;
  categoryId: string;
  subcategoryId: string | null;
  code: string;
  text: string;
  help: string | null;
  order: number;
  weightPct: number | null;
  mandatory: boolean;
  commentMode: CommentMode;
  followUp: { prompt: string; options: readonly string[] } | null;
  /** Absent on a stakeholder form, which carries active questions only. */
  active?: boolean;
}

export interface TreeSubcategoryLike {
  id: string;
  code: string;
  name: string;
  order: number;
  questions: readonly TreeQuestionLike[];
}

export interface TreeCategoryLike {
  id: string;
  code: string;
  name: string;
  order: number;
  weightPct: number | null;
  questions: readonly TreeQuestionLike[];
  subcategories: readonly TreeSubcategoryLike[];
}

export interface SurveyTreeLike {
  survey: FormSurvey;
  categories: readonly TreeCategoryLike[];
}

export interface StakeholderFormLike extends SurveyTreeLike {
  stakeholderType: CustomerType;
  scale: readonly ScaleStep[];
}

function byOrder<T extends { order: number }>(a: T, b: T): number {
  return a.order - b.order;
}

function toFormQuestion(question: TreeQuestionLike): FormQuestion {
  return {
    id: question.id,
    categoryId: question.categoryId,
    subcategoryId: question.subcategoryId,
    code: question.code,
    text: question.text,
    help: question.help,
    order: question.order,
    weightPct: question.weightPct,
    mandatory: question.mandatory,
    commentMode: question.commentMode,
    followUp: question.followUp ? { prompt: question.followUp.prompt, options: [...question.followUp.options] } : null,
  };
}

/** Active questions in order; sections left without questions are dropped so the assessor never sees an empty heading. */
function toFormCategories(categories: readonly TreeCategoryLike[]): FormCategory[] {
  const questions = (list: readonly TreeQuestionLike[]): FormQuestion[] =>
    [...list]
      .filter((question) => question.active !== false)
      .sort(byOrder)
      .map(toFormQuestion);
  return [...categories]
    .sort(byOrder)
    .map((category) => ({
      id: category.id,
      code: category.code,
      name: category.name,
      order: category.order,
      weightPct: category.weightPct,
      questions: questions(category.questions),
      subcategories: [...category.subcategories]
        .sort(byOrder)
        .map((sub) => ({ id: sub.id, code: sub.code, name: sub.name, order: sub.order, questions: questions(sub.questions) }))
        .filter((sub) => sub.questions.length > 0),
    }))
    .filter((category) => category.questions.length > 0 || category.subcategories.length > 0);
}

function toFormSurvey(survey: FormSurvey): FormSurvey {
  return { id: survey.id, code: survey.code, name: survey.name, version: survey.version, status: survey.status };
}

function countQuestions(categories: readonly FormCategory[]): number {
  return categories.reduce((sum, category) => sum + category.questions.length + category.subcategories.reduce((inner, sub) => inner + sub.questions.length, 0), 0);
}

/** The surveys module's stakeholder form (`getFormForStakeholder`), served unchanged. */
export function formFromStakeholderForm(form: StakeholderFormLike): AssessmentForm {
  const categories = toFormCategories(form.categories);
  return {
    survey: toFormSurvey(form.survey),
    stakeholderType: form.stakeholderType,
    scale: form.scale.map((step) => ({ value: step.value, label: step.label })),
    questionCount: countQuestions(categories),
    categories,
  };
}

/** The self-assessment form: every active question of the survey version (`getSurveyTree`), in the same shape. */
export function formFromTree(tree: SurveyTreeLike): AssessmentForm {
  const categories = toFormCategories(tree.categories);
  return {
    survey: toFormSurvey(tree.survey),
    stakeholderType: null,
    scale: RATING_SCALE.map((step) => ({ ...step })),
    questionCount: countQuestions(categories),
    categories,
  };
}

/** Every question of the form in display order (a category's direct questions, then its subcategories). */
export function formQuestions(form: AssessmentForm): FormQuestion[] {
  return formQuestionPlaces(form).map((place) => place.question);
}

export interface FormQuestionPlace {
  question: FormQuestion;
  category: FormCategory;
  subcategory: FormSubcategory | null;
}

/** Every question with the section it sits in, in display order. */
export function formQuestionPlaces(form: AssessmentForm): FormQuestionPlace[] {
  return form.categories.flatMap((category) => [
    ...category.questions.map((question) => ({ question, category, subcategory: null })),
    ...category.subcategories.flatMap((subcategory) => subcategory.questions.map((question) => ({ question, category, subcategory }))),
  ]);
}

// --- answers ----------------------------------------------------------------

/** One entry of a merge PATCH; it replaces the stored answer for its question. */
export interface AnswerInput {
  questionId: string;
  rating?: number | null | undefined;
  na?: boolean | undefined;
  comment?: string | null | undefined;
  followUp?: string[] | undefined;
}

export interface AnswerIssue {
  path: string;
  message: string;
}

export type AnswerValidation = { ok: true; answers: StoredAnswer[] } | { ok: false; issues: AnswerIssue[] };

export function isLowRating(rating: Rating | null): boolean {
  return rating !== null && rating <= LOW_RATING_MAX;
}

function isRating(value: number): value is Rating {
  return (RATINGS as readonly number[]).includes(value);
}

function validateOne(question: FormQuestion, input: AnswerInput, path: string): { answer: StoredAnswer } | { issues: AnswerIssue[] } {
  const issues: AnswerIssue[] = [];
  const na = input.na ?? false;
  const rawRating = input.rating ?? null;
  const comment = input.comment?.trim() ? input.comment.trim() : null;
  const followUp = input.followUp ?? [];

  // An out-of-range rating is one problem, not also a missing one.
  const rating: Rating | null = rawRating !== null && isRating(rawRating) ? rawRating : null;
  if (rawRating !== null && rating === null) issues.push({ path: `${path}.rating`, message: 'must be a whole number from 1 to 5' });
  else if (rating === null && !na) issues.push({ path: `${path}.rating`, message: 'needs a rating from 1 to 5 or NA' });
  if (rating !== null && na) issues.push({ path: `${path}.na`, message: 'a rating and NA are exclusive' });

  const needsComment =
    question.commentMode === 'REQUIRED' || (question.commentMode === 'REQUIRED_ON_LOW' && isLowRating(rating));
  if (needsComment && comment === null) {
    const why = question.commentMode === 'REQUIRED' ? 'this question' : 'a Fair or Poor rating';
    issues.push({ path: `${path}.comment`, message: `a comment is required for ${why}` });
  }
  if (question.commentMode === 'NONE' && comment !== null) {
    issues.push({ path: `${path}.comment`, message: 'this question takes no comment' });
  }

  if (followUp.length > 0) {
    if (question.followUp === null) {
      issues.push({ path: `${path}.followUp`, message: 'this question has no follow-up options' });
    } else {
      if (!isLowRating(rating)) issues.push({ path: `${path}.followUp`, message: 'follow-up options apply to a Fair or Poor rating only' });
      const listed = new Set(question.followUp.options);
      const seen = new Set<string>();
      followUp.forEach((option, index) => {
        if (!listed.has(option)) issues.push({ path: `${path}.followUp.${index}`, message: `"${option}" is not one of the listed options` });
        if (seen.has(option)) issues.push({ path: `${path}.followUp.${index}`, message: `"${option}" is listed twice` });
        seen.add(option);
      });
    }
  }

  if (issues.length > 0) return { issues };
  return { answer: { questionId: question.id, rating, na, comment, followUp: [...followUp] } };
}

/**
 * Validates a batch of answers against the form (§7 "Form rules"): the
 * question must be on the form, exactly one of rating / NA, a comment where
 * the comment mode demands it (and none where it forbids it), follow-up
 * options only on Fair / Poor and only from the question's list.
 */
export function validateAnswers(form: AssessmentForm, inputs: readonly AnswerInput[]): AnswerValidation {
  const byId = new Map(formQuestions(form).map((question) => [question.id, question]));
  const issues: AnswerIssue[] = [];
  const answers: StoredAnswer[] = [];
  const seen = new Set<string>();
  inputs.forEach((input, index) => {
    const path = `answers.${index}`;
    const question = byId.get(input.questionId);
    if (!question) {
      issues.push({ path: `${path}.questionId`, message: `question ${input.questionId} is not on this form` });
      return;
    }
    if (seen.has(input.questionId)) {
      issues.push({ path: `${path}.questionId`, message: `question ${input.questionId} appears twice in this batch` });
      return;
    }
    seen.add(input.questionId);
    const result = validateOne(question, input, path);
    if ('issues' in result) issues.push(...result.issues);
    else answers.push(result.answer);
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, answers };
}

/** Merge by question: an incoming answer replaces the stored one for the same question; the rest stay. */
export function mergeAnswers(existing: readonly StoredAnswer[], incoming: readonly StoredAnswer[]): StoredAnswer[] {
  const merged = new Map(existing.map((answer) => [answer.questionId, answer]));
  for (const answer of incoming) merged.set(answer.questionId, answer);
  return [...merged.values()];
}

export function isAnswered(answer: StoredAnswer): boolean {
  return answer.rating !== null || answer.na;
}

export interface Readiness {
  answered: number;
  total: number;
  /** Question ids still unanswered, in form order. */
  missing: string[];
  complete: boolean;
}

/** Progress against the form: every active question must be answered (rating or NA). */
export function readinessOf(form: AssessmentForm, answers: readonly StoredAnswer[]): Readiness {
  const answered = new Set(answers.filter(isAnswered).map((answer) => answer.questionId));
  const questions = formQuestions(form);
  const missing = questions.filter((question) => !answered.has(question.id)).map((question) => question.id);
  return { answered: questions.length - missing.length, total: questions.length, missing, complete: missing.length === 0 };
}

export interface Progress {
  answered: number;
  total: number;
  /** Whole percent, 0 when the form has no questions. */
  pct: number;
}

export function progressOf(answered: number, total: number): Progress {
  return { answered, total, pct: total === 0 ? 0 : Math.round((answered / total) * 100) };
}

/** The assessment's own NA-excluding mean rating, 1 dp; null when nothing is rated. */
export function ownScore(answers: readonly StoredAnswer[]): number | null {
  const ratings = answers.flatMap((answer) => (answer.rating === null ? [] : [answer.rating]));
  if (ratings.length === 0) return null;
  const mean = ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
  return Number(`${Math.round(Number(`${mean}e1`))}e-1`);
}
