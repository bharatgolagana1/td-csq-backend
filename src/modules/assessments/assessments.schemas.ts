import { z } from 'zod';

import { idSchema } from '../../core/ids.js';
import { listQuerySchema } from '../../core/pagination.js';

import { COMMENT_MODES, SURVEY_STATUSES } from './assessments.form.js';
import { ASSESSMENT_KINDS, ASSESSMENT_STATUSES, CUSTOMER_TYPES, SURVEY_TYPES } from './assessments.model.js';

export const ratingSchema = z.number().int().min(1).max(5);

export const progressResponse = z.object({
  answered: z.number(),
  total: z.number(),
  pct: z.number(),
});
export type ProgressDto = z.infer<typeof progressResponse>;

export const answerResponse = z.object({
  questionId: z.string(),
  rating: ratingSchema.nullable(),
  na: z.boolean(),
  comment: z.string().nullable(),
  followUp: z.array(z.string()),
});
export type AnswerDto = z.infer<typeof answerResponse>;

/** What every path returns about an assessment (no answers, no identity). */
export const assessmentResponse = z.object({
  id: z.string(),
  cycleId: z.string(),
  acoId: z.string(),
  airportId: z.string(),
  surveyId: z.string(),
  surveyType: z.enum(SURVEY_TYPES),
  kind: z.enum(ASSESSMENT_KINDS),
  customerType: z.enum(CUSTOMER_TYPES).nullable(),
  invitationId: z.string().nullable(),
  userId: z.string().nullable(),
  status: z.enum(ASSESSMENT_STATUSES),
  progress: progressResponse,
  startedAt: z.string(),
  lastSavedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
});
export type AssessmentDto = z.infer<typeof assessmentResponse>;

// --- form and draft ---------------------------------------------------------
// The surveys module's stakeholder form, served unchanged (its `formResponse`),
// wrapped with the assessment and its progress.

export const formQuestionResponse = z.object({
  id: z.string(),
  categoryId: z.string(),
  subcategoryId: z.string().nullable(),
  code: z.string(),
  text: z.string(),
  help: z.string().nullable(),
  order: z.number(),
  weightPct: z.number().nullable(),
  mandatory: z.boolean(),
  commentMode: z.enum(COMMENT_MODES),
  followUp: z.object({ prompt: z.string(), options: z.array(z.string()) }).nullable(),
});

export const formSubcategoryResponse = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  order: z.number(),
  questions: z.array(formQuestionResponse),
});

export const formCategoryResponse = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  order: z.number(),
  weightPct: z.number().nullable(),
  /** Questions directly under the category (no subcategory). */
  questions: z.array(formQuestionResponse),
  subcategories: z.array(formSubcategoryResponse),
});

export const formSurveyResponse = z.object({
  id: z.string(),
  code: z.enum(SURVEY_TYPES),
  name: z.string(),
  version: z.number(),
  status: z.enum(SURVEY_STATUSES),
});

export const scaleStepResponse = z.object({ value: z.number(), label: z.string() });

/** `GET …/form`: the survey form for the assessment's stakeholder type (every active question for SELF) plus progress. */
export const assessmentFormResponse = z.object({
  assessment: assessmentResponse,
  survey: formSurveyResponse,
  /** The stakeholder type the questions were filtered for; null on a self-assessment. */
  stakeholderType: z.enum(CUSTOMER_TYPES).nullable(),
  /** The rating scale every question uses; NA is always offered alongside. */
  scale: z.array(scaleStepResponse),
  /** Active questions on this form — the denominator of the progress figure. */
  questionCount: z.number(),
  categories: z.array(formCategoryResponse),
  progress: progressResponse,
});
export type AssessmentFormDto = z.infer<typeof assessmentFormResponse>;

/** `GET …/draft`: the answers saved so far. */
export const draftResponse = z.object({
  id: z.string(),
  status: z.enum(ASSESSMENT_STATUSES),
  answers: z.array(answerResponse),
  progress: progressResponse,
  lastSavedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
});
export type DraftDto = z.infer<typeof draftResponse>;

export const answerInputSchema = z
  .object({
    questionId: z.string().trim().min(1).max(64),
    rating: ratingSchema.nullable().optional(),
    na: z.boolean().optional(),
    comment: z.string().trim().max(2000).nullable().optional(),
    followUp: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  })
  .strict();

/** `PATCH …/answers` body: a merge by question; each entry replaces the stored answer for its question. */
export const patchAnswersBody = z.object({ answers: z.array(answerInputSchema).max(500) }).strict();
export type PatchAnswersInput = z.infer<typeof patchAnswersBody>;

export const patchAnswersResponse = progressResponse.extend({ lastSavedAt: z.string().nullable() });
export type PatchAnswersResult = z.infer<typeof patchAnswersResponse>;

export const readinessResponse = z.object({
  answered: z.number(),
  total: z.number(),
  missing: z.array(z.string()),
  complete: z.boolean(),
});
export type ReadinessDto = z.infer<typeof readinessResponse>;

// --- self assessment --------------------------------------------------------

export const selfParams = z.object({ cycleId: idSchema, surveyType: z.enum(SURVEY_TYPES) });
export type SelfParams = z.infer<typeof selfParams>;

/** `GET /assessments/self/:cycleId/:surveyType`: the form and the saved answers in one payload. */
export const selfAssessmentResponse = assessmentFormResponse.extend({ answers: z.array(answerResponse) });
export type SelfAssessmentDto = z.infer<typeof selfAssessmentResponse>;

// --- signed-in history ------------------------------------------------------

const cycleSummary = z.object({ id: z.string(), code: z.string(), name: z.string() });
const operatorSummary = z.object({ id: z.string(), code: z.string(), name: z.string() });

/** Who answered; masked for ACO users unless `settings.revealAssessorIdentity` (SELF rows are never masked). */
const assessorResponse = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  revealed: z.boolean(),
});

export const historyRowResponse = z.object({
  id: z.string(),
  cycle: cycleSummary,
  operator: operatorSummary,
  kind: z.enum(ASSESSMENT_KINDS),
  surveyType: z.enum(SURVEY_TYPES),
  customerType: z.enum(CUSTOMER_TYPES).nullable(),
  customerId: z.string().nullable(),
  assessorName: z.string().nullable(),
  assessorEmailMasked: z.string().nullable(),
  assessor: assessorResponse,
  status: z.enum(ASSESSMENT_STATUSES),
  progress: progressResponse,
  startedAt: z.string(),
  submittedAt: z.string().nullable(),
  /** The assessment's own NA-excluding mean rating, 1 dp; null until something is rated. */
  score: z.number().nullable(),
});
export type HistoryRowDto = z.infer<typeof historyRowResponse>;

export const assessmentListQuery = listQuerySchema.extend({
  cycleId: idSchema.optional(),
  acoId: idSchema.optional(),
  kind: z.enum(ASSESSMENT_KINDS).optional(),
  status: z.enum(ASSESSMENT_STATUSES).optional(),
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  surveyType: z.enum(SURVEY_TYPES).optional(),
});
export type AssessmentListQuery = z.infer<typeof assessmentListQuery>;

export const detailAnswerResponse = answerResponse.extend({
  code: z.string(),
  text: z.string(),
  category: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  subcategory: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
});

/** `GET /assessments/:id`: the read-only return, every form question with its answer. */
export const assessmentDetailResponse = historyRowResponse.extend({
  survey: formSurveyResponse,
  answers: z.array(detailAnswerResponse),
});
export type AssessmentDetailDto = z.infer<typeof assessmentDetailResponse>;

export const exportQuery = z.object({
  cycleId: idSchema,
  acoId: idSchema.optional(),
  kind: z.enum(ASSESSMENT_KINDS).optional(),
  status: z.enum(ASSESSMENT_STATUSES).optional(),
});
export type ExportQuery = z.infer<typeof exportQuery>;

export const assessmentParams = z.object({ id: idSchema });
