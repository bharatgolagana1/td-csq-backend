import { z } from 'zod';

import { idSchema } from '../../core/ids.js';
import { listQuerySchema } from '../../core/pagination.js';

import { SAMPLING_STATUSES, SELF_ASSESSMENT_STATUSES } from './cycle-participants.model.js';
import { CYCLE_STATUSES, CYCLE_TYPES, SURVEY_TYPES } from './domain/types.js';
import { isCalendarDate, isValidTimeZone, isWallClock } from './domain/windows.js';

// --- building blocks -------------------------------------------------------

export const cycleCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,29}$/, 'must be 2-30 characters: letters, digits, _ or -');

export const wallClockSchema = z.string().trim().refine(isWallClock, 'must be YYYY-MM-DDTHH:mm');
export const calendarDateSchema = z.string().trim().refine(isCalendarDate, 'must be YYYY-MM-DD');
export const timeZoneSchema = z.string().trim().min(1).refine(isValidTimeZone, 'must be an IANA time zone such as Asia/Kolkata');

export const windowInput = z.object({ start: wallClockSchema, end: wallClockSchema }).strict();
export type WindowInput = z.infer<typeof windowInput>;

/** A patch may move one edge only (after publishing, only `end`). */
export const windowPatch = z.object({ start: wallClockSchema.optional(), end: wallClockSchema.optional() }).strict();
export type WindowPatch = z.infer<typeof windowPatch>;

export const reminderPolicySchema = z
  .object({ count: z.number().int().min(0).max(50), everyDays: z.number().int().min(1).max(60) })
  .strict();
export const remindersSchema = z.object({ sampling: reminderPolicySchema, assessment: reminderPolicySchema }).strict();
export type RemindersInput = z.infer<typeof remindersSchema>;

export const surveyVersionsInput = z
  .object({ DOMESTIC: idSchema.nullable().optional(), INTERNATIONAL: idSchema.nullable().optional() })
  .strict();
export type SurveyVersionsInput = z.infer<typeof surveyVersionsInput>;

const uniqueIds = z.array(idSchema).max(2000).transform((ids) => [...new Set(ids)]);

// --- responses -------------------------------------------------------------

export const windowEdgeResponse = z.object({ wall: z.string(), utc: z.string() });
export const windowResponse = z.object({ start: windowEdgeResponse, end: windowEdgeResponse });
export type WindowDto = z.infer<typeof windowResponse>;

export const surveyVersionsResponse = z.object({ DOMESTIC: z.string().nullable(), INTERNATIONAL: z.string().nullable() });

export const cycleSummaryResponse = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  type: z.enum(CYCLE_TYPES),
  status: z.enum(CYCLE_STATUSES),
  tz: z.string(),
  sampling: windowResponse,
  assessment: windowResponse,
  minSampleSize: z.number(),
  participants: z.object({ airports: z.number(), operators: z.number() }),
  /** Over the participants the caller may see (PLATFORM all, ACO its own, AIRPORT its airport's). */
  progress: z.object({ locked: z.number(), invited: z.number(), completed: z.number() }),
  publishedAt: z.string().nullable(),
  scoredAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CycleSummaryDto = z.infer<typeof cycleSummaryResponse>;

export const participantResponse = z.object({
  id: z.string(),
  cycleId: z.string(),
  acoId: z.string(),
  airportId: z.string(),
  operator: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  airport: z.object({ id: z.string(), iata: z.string(), name: z.string() }),
  surveyTypes: z.array(z.enum(SURVEY_TYPES)),
  requiredSampleSize: z.number(),
  sampling: z.object({
    status: z.enum(SAMPLING_STATUSES),
    selectedCount: z.number(),
    lockedAt: z.string().nullable(),
    lockedBy: z.string().nullable(),
    unlockedAt: z.string().nullable(),
    unlockedBy: z.string().nullable(),
    unlockReason: z.string().nullable(),
  }),
  stats: z.object({ invited: z.number(), started: z.number(), completed: z.number() }),
  selfAssessment: z.object({
    DOMESTIC: z.enum(SELF_ASSESSMENT_STATUSES).nullable(),
    INTERNATIONAL: z.enum(SELF_ASSESSMENT_STATUSES).nullable(),
  }),
  reminders: z.object({ sent: z.number(), lastAt: z.string().nullable() }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ParticipantDto = z.infer<typeof participantResponse>;

export const cycleDetailResponse = cycleSummaryResponse.extend({
  reminders: remindersSchema,
  participatingAirportIds: z.array(z.string()),
  participatingAcoIds: z.array(z.string()),
  surveyVersions: surveyVersionsResponse,
  marketShareFrozen: z.boolean(),
  publishedBy: z.string().nullable(),
  createdBy: z.string().nullable(),
  participantList: z.array(participantResponse),
});
export type CycleDetailDto = z.infer<typeof cycleDetailResponse>;

export const DEADLINE_KINDS = ['SAMPLING_OPENS', 'SAMPLING_CLOSES', 'ASSESSMENT_OPENS', 'ASSESSMENT_CLOSES'] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

/** `GET /cycles/current`: the cycle strip for one operator. */
export const currentCycleResponse = z.object({
  cycle: cycleSummaryResponse,
  participant: participantResponse,
  nextDeadline: z.object({ kind: z.enum(DEADLINE_KINDS), at: z.string() }).nullable(),
});
export type CurrentCycleDto = z.infer<typeof currentCycleResponse>;

export const monitoringResponse = z.object({
  cycleId: z.string(),
  status: z.enum(CYCLE_STATUSES),
  sampling: z.object({
    airports: z.number(),
    operators: z.number(),
    sampleRequired: z.number(),
    sampleLocked: z.number(),
    lockedOperators: z.number(),
  }),
  assessment: z.object({
    invited: z.number(),
    started: z.number(),
    completed: z.number(),
    pending: z.number(),
    /** Percentage 0–100, one decimal; 0 when nobody has been invited. */
    completionRate: z.number(),
  }),
  byAirport: z.array(
    z.object({
      airportId: z.string(),
      iata: z.string(),
      name: z.string(),
      operators: z.array(
        z.object({
          acoId: z.string(),
          code: z.string(),
          name: z.string(),
          sampling: z.object({ status: z.enum(SAMPLING_STATUSES), selectedCount: z.number(), required: z.number() }),
          invited: z.number(),
          started: z.number(),
          completed: z.number(),
        }),
      ),
    }),
  ),
});
export type MonitoringDto = z.infer<typeof monitoringResponse>;

export const reminderRunResponse = z.object({
  kind: z.enum(['SAMPLING', 'ASSESSMENT']),
  sent: z.number(),
  recipients: z.array(z.object({ acoId: z.string(), to: z.array(z.string()) })),
});
export type ReminderRunDto = z.infer<typeof reminderRunResponse>;

// --- requests --------------------------------------------------------------

export const cycleListQuery = listQuerySchema.extend({
  status: z.enum(CYCLE_STATUSES).optional(),
  type: z.enum(CYCLE_TYPES).optional(),
  airportId: idSchema.optional(),
  acoId: idSchema.optional(),
});
export type CycleListQuery = z.infer<typeof cycleListQuery>;

export const createCycleBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    code: cycleCodeSchema,
    type: z.enum(CYCLE_TYPES),
    tz: timeZoneSchema.optional(),
    /** With `sampling`/`assessment` omitted, the windows are derived from `settings.defaults`. */
    initiationDate: calendarDateSchema.optional(),
    sampling: windowInput.optional(),
    assessment: windowInput.optional(),
    minSampleSize: z.number().int().min(0).max(100000),
    reminders: remindersSchema.optional(),
    participatingAirportIds: uniqueIds.default([]),
    participatingAcoIds: uniqueIds.default([]),
    surveyVersions: surveyVersionsInput.optional(),
  })
  .strict();
export type CreateCycleInput = z.infer<typeof createCycleBody>;

export const patchCycleBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    code: cycleCodeSchema,
    type: z.enum(CYCLE_TYPES),
    tz: timeZoneSchema,
    initiationDate: calendarDateSchema,
    sampling: windowPatch,
    assessment: windowPatch,
    minSampleSize: z.number().int().min(0).max(100000),
    reminders: remindersSchema,
    participatingAirportIds: uniqueIds,
    participatingAcoIds: uniqueIds,
    surveyVersions: surveyVersionsInput,
  })
  .partial()
  .strict();
export type PatchCycleInput = z.infer<typeof patchCycleBody>;

export const MANUAL_TARGETS = ['SAMPLING_OPEN', 'SAMPLING_CLOSED', 'ASSESSMENT_OPEN', 'ASSESSMENT_CLOSED', 'SCORED', 'ARCHIVED'] as const;

export const transitionBody = z
  .object({
    to: z.enum(MANUAL_TARGETS),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type TransitionInput = z.infer<typeof transitionBody>;

export const participantListQuery = listQuerySchema.extend({
  airportId: idSchema.optional(),
  samplingStatus: z.enum(SAMPLING_STATUSES).optional(),
});
export type ParticipantListQuery = z.infer<typeof participantListQuery>;

export const sendRemindersBody = z
  .object({
    kind: z.enum(['SAMPLING', 'ASSESSMENT']),
    acoId: idSchema.optional(),
  })
  .strict();
export type SendRemindersInput = z.infer<typeof sendRemindersBody>;

export const currentCycleQuery = z.object({ acoId: idSchema.optional() });
export type CurrentCycleQuery = z.infer<typeof currentCycleQuery>;
