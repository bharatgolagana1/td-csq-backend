import { model, Schema, type Types } from 'mongoose';

import {
  CYCLE_STATUSES,
  CYCLE_TYPES,
  type CycleStatus,
  type CycleType,
  type ReminderPolicy,
  type WindowEdge,
} from './domain/types.js';

export { CYCLE_STATUSES, CYCLE_TYPES } from './domain/types.js';
export type { CycleStatus, CycleType, ReminderPolicy, WindowEdge } from './domain/types.js';

/** `{ DOMESTIC?, INTERNATIONAL? }` survey version ids pinned at publish (null = not pinned / not run). */
export interface SurveyVersionRefs {
  DOMESTIC: Types.ObjectId | null;
  INTERNATIONAL: Types.ObjectId | null;
}

export interface CycleWindowDoc {
  start: WindowEdge;
  end: WindowEdge;
}

export interface CycleDoc {
  _id: Types.ObjectId;
  name: string;
  code: string;
  type: CycleType;
  /** IANA zone the windows were entered in (`Asia/Kolkata` by default). */
  tz: string;
  sampling: CycleWindowDoc;
  assessment: CycleWindowDoc;
  minSampleSize: number;
  reminders: { sampling: ReminderPolicy; assessment: ReminderPolicy };
  participatingAirportIds: Types.ObjectId[];
  participatingAcoIds: Types.ObjectId[];
  surveyVersions: SurveyVersionRefs;
  status: CycleStatus;
  publishedAt: Date | null;
  publishedBy: Types.ObjectId | null;
  /** Set when the assessment opens: the cycle's market-share snapshot can no longer change (REQUIREMENTS §21). */
  marketShareFrozen: boolean;
  scoredAt: Date | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const edgeSchema = new Schema<WindowEdge>(
  {
    wall: { type: String, required: true },
    utc: { type: Date, required: true },
  },
  { _id: false },
);

const windowSchema = new Schema<CycleWindowDoc>(
  {
    start: { type: edgeSchema, required: true },
    end: { type: edgeSchema, required: true },
  },
  { _id: false },
);

const reminderSchema = new Schema<ReminderPolicy>(
  {
    count: { type: Number, required: true, min: 0 },
    everyDays: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const surveyVersionsSchema = new Schema<SurveyVersionRefs>(
  {
    DOMESTIC: { type: Schema.Types.ObjectId, ref: 'Survey', default: null },
    INTERNATIONAL: { type: Schema.Types.ObjectId, ref: 'Survey', default: null },
  },
  { _id: false },
);

const schema = new Schema<CycleDoc>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true, unique: true },
    type: { type: String, enum: CYCLE_TYPES, required: true },
    tz: { type: String, required: true },
    sampling: { type: windowSchema, required: true },
    assessment: { type: windowSchema, required: true },
    minSampleSize: { type: Number, required: true, min: 0 },
    reminders: {
      sampling: { type: reminderSchema, required: true },
      assessment: { type: reminderSchema, required: true },
    },
    participatingAirportIds: { type: [Schema.Types.ObjectId], ref: 'Airport', required: true, default: [] },
    participatingAcoIds: { type: [Schema.Types.ObjectId], ref: 'Organisation', required: true, default: [] },
    surveyVersions: { type: surveyVersionsSchema, required: true, default: () => ({ DOMESTIC: null, INTERNATIONAL: null }) },
    status: { type: String, enum: CYCLE_STATUSES, required: true, default: 'DRAFT' },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    marketShareFrozen: { type: Boolean, required: true, default: false },
    scoredAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'cycles', minimize: false },
);

schema.index({ status: 1 });
schema.index({ participatingAcoIds: 1, status: 1 });
schema.index({ participatingAirportIds: 1, status: 1 });
schema.index({ 'sampling.start.utc': -1 });

export const CycleModel = model<CycleDoc>('Cycle', schema);
