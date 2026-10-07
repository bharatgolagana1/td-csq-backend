import { model, Schema, type Types } from 'mongoose';

import { SURVEY_TYPES, type SurveyType } from './domain/types.js';

export const SAMPLING_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'LOCKED', 'UNLOCKED'] as const;
export type SamplingStatus = (typeof SAMPLING_STATUSES)[number];

export const SELF_ASSESSMENT_STATUSES = ['NOT_STARTED', 'DRAFT', 'SUBMITTED'] as const;
export type SelfAssessmentStatus = (typeof SELF_ASSESSMENT_STATUSES)[number];

export const PARTICIPANT_STAT_FIELDS = ['invited', 'started', 'completed'] as const;
export type ParticipantStatField = (typeof PARTICIPANT_STAT_FIELDS)[number];

export interface ParticipantSampling {
  status: SamplingStatus;
  selectedCount: number;
  lockedAt: Date | null;
  lockedBy: Types.ObjectId | null;
  unlockedAt: Date | null;
  unlockedBy: Types.ObjectId | null;
  unlockReason: string | null;
}

export interface ParticipantStats {
  invited: number;
  started: number;
  completed: number;
}

/** Per survey type the operator runs in this cycle; null for a type it does not run. */
export interface SelfAssessmentStatuses {
  DOMESTIC: SelfAssessmentStatus | null;
  INTERNATIONAL: SelfAssessmentStatus | null;
}

/** Sampling-reminder bookkeeping (the clock sends reminder k when `sent === k`). */
export interface ParticipantReminders {
  sent: number;
  lastAt: Date | null;
}

/**
 * One operator's participation in one cycle (ARCHITECTURE §5 `cycle_participants`).
 * Created at publish; sampling writes `sampling`, invitations / assessments
 * feed `stats` and `selfAssessment` through cycles' exported functions and events.
 */
export interface CycleParticipantDoc {
  _id: Types.ObjectId;
  cycleId: Types.ObjectId;
  acoId: Types.ObjectId;
  airportId: Types.ObjectId;
  surveyTypes: SurveyType[];
  requiredSampleSize: number;
  sampling: ParticipantSampling;
  stats: ParticipantStats;
  selfAssessment: SelfAssessmentStatuses;
  reminders: ParticipantReminders;
  createdAt: Date;
  updatedAt: Date;
}

const samplingSchema = new Schema<ParticipantSampling>(
  {
    status: { type: String, enum: SAMPLING_STATUSES, required: true, default: 'NOT_STARTED' },
    selectedCount: { type: Number, required: true, default: 0, min: 0 },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    unlockedAt: { type: Date, default: null },
    unlockedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    unlockReason: { type: String, default: null },
  },
  { _id: false },
);

const statsSchema = new Schema<ParticipantStats>(
  {
    invited: { type: Number, required: true, default: 0, min: 0 },
    started: { type: Number, required: true, default: 0, min: 0 },
    completed: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const selfAssessmentSchema = new Schema<SelfAssessmentStatuses>(
  {
    DOMESTIC: { type: String, enum: [...SELF_ASSESSMENT_STATUSES, null], default: null },
    INTERNATIONAL: { type: String, enum: [...SELF_ASSESSMENT_STATUSES, null], default: null },
  },
  { _id: false },
);

const remindersSchema = new Schema<ParticipantReminders>(
  {
    sent: { type: Number, required: true, default: 0, min: 0 },
    lastAt: { type: Date, default: null },
  },
  { _id: false },
);

const schema = new Schema<CycleParticipantDoc>(
  {
    cycleId: { type: Schema.Types.ObjectId, ref: 'Cycle', required: true },
    acoId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    airportId: { type: Schema.Types.ObjectId, ref: 'Airport', required: true },
    surveyTypes: { type: [String], enum: SURVEY_TYPES, required: true },
    requiredSampleSize: { type: Number, required: true, min: 0 },
    sampling: { type: samplingSchema, required: true, default: () => ({}) },
    stats: { type: statsSchema, required: true, default: () => ({}) },
    selfAssessment: { type: selfAssessmentSchema, required: true, default: () => ({ DOMESTIC: null, INTERNATIONAL: null }) },
    reminders: { type: remindersSchema, required: true, default: () => ({}) },
  },
  { timestamps: true, collection: 'cycle_participants', minimize: false },
);

schema.index({ cycleId: 1, acoId: 1 }, { unique: true });
schema.index({ acoId: 1 });
schema.index({ cycleId: 1, airportId: 1 });

export const CycleParticipantModel = model<CycleParticipantDoc>('CycleParticipant', schema);
