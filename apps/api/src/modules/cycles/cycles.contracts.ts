import { z } from 'zod';
import { FormScope, Ulid } from '@csq/contracts';

/**
 * Wire shapes for programs, cycles and participations.
 *
 * Every boundary an administrator types is carried as a wall time plus the zone
 * it was typed in. The resolved instant is derived, never submitted: a client
 * that sends its own UTC has already decided the answer, and the one thing this
 * module cannot afford is a cycle that opens an hour early because a browser or
 * a server moved region.
 */

/** Local date and time with optional seconds. Calendar validity is checked on resolution. */
const WALL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export const BoundaryInput = z
  .object({
    wall: z.string().regex(WALL_RE, 'must be a local date and time, e.g. 2026-04-12T00:00'),
    // a regex cannot know whether a zone exists, so the zone is checked against
    // the platform tz database when the boundary is resolved
    tz: z.string().min(3).max(64),
  })
  .strict();
export type BoundaryInput = z.infer<typeof BoundaryInput>;

export const BoundaryView = z.object({ wall: z.string(), tz: z.string(), utc: z.string() });
export type BoundaryView = z.infer<typeof BoundaryView>;

export const WINDOW_BOUNDARIES = [
  'samplingOpens',
  'samplingCloses',
  'assessmentOpens',
  'assessmentCloses',
] as const;
export type WindowBoundaryName = (typeof WINDOW_BOUNDARIES)[number];

export const WindowsInput = z
  .object({
    samplingOpens: BoundaryInput,
    samplingCloses: BoundaryInput,
    assessmentOpens: BoundaryInput,
    assessmentCloses: BoundaryInput,
  })
  .strict();
export type WindowsInput = z.infer<typeof WindowsInput>;

export const WindowsView = z.object({
  samplingOpens: BoundaryView,
  samplingCloses: BoundaryView,
  assessmentOpens: BoundaryView,
  assessmentCloses: BoundaryView,
});
export type WindowsView = z.infer<typeof WindowsView>;

/**
 * Who a reminder is aimed at. It is not a recipient list: the recipients are
 * resolved at send time against whoever has not yet done the thing, so a
 * reminder needs no cancellation path when somebody submits early.
 */
export const REMINDER_AUDIENCES = ['SAMPLING', 'SELF', 'CUSTOMER', 'EXTERNAL'] as const;
export const ReminderAudience = z.enum(REMINDER_AUDIENCES);
export type ReminderAudience = z.infer<typeof ReminderAudience>;

export const ReminderInput = z
  .object({
    label: z.string().min(1).max(80),
    audience: ReminderAudience,
    at: BoundaryInput,
  })
  .strict();
export type ReminderInput = z.infer<typeof ReminderInput>;

/**
 * Reminders are replaced as a set rather than patched one at a time, for the
 * same reason a curated list is reordered as a whole: a partial write over a
 * collection forces the server to invent what the client did not mention.
 */
export const RemindersInput = z.object({ reminders: z.array(ReminderInput).max(12) }).strict();

export const ReminderView = z.object({
  id: Ulid,
  label: z.string(),
  audience: ReminderAudience,
  at: BoundaryView,
});
export type ReminderView = z.infer<typeof ReminderView>;

const Code = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, dot, dash and underscore only');

export const CreateProgram = z
  .object({
    code: Code,
    name: z.string().min(1).max(160),
    description: z.string().max(2000).nullable().default(null),
    formScope: FormScope,
    /** The zone an administrator's cycle dates default to being read in. */
    defaultTimezone: z.string().min(3).max(64),
    defaultMinimumSamplingSize: z.number().int().min(1).max(10_000),
  })
  .strict();
export type CreateProgram = z.infer<typeof CreateProgram>;

export const UpdateProgram = z
  .object({
    name: z.string().min(1).max(160).optional(),
    description: z.string().max(2000).nullable().optional(),
    defaultTimezone: z.string().min(3).max(64).optional(),
    defaultMinimumSamplingSize: z.number().int().min(1).max(10_000).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export type UpdateProgram = z.infer<typeof UpdateProgram>;

export const ProgramView = z.object({
  id: Ulid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  formScope: FormScope,
  defaultTimezone: z.string(),
  defaultMinimumSamplingSize: z.number().int(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  cycleCount: z.number().int().min(0),
});
export type ProgramView = z.infer<typeof ProgramView>;

export const CreateCycle = z
  .object({
    programId: Ulid,
    code: Code,
    name: z.string().min(1).max(160),
    windows: WindowsInput,
    /** Null takes the program default. An override may be larger or smaller. */
    minimumSamplingSize: z.number().int().min(1).max(10_000).nullable().default(null),
    reminders: z.array(ReminderInput).max(12).default([]),
  })
  .strict();
export type CreateCycle = z.infer<typeof CreateCycle>;

export const UpdateCycle = z
  .object({
    name: z.string().min(1).max(160).optional(),
    minimumSamplingSize: z.number().int().min(1).max(10_000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change');
export type UpdateCycle = z.infer<typeof UpdateCycle>;

export const CYCLE_STATES = [
  'DRAFT',
  'SCHEDULED',
  'SAMPLING_OPEN',
  'ASSESSMENT_OPEN',
  'CLOSED',
  'SCORED',
  'PUBLISHED',
] as const;
export const CycleState = z.enum(CYCLE_STATES);
export type CycleState = z.infer<typeof CycleState>;

export const CycleListQuery = z
  .object({
    programId: Ulid.optional(),
    state: CycleState.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type CycleListQuery = z.infer<typeof CycleListQuery>;

export const CycleView = z.object({
  id: Ulid,
  programId: Ulid,
  code: z.string(),
  name: z.string(),
  state: CycleState,
  formScope: FormScope,
  minimumSamplingSize: z.number().int(),
  windows: WindowsView,
  reminders: z.array(ReminderView),
  /**
   * Derived from the window predicates at read time, never stored. The state is
   * a coarse label; these two booleans are the authoritative answer to whether
   * work may be done, and they are deliberately independent because the
   * assessment window may open while sampling is still open.
   */
  samplingOpen: z.boolean(),
  assessmentOpen: z.boolean(),
  nextTransition: z.object({ name: z.string(), at: z.string() }).nullable(),
  freezes: z.object({
    configurationFrozenAt: z.string().nullable(),
    rosterRemovalFrozenAt: z.string().nullable(),
    instrumentFrozenAt: z.string().nullable(),
    submissionsFrozenAt: z.string().nullable(),
    scoresFrozenAt: z.string().nullable(),
    publishedAt: z.string().nullable(),
  }),
  participationCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CycleView = z.infer<typeof CycleView>;

export const CycleIdParam = z.object({ cycleId: Ulid });
export const ProgramIdParam = z.object({ programId: Ulid });
export const ParticipationParams = z.object({ cycleId: Ulid, participationId: Ulid });

export const PARTICIPATION_STATES = ['INVITED', 'ACTIVE', 'WITHDRAWN'] as const;
export const ParticipationState = z.enum(PARTICIPATION_STATES);
export type ParticipationState = z.infer<typeof ParticipationState>;

export const PARTICIPATION_SAMPLING_STATES = ['NOT_STARTED', 'IN_PROGRESS', 'LOCKED', 'WAIVED'] as const;
export const ParticipationSamplingState = z.enum(PARTICIPATION_SAMPLING_STATES);
export type ParticipationSamplingState = z.infer<typeof ParticipationSamplingState>;

export const PARTICIPATION_SCORING_STATES = ['NOT_SCORED', 'SCORED', 'SUPPRESSED'] as const;
export const ParticipationScoringState = z.enum(PARTICIPATION_SCORING_STATES);
export type ParticipationScoringState = z.infer<typeof ParticipationScoringState>;

export const CreateParticipation = z
  .object({
    /** The assessed operator. A separate organisation from the one running the cycle. */
    acoOrgId: Ulid,
    airportId: Ulid.nullable().default(null),
    /** Null takes the cycle minimum. Snapshotted, so a later cycle edit cannot move the bar. */
    minimumSamplingSize: z.number().int().min(1).max(10_000).nullable().default(null),
  })
  .strict();
export type CreateParticipation = z.infer<typeof CreateParticipation>;

export const WithdrawParticipation = z
  .object({ reason: z.string().min(3).max(500) })
  .strict();

export const ParticipationListQuery = z
  .object({
    state: ParticipationState.optional(),
    samplingState: ParticipationSamplingState.optional(),
  })
  .strict();
export type ParticipationListQuery = z.infer<typeof ParticipationListQuery>;

export const ParticipationView = z.object({
  id: Ulid,
  cycleId: Ulid,
  acoOrgId: Ulid,
  airportId: Ulid.nullable(),
  formScope: FormScope,
  state: ParticipationState,
  sampling: z.object({
    state: ParticipationSamplingState,
    minimumSamplingSize: z.number().int(),
    lockedAt: z.string().nullable(),
    lockedCount: z.number().int().min(0).nullable(),
    eligibleCountAtLock: z.number().int().min(0).nullable(),
    /** How far below the minimum a forced full-directory lock landed. */
    shortfall: z.number().int().min(0).nullable(),
  }),
  progress: z.object({
    selfSubmittedAt: z.string().nullable(),
    externalSubmittedAt: z.string().nullable(),
    customerInvited: z.number().int().min(0),
    customerSubmitted: z.number().int().min(0),
  }),
  scoring: z.object({
    state: ParticipationScoringState,
    scoredAt: z.string().nullable(),
    suppression: z.string().nullable(),
  }),
  invitedAt: z.string(),
  withdrawnAt: z.string().nullable(),
  withdrawnReason: z.string().nullable(),
});
export type ParticipationView = z.infer<typeof ParticipationView>;

export const SCHEDULED_TASK_KINDS = ['CYCLE_ADVANCE', 'CYCLE_REMINDER'] as const;
export const ScheduledTaskKind = z.enum(SCHEDULED_TASK_KINDS);
export type ScheduledTaskKind = z.infer<typeof ScheduledTaskKind>;

export const SCHEDULED_TASK_STATES = ['PENDING', 'RUNNING', 'DONE', 'DEAD'] as const;
export const ScheduledTaskState = z.enum(SCHEDULED_TASK_STATES);
export type ScheduledTaskState = z.infer<typeof ScheduledTaskState>;

export const ScheduledTaskView = z.object({
  id: Ulid,
  kind: ScheduledTaskKind,
  cycleId: Ulid,
  state: ScheduledTaskState,
  runAt: z.string(),
  attempts: z.number().int().min(0),
  leaseExpiresAt: z.string().nullable(),
  lastError: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type ScheduledTaskView = z.infer<typeof ScheduledTaskView>;
