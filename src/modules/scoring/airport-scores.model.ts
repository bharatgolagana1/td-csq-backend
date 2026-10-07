import { model, Schema, type Types } from 'mongoose';

import type { SurveyType } from '../../core/events.js';

import type { ScoreLevel } from './engine/index.js';
import { SCORE_LEVELS, SURVEY_TYPES } from './scores.model.js';

export interface AirportScoreOperatorDoc {
  acoId: Types.ObjectId;
  /** The operator's published mean at this level; null when suppressed or unscored. */
  mean: number | null;
  /** From the cycle's market-share snapshot; null when the airport has none. */
  sharePct: number | null;
  suppressed: boolean;
}

/**
 * One `airport_scores` document (ARCHITECTURE §5): the market-share weighted
 * mean of the airport's operators at one level and ref, for one survey type
 * (REQUIREMENTS §20). `rank` / `rankOf` rank the airports of the cycle on this
 * same level and ref (the OVERALL rows are the national table).
 */
export interface AirportScoreDoc {
  _id: Types.ObjectId;
  cycleId: Types.ObjectId;
  airportId: Types.ObjectId;
  surveyType: SurveyType;
  level: ScoreLevel;
  refId: string;
  order: number;
  mean: number | null;
  marketShareApplied: boolean;
  coveredSharePct: number;
  operators: AirportScoreOperatorDoc[];
  rank: number | null;
  rankOf: number;
  provisional: boolean;
  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const operatorSchema = new Schema<AirportScoreOperatorDoc>(
  {
    acoId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    mean: { type: Number, default: null },
    sharePct: { type: Number, default: null },
    suppressed: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const schema = new Schema<AirportScoreDoc>(
  {
    cycleId: { type: Schema.Types.ObjectId, ref: 'Cycle', required: true },
    airportId: { type: Schema.Types.ObjectId, ref: 'Airport', required: true },
    surveyType: { type: String, enum: SURVEY_TYPES, required: true },
    level: { type: String, enum: SCORE_LEVELS, required: true },
    refId: { type: String, required: true },
    order: { type: Number, required: true, default: 0 },
    mean: { type: Number, default: null },
    marketShareApplied: { type: Boolean, required: true, default: false },
    coveredSharePct: { type: Number, required: true, default: 0 },
    operators: { type: [operatorSchema], required: true, default: () => [] },
    rank: { type: Number, default: null },
    rankOf: { type: Number, required: true, default: 0 },
    provisional: { type: Boolean, required: true, default: false },
    computedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'airport_scores', minimize: false },
);

schema.index({ cycleId: 1, airportId: 1, surveyType: 1, level: 1, refId: 1 }, { unique: true });
schema.index({ cycleId: 1, surveyType: 1, level: 1, refId: 1 });

export const AirportScoreModel = model<AirportScoreDoc>('AirportScore', schema);
