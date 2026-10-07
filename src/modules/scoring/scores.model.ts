import { model, Schema, type Types } from 'mongoose';

import type { SurveyType } from '../../core/events.js';

import type { DistributionBucket, ScoreLevel, SuppressionReason } from './engine/index.js';

export const SCORE_LEVELS = ['QUESTION', 'SUBCATEGORY', 'CATEGORY', 'OVERALL'] as const satisfies readonly ScoreLevel[];
export const SURVEY_TYPES = ['DOMESTIC', 'INTERNATIONAL'] as const satisfies readonly SurveyType[];

export interface MeanWithNDoc {
  mean: number | null;
  n: number;
}

export interface CustomerFiguresDoc extends MeanWithNDoc {
  naCount: number;
  byType: { FF: MeanWithNDoc; CB: MeanWithNDoc };
}

/** How many SUBMITTED assessments fed one operator's figures for one survey type. */
export interface ResponseCounts {
  customer: number;
  self: number;
  FF: number;
  CB: number;
}

/**
 * One `scores` document (ARCHITECTURE §5): one operator, one survey type, one
 * level and ref of the pinned survey. `refId` is the node's stable CODE
 * (question / subcategory / category code, or `OVERALL`), not its version id,
 * so a previous cycle on an older survey version still lines up row by row.
 * `rank` / `rankOf`, the feedback `distribution` and the response `counts`
 * are carried by the OVERALL row only; every row records whether the run was
 * `provisional` (assessment still open) and when it was computed.
 */
export interface ScoreDoc {
  _id: Types.ObjectId;
  cycleId: Types.ObjectId;
  acoId: Types.ObjectId;
  airportId: Types.ObjectId;
  surveyType: SurveyType;
  /** The survey version the cycle pinned for `surveyType`. */
  surveyId: string;
  level: ScoreLevel;
  refId: string;
  /** Position in the survey's pre-order (OVERALL first), so reads come back in tree order. */
  order: number;
  customer: CustomerFiguresDoc;
  self: MeanWithNDoc;
  suppressed: SuppressionReason | null;
  rank: number | null;
  rankOf: number | null;
  previous: { cycleId: Types.ObjectId; mean: number | null } | null;
  delta: number | null;
  distribution: DistributionBucket[] | null;
  counts: ResponseCounts | null;
  provisional: boolean;
  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const meanSchema = new Schema<MeanWithNDoc>(
  {
    mean: { type: Number, default: null },
    n: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const customerSchema = new Schema<CustomerFiguresDoc>(
  {
    mean: { type: Number, default: null },
    n: { type: Number, required: true, default: 0, min: 0 },
    naCount: { type: Number, required: true, default: 0, min: 0 },
    byType: {
      FF: { type: meanSchema, required: true },
      CB: { type: meanSchema, required: true },
    },
  },
  { _id: false },
);

const bucketSchema = new Schema<DistributionBucket>(
  {
    rating: { type: Number, enum: [1, 2, 3, 4, 5, null], default: null },
    label: { type: String, required: true },
    count: { type: Number, required: true, min: 0 },
    pct: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const countsSchema = new Schema<ResponseCounts>(
  {
    customer: { type: Number, required: true, min: 0 },
    self: { type: Number, required: true, min: 0 },
    FF: { type: Number, required: true, min: 0 },
    CB: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const previousSchema = new Schema<NonNullable<ScoreDoc['previous']>>(
  {
    cycleId: { type: Schema.Types.ObjectId, ref: 'Cycle', required: true },
    mean: { type: Number, default: null },
  },
  { _id: false },
);

const schema = new Schema<ScoreDoc>(
  {
    cycleId: { type: Schema.Types.ObjectId, ref: 'Cycle', required: true },
    acoId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    airportId: { type: Schema.Types.ObjectId, ref: 'Airport', required: true },
    surveyType: { type: String, enum: SURVEY_TYPES, required: true },
    surveyId: { type: String, required: true },
    level: { type: String, enum: SCORE_LEVELS, required: true },
    refId: { type: String, required: true },
    order: { type: Number, required: true, default: 0 },
    customer: { type: customerSchema, required: true },
    self: { type: meanSchema, required: true },
    suppressed: { type: String, enum: ['INSUFFICIENT_RESPONSES', null], default: null },
    rank: { type: Number, default: null },
    rankOf: { type: Number, default: null },
    previous: { type: previousSchema, default: null },
    delta: { type: Number, default: null },
    distribution: { type: [bucketSchema], default: null },
    counts: { type: countsSchema, default: null },
    provisional: { type: Boolean, required: true, default: false },
    computedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'scores', minimize: false },
);

schema.index({ cycleId: 1, acoId: 1, surveyType: 1, level: 1, refId: 1 }, { unique: true });
schema.index({ cycleId: 1, surveyType: 1, level: 1 });
schema.index({ acoId: 1, surveyType: 1 });

export const ScoreModel = model<ScoreDoc>('Score', schema);
