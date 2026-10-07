import { model, Schema, type Types } from 'mongoose';

export const SURVEY_TYPES = ['DOMESTIC', 'INTERNATIONAL'] as const;
export type SurveyType = (typeof SURVEY_TYPES)[number];

export const SURVEY_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];

/**
 * One document per version of each survey type. A PUBLISHED version is
 * immutable; editing creates the next DRAFT version, and publishing it
 * retires the previously published one. Cycles pin a version by id, so a
 * RETIRED version stays readable.
 */
export interface SurveyDoc {
  _id: Types.ObjectId;
  code: SurveyType;
  name: string;
  version: number;
  status: SurveyStatus;
  publishedAt: Date | null;
  publishedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<SurveyDoc>(
  {
    code: { type: String, enum: SURVEY_TYPES, required: true },
    name: { type: String, required: true, trim: true },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: SURVEY_STATUSES, required: true, default: 'DRAFT' },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'surveys' },
);

schema.index({ code: 1, version: 1 }, { unique: true });
schema.index({ code: 1, status: 1 });

export const SurveyModel = model<SurveyDoc>('Survey', schema);
