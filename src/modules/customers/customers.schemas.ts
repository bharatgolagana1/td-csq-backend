import { z } from 'zod';

import { idSchema } from '../../core/ids.js';
import { listQuerySchema } from '../../core/pagination.js';
import { SURVEY_TYPES } from '../cycles/domain/types.js';

import { IMPORT_STATUSES } from './customer-imports.model.js';
import { CUSTOMER_STATUSES, CUSTOMER_SURVEY_TYPES, CUSTOMER_TYPES } from './customers.model.js';
import {
  normaliseContactPerson,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  normaliseTags,
  TAG_MAX_LENGTH,
  TAGS_MAX_COUNT,
  type Normalised,
} from './domain/normalise.js';

/** A string field cleaned by one of the domain normalisers; its message becomes the zod issue. */
function normalised<T>(normalise: (raw: string) => Normalised<T>): z.ZodType<T, string> {
  return z.string().max(1_000).transform((raw, ctx): T => {
    const result = normalise(raw);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.message });
      return z.NEVER;
    }
    return result.value;
  });
}

/** Tags arrive as an array on the wire; the domain rule (trim, de-duplicate, limits) is the CSV one. */
const tagsSchema = z
  .array(z.string().max(TAG_MAX_LENGTH * 2))
  .max(TAGS_MAX_COUNT * 2)
  .transform((tags, ctx): string[] => {
    const result = normaliseTags(tags.join(';'));
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.message });
      return z.NEVER;
    }
    return result.value;
  });

export const customerResponse = z.object({
  id: z.string(),
  acoId: z.string(),
  airportId: z.string(),
  name: z.string(),
  contactPerson: z.string(),
  email: z.string(),
  phone: z.string(),
  type: z.enum(CUSTOMER_TYPES),
  surveyType: z.enum(CUSTOMER_SURVEY_TYPES),
  status: z.enum(CUSTOMER_STATUSES),
  tags: z.array(z.string()),
  lastSampledCycleId: z.string().nullable(),
  importBatchId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomerDto = z.infer<typeof customerResponse>;

export const customerListQuery = listQuerySchema.extend({
  /** PLATFORM only: one operator's directory. */
  acoId: idSchema.optional(),
  type: z.enum(CUSTOMER_TYPES).optional(),
  surveyType: z.enum(CUSTOMER_SURVEY_TYPES).optional(),
  status: z.enum(CUSTOMER_STATUSES).optional(),
  tag: z.string().trim().min(1).max(TAG_MAX_LENGTH).optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuery>;

/** `?acoId=` on the import routes: PLATFORM names the operator; ACO users may omit it. */
export const acoScopeQuery = z.object({ acoId: idSchema.optional() });

/** `GET /customers/eligible?cycleId=`: the sampling page's expanded entries, paginated server-side. */
export const eligibleQuery = listQuerySchema.pick({ page: true, pageSize: true, q: true }).extend({
  cycleId: idSchema,
  /** PLATFORM only: the operator whose entries to expand. */
  acoId: idSchema.optional(),
  surveyType: z.enum(SURVEY_TYPES).optional(),
  type: z.enum(CUSTOMER_TYPES).optional(),
});
export type EligibleQuery = z.infer<typeof eligibleQuery>;

/** One sampleable (customer, surveyType) pair, as the sampling domain expands it. */
export const eligibleEntryResponse = z.object({
  customer: customerResponse,
  surveyType: z.enum(SURVEY_TYPES),
  /** `${customerId}:${surveyType}` — the identity of a sample within the participant. */
  key: z.string(),
});
export type EligibleEntryDto = z.infer<typeof eligibleEntryResponse>;

export const createCustomerBody = z
  .object({
    /** Required for PLATFORM users; an ACO user may only name its own organisation. */
    acoId: idSchema.optional(),
    name: normalised(normaliseName),
    /** Empty or omitted → the organisation name stands in, as on import. */
    contactPerson: normalised(normaliseContactPerson).optional(),
    email: normalised(normaliseEmail),
    phone: normalised(normalisePhone),
    type: z.enum(CUSTOMER_TYPES),
    surveyType: z.enum(CUSTOMER_SURVEY_TYPES),
    tags: tagsSchema.optional(),
  })
  .strict();
export type CreateCustomerInput = z.infer<typeof createCustomerBody>;

export const patchCustomerBody = z
  .object({
    name: normalised(normaliseName),
    contactPerson: normalised(normaliseContactPerson),
    email: normalised(normaliseEmail),
    phone: normalised(normalisePhone),
    type: z.enum(CUSTOMER_TYPES),
    surveyType: z.enum(CUSTOMER_SURVEY_TYPES),
    tags: tagsSchema,
  })
  .partial()
  .strict();
export type PatchCustomerInput = z.infer<typeof patchCustomerBody>;

// --- import ----------------------------------------------------------------

export const importValidateQuery = acoScopeQuery.extend({
  /** Name recorded on the import when the CSV comes as a text/csv body rather than a file. */
  fileName: z.string().trim().min(1).max(200).optional(),
});
export type ImportValidateQuery = z.infer<typeof importValidateQuery>;

export const importParams = z.object({ importId: idSchema });

const importErrorSchema = z.object({ row: z.number(), field: z.string(), message: z.string() });

export const importValidationResponse = z.object({
  importId: z.string(),
  acoId: z.string(),
  fileName: z.string(),
  status: z.enum(IMPORT_STATUSES),
  rows: z.number(),
  accepted: z.number(),
  rejected: z.number(),
  errors: z.array(importErrorSchema),
  preview: z.array(
    z.object({
      row: z.number(),
      action: z.enum(['CREATE', 'UPDATE', 'REJECT']),
      data: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
      errors: z.array(importErrorSchema),
    }),
  ),
  headers: z.object({
    matched: z.record(z.string(), z.string()),
    ignored: z.array(z.string()),
    missing: z.array(z.string()),
  }),
});
export type ImportValidationDto = z.infer<typeof importValidationResponse>;

export const importCommitResponse = z.object({
  importId: z.string(),
  acoId: z.string(),
  fileName: z.string(),
  status: z.enum(IMPORT_STATUSES),
  rows: z.number(),
  accepted: z.number(),
  rejected: z.number(),
  created: z.number(),
  updated: z.number(),
  committedAt: z.string().nullable(),
});
export type ImportCommitDto = z.infer<typeof importCommitResponse>;
