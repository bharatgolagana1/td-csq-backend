import { z } from 'zod';

import { idSchema } from '../../core/ids.js';

import { COMMENT_MODES, STAKEHOLDER_TYPES } from './questions.model.js';
import { SURVEY_STATUSES, SURVEY_TYPES } from './surveys.model.js';

/** Category, subcategory and question codes: `ACFI.INFRA.CARGO_STORAGE_CAPACITY`, `INFRA`, … */
export const nodeCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._-]{0,79}$/, 'must be 1-80 characters: letters, digits, dot, _ or -');

const nameSchema = z.string().trim().min(1).max(200);
const orderSchema = z.number().int().min(0).max(100_000);
const weightSchema = z.number().min(0).max(100);

export const followUpSchema = z
  .object({
    prompt: z.string().trim().min(1).max(300),
    options: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  })
  .strict();
export type FollowUpInput = z.infer<typeof followUpSchema>;

const stakeholderTypesSchema = z
  .array(z.enum(STAKEHOLDER_TYPES))
  .min(1)
  .refine((types) => new Set(types).size === types.length, 'must not repeat a stakeholder type');

// --- responses -------------------------------------------------------------

export const surveyResponse = z.object({
  id: z.string(),
  code: z.enum(SURVEY_TYPES),
  name: z.string(),
  version: z.number(),
  status: z.enum(SURVEY_STATUSES),
  publishedAt: z.string().nullable(),
  publishedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SurveyDto = z.infer<typeof surveyResponse>;

export const surveyVersionResponse = surveyResponse.extend({ questionCount: z.number() });
export type SurveyVersionDto = z.infer<typeof surveyVersionResponse>;

/** `GET /surveys`: one entry per survey type, versions newest first. */
export const surveyListResponse = z.array(
  z.object({
    code: z.enum(SURVEY_TYPES),
    name: z.string(),
    publishedVersionId: z.string().nullable(),
    draftVersionId: z.string().nullable(),
    versions: z.array(surveyVersionResponse),
  }),
);
export type SurveyListDto = z.infer<typeof surveyListResponse>;

export const questionResponse = z.object({
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
  stakeholderTypes: z.array(z.enum(STAKEHOLDER_TYPES)),
  followUp: followUpSchema.nullable(),
  active: z.boolean(),
});
export type QuestionDto = z.infer<typeof questionResponse>;

export const subcategoryNodeResponse = z.object({
  id: z.string(),
  categoryId: z.string(),
  code: z.string(),
  name: z.string(),
  order: z.number(),
});
export type SubcategoryNodeDto = z.infer<typeof subcategoryNodeResponse>;

export const categoryNodeResponse = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  order: z.number(),
  weightPct: z.number().nullable(),
});
export type CategoryNodeDto = z.infer<typeof categoryNodeResponse>;

export const subcategoryResponse = subcategoryNodeResponse.extend({ questions: z.array(questionResponse) });
export type SubcategoryDto = z.infer<typeof subcategoryResponse>;

export const categoryResponse = categoryNodeResponse.extend({
  subcategories: z.array(subcategoryResponse),
  /** Questions directly under the category (no subcategory). */
  questions: z.array(questionResponse),
});
export type CategoryDto = z.infer<typeof categoryResponse>;

export const issueResponse = z.object({ path: z.string(), message: z.string() });
export type Issue = z.infer<typeof issueResponse>;

/** `GET /surveys/:id`: the whole version; `issues` is what would stop a DRAFT from publishing (empty otherwise). */
export const surveyTreeResponse = z.object({
  survey: surveyResponse,
  categories: z.array(categoryResponse),
  issues: z.array(issueResponse),
});
export type SurveyTreeDto = z.infer<typeof surveyTreeResponse>;

// The form, as an assessor of one stakeholder type sees it: active questions
// only, ordered, empty groups dropped. Assessments and the public participant
// flow serve this shape unchanged.

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
  followUp: followUpSchema.nullable(),
});
export type FormQuestionDto = z.infer<typeof formQuestionResponse>;

export const formSubcategoryResponse = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  order: z.number(),
  questions: z.array(formQuestionResponse),
});
export type FormSubcategoryDto = z.infer<typeof formSubcategoryResponse>;

export const formCategoryResponse = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  order: z.number(),
  weightPct: z.number().nullable(),
  questions: z.array(formQuestionResponse),
  subcategories: z.array(formSubcategoryResponse),
});
export type FormCategoryDto = z.infer<typeof formCategoryResponse>;

export const formResponse = z.object({
  survey: z.object({
    id: z.string(),
    code: z.enum(SURVEY_TYPES),
    name: z.string(),
    version: z.number(),
    status: z.enum(SURVEY_STATUSES),
  }),
  stakeholderType: z.enum(STAKEHOLDER_TYPES),
  /** The rating scale every question uses; NA is always offered alongside. */
  scale: z.array(z.object({ value: z.number(), label: z.string() })),
  /** Active questions for this stakeholder type — the denominator of the progress figure. */
  questionCount: z.number(),
  categories: z.array(formCategoryResponse),
});
export type FormDto = z.infer<typeof formResponse>;

// --- requests --------------------------------------------------------------

/** `:id` is a survey version id, or a survey type code to start the first version of a type. */
export const surveyRefParams = z.object({ id: z.union([idSchema, z.enum(SURVEY_TYPES)]) });
export const surveyParams = z.object({ id: idSchema });
export const categoryParams = surveyParams.extend({ catId: idSchema });
export const subcategoryParams = surveyParams.extend({ subId: idSchema });
export const questionParams = surveyParams.extend({ qId: idSchema });

export const createVersionBody = z.object({ name: nameSchema.optional() }).strict();
export type CreateVersionInput = z.infer<typeof createVersionBody>;

export const createCategoryBody = z
  .object({
    code: nodeCodeSchema,
    name: nameSchema,
    /** Defaults to last + 1. */
    order: orderSchema.optional(),
    weightPct: weightSchema.nullable().optional(),
  })
  .strict();
export type CreateCategoryInput = z.infer<typeof createCategoryBody>;

export const patchCategoryBody = z
  .object({
    code: nodeCodeSchema,
    name: nameSchema,
    order: orderSchema,
    weightPct: weightSchema.nullable(),
  })
  .partial()
  .strict();
export type PatchCategoryInput = z.infer<typeof patchCategoryBody>;

export const createSubcategoryBody = z
  .object({
    categoryId: idSchema,
    code: nodeCodeSchema,
    name: nameSchema,
    order: orderSchema.optional(),
  })
  .strict();
export type CreateSubcategoryInput = z.infer<typeof createSubcategoryBody>;

export const patchSubcategoryBody = z
  .object({
    categoryId: idSchema,
    code: nodeCodeSchema,
    name: nameSchema,
    order: orderSchema,
  })
  .partial()
  .strict();
export type PatchSubcategoryInput = z.infer<typeof patchSubcategoryBody>;

const questionFields = {
  code: nodeCodeSchema,
  text: z.string().trim().min(1).max(2000),
  help: z.string().trim().max(2000).nullable(),
  order: orderSchema,
  weightPct: weightSchema.nullable(),
  mandatory: z.boolean(),
  commentMode: z.enum(COMMENT_MODES),
  stakeholderTypes: stakeholderTypesSchema,
  followUp: followUpSchema.nullable(),
  active: z.boolean(),
};

export const createQuestionBody = z
  .object({
    categoryId: idSchema,
    subcategoryId: idSchema.nullable().optional(),
    code: questionFields.code,
    text: questionFields.text,
    help: questionFields.help.optional(),
    order: questionFields.order.optional(),
    weightPct: questionFields.weightPct.optional(),
    mandatory: questionFields.mandatory.default(true),
    commentMode: questionFields.commentMode.default('OPTIONAL'),
    stakeholderTypes: stakeholderTypesSchema.default([...STAKEHOLDER_TYPES]),
    followUp: questionFields.followUp.optional(),
    active: questionFields.active.default(true),
  })
  .strict();
export type CreateQuestionInput = z.infer<typeof createQuestionBody>;

export const patchQuestionBody = z
  .object({
    categoryId: idSchema,
    subcategoryId: idSchema.nullable(),
    ...questionFields,
  })
  .partial()
  .strict();
export type PatchQuestionInput = z.infer<typeof patchQuestionBody>;

const orderEntry = z.object({ id: idSchema, order: orderSchema }).strict();

/** `PUT /surveys/:id/order`: nodes not listed keep their order; every listed node must sit where it is listed. */
export const orderBody = z
  .object({
    categories: z
      .array(
        z
          .object({
            id: idSchema,
            order: orderSchema,
            questions: z.array(orderEntry).optional(),
            subcategories: z
              .array(z.object({ id: idSchema, order: orderSchema, questions: z.array(orderEntry).optional() }).strict())
              .optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type OrderInput = z.infer<typeof orderBody>;

export const previewQuery = z.object({ stakeholderType: z.enum(STAKEHOLDER_TYPES) });
