import { z } from 'zod';

import { idSchema } from '../../core/ids.js';
import { auditListQuery } from '../audit/audit.schemas.js';

import { SAMPLE_STATES } from './sampling.model.js';

export const surveyTypeSchema = z.enum(['DOMESTIC', 'INTERNATIONAL']);
export const cycleTypeSchema = z.enum(['DOMESTIC', 'INTERNATIONAL', 'BOTH']);

const CYCLE_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'SAMPLING_OPEN',
  'SAMPLING_CLOSED',
  'ASSESSMENT_OPEN',
  'ASSESSMENT_CLOSED',
  'SCORED',
  'ARCHIVED',
] as const;

export const PARTICIPANT_SAMPLING_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'LOCKED', 'UNLOCKED'] as const;
export type ParticipantSamplingStatus = (typeof PARTICIPANT_SAMPLING_STATUSES)[number];

// --- requests ----------------------------------------------------------------

export const cycleParams = z.object({ cycleId: idSchema });
export const customerParams = z.object({ id: idSchema });

/** PLATFORM users name the operator; ACO users act for their own organisation. */
export const acoQuery = z.object({ acoId: idSchema.optional() });
export const acoBody = z.object({ acoId: idSchema.optional() }).strict();

export const selectionItemSchema = z.object({ customerId: idSchema, surveyType: surveyTypeSchema }).strict();
export type SelectionItemInput = z.infer<typeof selectionItemSchema>;

export const selectionBody = z
  .object({
    acoId: idSchema.optional(),
    add: z.array(selectionItemSchema).max(2000).default([]),
    remove: z.array(selectionItemSchema).max(2000).default([]),
  })
  .strict();
export type SelectionInput = z.infer<typeof selectionBody>;

/** Unlock is PLATFORM only, so the operator is always named explicitly. */
export const unlockBody = z
  .object({
    acoId: idSchema,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type UnlockInput = z.infer<typeof unlockBody>;

/** The `/audit` filters minus the three the route fixes (entity, entityId, orgId), plus the operator. */
export const samplingAuditQuery = auditListQuery.omit({ entity: true, entityId: true, orgId: true }).extend({ acoId: idSchema.optional() });
export type SamplingAuditQuery = z.infer<typeof samplingAuditQuery>;

// --- responses ---------------------------------------------------------------

export const customerSummary = z.object({
  id: z.string(),
  name: z.string(),
  contactPerson: z.string(),
  email: z.string(),
  phone: z.string(),
  type: z.enum(['FF', 'CB']),
  surveyType: cycleTypeSchema,
  status: z.enum(['ACTIVE', 'INACTIVE']),
});
export type CustomerSummaryDto = z.infer<typeof customerSummary>;

export const cycleSummary = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  type: cycleTypeSchema,
  status: z.enum(CYCLE_STATUSES),
  samplingStart: z.string().nullable(),
  samplingEnd: z.string().nullable(),
});
export type CycleSummaryDto = z.infer<typeof cycleSummary>;

/** Who locked / unlocked, resolved through identity; `lockedBy` / `unlockedBy` keep the bare ids. */
export const userRef = z.object({ id: z.string(), name: z.string() });
export type UserRefDto = z.infer<typeof userRef>;

export const participantSummary = z.object({
  cycleId: z.string(),
  acoId: z.string(),
  airportId: z.string().nullable(),
  surveyTypes: z.array(surveyTypeSchema),
  requiredSampleSize: z.number(),
  sampling: z.object({
    status: z.enum(PARTICIPANT_SAMPLING_STATUSES),
    selectedCount: z.number(),
    lockedAt: z.string().nullable(),
    lockedBy: z.string().nullable(),
    lockedByUser: userRef.nullable(),
    unlockedAt: z.string().nullable(),
    unlockedBy: z.string().nullable(),
    unlockedByUser: userRef.nullable(),
    unlockReason: z.string().nullable(),
  }),
});
export type ParticipantSummaryDto = z.infer<typeof participantSummary>;

export const selectionRow = z.object({
  id: z.string(),
  customerId: z.string(),
  /** Null only when the customer record has vanished; the row still counts. */
  customer: customerSummary.nullable(),
  surveyType: surveyTypeSchema,
  state: z.enum(SAMPLE_STATES),
  addedAt: z.string(),
  addedBy: z.string().nullable(),
});
export type SelectionRowDto = z.infer<typeof selectionRow>;

/** `GET /sampling/cycles/:cycleId` — the whole sampling screen in one payload. */
export const selectionStateResponse = z.object({
  cycle: cycleSummary,
  participant: participantSummary,
  required: z.number(),
  selectedCount: z.number(),
  eligibleCount: z.number(),
  /** True when pressing "lock" now would succeed; `reason` says why not otherwise. */
  lockable: z.boolean(),
  reason: z.enum(['BELOW_MINIMUM', 'SELECT_ALL_REQUIRED', 'NOTHING_SELECTED', 'ALREADY_LOCKED', 'SAMPLING_CLOSED']).nullable(),
  shortfallRule: z.enum(['SELECT_ALL']).nullable(),
  remaining: z.number(),
  target: z.number(),
  /** "37 / 50" */
  progress: z.string(),
  progressPct: z.number(),
  /** True while the operator may change the selection (sampling open, not locked). */
  editable: z.boolean(),
  selection: z.array(selectionRow),
});
export type SelectionStateDto = z.infer<typeof selectionStateResponse>;

export const rejectedItem = selectionItemSchema.extend({
  op: z.enum(['add', 'remove']),
  reason: z.enum([
    'UNKNOWN_CUSTOMER',
    'INACTIVE_CUSTOMER',
    'WRONG_SURVEY_TYPE',
    'ALREADY_SELECTED',
    'NOT_SELECTED',
    'DUPLICATE_IN_REQUEST',
    'CONFLICTING',
  ]),
  message: z.string(),
});

export const selectionChangeResponse = z.object({
  added: z.array(selectionItemSchema),
  removed: z.array(selectionItemSchema),
  rejected: z.array(rejectedItem),
  state: selectionStateResponse,
});
export type SelectionChangeDto = z.infer<typeof selectionChangeResponse>;

export const participationRow = z.object({
  cycleId: z.string(),
  /** Null when the cycle is no longer visible to the caller. */
  cycle: cycleSummary.omit({ samplingStart: true, samplingEnd: true }).nullable(),
  surveyType: surveyTypeSchema,
  state: z.enum(SAMPLE_STATES),
  addedAt: z.string(),
  /** Null until the assessments module is registered (see README). */
  submitted: z.boolean().nullable(),
});

/** `GET /customers/:id/participation` */
export const participationResponse = z.object({
  customer: customerSummary,
  cycles: z.array(participationRow),
});
export type ParticipationDto = z.infer<typeof participationResponse>;
