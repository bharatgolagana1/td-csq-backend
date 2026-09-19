import { Schema } from 'mongoose';
import type { FormScope } from '@csq/contracts';
import { newId } from '../../kernel/ids.js';
import { defineTenantModel, type TenantFields } from '../../kernel/tenancy.js';
import {
  CYCLE_STATES,
  PARTICIPATION_SAMPLING_STATES,
  PARTICIPATION_SCORING_STATES,
  PARTICIPATION_STATES,
  REMINDER_AUDIENCES,
  SCHEDULED_TASK_KINDS,
  SCHEDULED_TASK_STATES,
  type CycleState,
  type ParticipationSamplingState,
  type ParticipationScoringState,
  type ParticipationState,
  type ReminderAudience,
  type ScheduledTaskKind,
  type ScheduledTaskState,
} from './cycles.contracts.js';
import { FREEZE_FIELDS, type CycleTransition, type FreezeField } from './cycles.state.js';

/**
 * Five collections: programs, cycles, participations, scheduled tasks and the
 * reminder dispatch log.
 *
 * Read the cycle schema for what is deliberately absent. There is no unique
 * index on the program, no singleton guard and no pre-save hook asserting that
 * a program has at most one cycle. The prototype carried exactly that hook, and
 * it made a second cycle impossible to create for the life of the product: a
 * programme is by definition repeated, cycles of different programmes overlap,
 * and a re-run after a cancelled quarter is normal operations. The only
 * uniqueness here is the human-readable code, which exists so two
 * administrators cannot name the same thing twice.
 */

/**
 * The wall time typed, the zone it was typed in, and the instant those two
 * resolve to. Stored together because each one alone loses something: the
 * instant alone loses the intent, and the wall time alone loses the answer.
 */
export interface StoredBoundary {
  wall: string;
  tz: string;
  utc: Date;
}

const BoundarySchema = new Schema<StoredBoundary>(
  {
    wall: { type: String, required: true },
    tz: { type: String, required: true },
    // the only field any arithmetic or index ever touches
    utc: { type: Date, required: true },
  },
  { _id: false },
);

export interface StoredWindows {
  samplingOpens: StoredBoundary;
  samplingCloses: StoredBoundary;
  assessmentOpens: StoredBoundary;
  assessmentCloses: StoredBoundary;
}

export interface ProgramDoc {
  _id: string;
  code: string;
  /** Case folded, so two administrators cannot create the same code twice. */
  codeKey: string;
  name: string;
  description: string | null;
  formScope: FormScope;
  defaultTimezone: string;
  defaultMinimumSamplingSize: number;
  status: 'ACTIVE' | 'ARCHIVED';
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ProgramModel = defineTenantModel<ProgramDoc>({
  name: 'CycleProgram',
  definition: {
    code: { type: String, required: true },
    codeKey: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    formScope: { type: String, enum: ['INTERNATIONAL', 'DOMESTIC'], required: true },
    defaultTimezone: { type: String, required: true },
    defaultMinimumSamplingSize: { type: Number, required: true },
    status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], required: true, default: 'ACTIVE' },
    archivedAt: { type: Date, default: null },
  },
  configure: (schema: Schema<ProgramDoc & TenantFields>) => {
    // unlike a settings list, archiving does not free the code: cycles and
    // published ratings refer to a programme by it, and two different programmes
    // sharing one code in the historical record is not a tidy-up, it is a defect
    schema.index({ orgId: 1, codeKey: 1 }, { unique: true });
    schema.index({ orgId: 1, status: 1, code: 1 });
  },
});

export interface ReminderDoc {
  _id: string;
  label: string;
  audience: ReminderAudience;
  at: StoredBoundary;
}

const ReminderSchema = new Schema<ReminderDoc>(
  {
    _id: { type: String, default: newId },
    label: { type: String, required: true },
    audience: { type: String, enum: [...REMINDER_AUDIENCES], required: true },
    at: { type: BoundarySchema, required: true },
  },
  { _id: false },
);

export interface TransitionLogEntry {
  at: Date;
  name: CycleTransition;
  from: CycleState;
  to: CycleState;
  /** Null when the scheduled-task driver took the edge. */
  actorUserId: string | null;
  automatic: boolean;
}

const TransitionLogSchema = new Schema<TransitionLogEntry>(
  {
    at: { type: Date, required: true },
    name: { type: String, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    actorUserId: { type: String, default: null },
    automatic: { type: Boolean, required: true },
  },
  { _id: false },
);

export type CycleFreezes = Record<FreezeField, Date | null>;

export interface CycleDoc {
  _id: string;
  programId: string;
  code: string;
  codeKey: string;
  name: string;
  state: CycleState;
  /** Copied from the programme at creation so a later programme edit cannot move it. */
  formScope: FormScope;
  minimumSamplingSize: number;
  windows: StoredWindows;
  reminders: ReminderDoc[];
  freezes: CycleFreezes;
  transitions: TransitionLogEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const freezeDefinition: Record<string, unknown> = {};
for (const field of FREEZE_FIELDS) freezeDefinition[field] = { type: Date, default: null };

export const CycleModel = defineTenantModel<CycleDoc>({
  name: 'Cycle',
  definition: {
    programId: { type: String, required: true },
    code: { type: String, required: true },
    codeKey: { type: String, required: true },
    name: { type: String, required: true },
    state: { type: String, enum: [...CYCLE_STATES], required: true, default: 'DRAFT' },
    formScope: { type: String, enum: ['INTERNATIONAL', 'DOMESTIC'], required: true },
    minimumSamplingSize: { type: Number, required: true },
    windows: {
      samplingOpens: { type: BoundarySchema, required: true },
      samplingCloses: { type: BoundarySchema, required: true },
      assessmentOpens: { type: BoundarySchema, required: true },
      assessmentCloses: { type: BoundarySchema, required: true },
    },
    reminders: { type: [ReminderSchema], default: [] },
    freezes: freezeDefinition,
    transitions: { type: [TransitionLogSchema], default: [] },
  },
  configure: (schema: Schema<CycleDoc & TenantFields>) => {
    schema.index({ orgId: 1, programId: 1, codeKey: 1 }, { unique: true });
    schema.index({ orgId: 1, state: 1, 'windows.samplingOpens.utc': 1 });
    schema.index({ orgId: 1, programId: 1, 'windows.assessmentCloses.utc': -1 });
  },
});

export interface ParticipationDoc {
  _id: string;
  cycleId: string;
  /** The assessed operator, which is a different organisation from the cycle owner. */
  acoOrgId: string;
  airportId: string | null;
  formScope: FormScope;
  state: ParticipationState;
  sampling: {
    state: ParticipationSamplingState;
    /** Snapshotted at join, so editing the cycle cannot move an operator's bar mid-flight. */
    minimumSamplingSize: number;
    lockedAt: Date | null;
    lockedCount: number | null;
    eligibleCountAtLock: number | null;
    shortfall: number | null;
  };
  progress: {
    selfSubmittedAt: Date | null;
    externalSubmittedAt: Date | null;
    customerInvited: number;
    customerSubmitted: number;
  };
  scoring: {
    state: ParticipationScoringState;
    scoredAt: Date | null;
    suppression: string | null;
  };
  invitedAt: Date;
  activatedAt: Date | null;
  withdrawnAt: Date | null;
  withdrawnReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ParticipationModel = defineTenantModel<ParticipationDoc>({
  name: 'CycleParticipation',
  definition: {
    cycleId: { type: String, required: true },
    acoOrgId: { type: String, required: true },
    airportId: { type: String, default: null },
    formScope: { type: String, enum: ['INTERNATIONAL', 'DOMESTIC'], required: true },
    state: { type: String, enum: [...PARTICIPATION_STATES], required: true, default: 'INVITED' },
    sampling: {
      state: {
        type: String,
        enum: [...PARTICIPATION_SAMPLING_STATES],
        required: true,
        default: 'NOT_STARTED',
      },
      minimumSamplingSize: { type: Number, required: true },
      lockedAt: { type: Date, default: null },
      lockedCount: { type: Number, default: null },
      eligibleCountAtLock: { type: Number, default: null },
      shortfall: { type: Number, default: null },
    },
    progress: {
      selfSubmittedAt: { type: Date, default: null },
      externalSubmittedAt: { type: Date, default: null },
      customerInvited: { type: Number, required: true, default: 0 },
      customerSubmitted: { type: Number, required: true, default: 0 },
    },
    scoring: {
      state: {
        type: String,
        enum: [...PARTICIPATION_SCORING_STATES],
        required: true,
        default: 'NOT_SCORED',
      },
      scoredAt: { type: Date, default: null },
      suppression: { type: String, default: null },
    },
    invitedAt: { type: Date, required: true },
    activatedAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },
    withdrawnReason: { type: String, default: null },
  },
  configure: (schema: Schema<ParticipationDoc & TenantFields>) => {
    // one row per operator per cycle. Nothing here limits how many cycles an
    // operator may be in at once, because overlapping cycles are ordinary
    schema.index({ orgId: 1, cycleId: 1, acoOrgId: 1 }, { unique: true });
    schema.index({ orgId: 1, cycleId: 1, state: 1 });
    schema.index({ orgId: 1, acoOrgId: 1 });
  },
});

export interface ScheduledTaskDoc {
  _id: string;
  kind: ScheduledTaskKind;
  cycleId: string;
  reminderId: string | null;
  transition: CycleTransition | null;
  runAt: Date;
  state: ScheduledTaskState;
  /**
   * Natural key for the piece of work. Unique per organisation, so a restart, a
   * retry or a second instance re-creating the same task is a duplicate-key
   * error rather than a second send.
   */
  dedupeKey: string;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  result: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ScheduledTaskModel = defineTenantModel<ScheduledTaskDoc>({
  name: 'CycleScheduledTask',
  definition: {
    kind: { type: String, enum: [...SCHEDULED_TASK_KINDS], required: true },
    cycleId: { type: String, required: true },
    reminderId: { type: String, default: null },
    transition: { type: String, default: null },
    runAt: { type: Date, required: true },
    state: { type: String, enum: [...SCHEDULED_TASK_STATES], required: true, default: 'PENDING' },
    dedupeKey: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true, default: 5 },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    result: { type: String, default: null },
  },
  configure: (schema: Schema<ScheduledTaskDoc & TenantFields>) => {
    schema.index({ orgId: 1, dedupeKey: 1 }, { unique: true });
    // deliberately not prefixed by orgId: the drain runs in system scope across
    // every tenant, and an orgId-first index could not serve that sort
    schema.index({ state: 1, runAt: 1 });
    schema.index({ orgId: 1, cycleId: 1, runAt: 1 });
  },
});

export interface ReminderDispatchDoc {
  _id: string;
  cycleId: string;
  reminderId: string;
  participationId: string;
  acoOrgId: string;
  audience: ReminderAudience;
  /** What was still outstanding at send time. The reason the row exists. */
  reason: string;
  dueAt: Date;
  resolvedAt: Date;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ReminderDispatchModel = defineTenantModel<ReminderDispatchDoc>({
  name: 'CycleReminderDispatch',
  definition: {
    cycleId: { type: String, required: true },
    reminderId: { type: String, required: true },
    participationId: { type: String, required: true },
    acoOrgId: { type: String, required: true },
    audience: { type: String, enum: [...REMINDER_AUDIENCES], required: true },
    reason: { type: String, required: true },
    dueAt: { type: Date, required: true },
    resolvedAt: { type: Date, required: true },
    sentAt: { type: Date, default: null },
  },
  configure: (schema: Schema<ReminderDispatchDoc & TenantFields>) => {
    // the second half of the no-double-send guarantee. The lease stops two
    // workers running one task; this stops one recipient being written twice if
    // a task is retried after a partial failure
    schema.index({ orgId: 1, reminderId: 1, participationId: 1 }, { unique: true });
    schema.index({ orgId: 1, cycleId: 1, resolvedAt: -1 });
  },
});
