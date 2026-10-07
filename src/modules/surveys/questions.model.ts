import { model, Schema, type Types } from 'mongoose';

export const STAKEHOLDER_TYPES = ['FF', 'CB'] as const;
export type StakeholderType = (typeof STAKEHOLDER_TYPES)[number];

/** When a comment is required: REQUIRED_ON_LOW means on a Fair or Poor rating (ARCHITECTURE §7 form rules). */
export const COMMENT_MODES = ['OPTIONAL', 'REQUIRED', 'REQUIRED_ON_LOW', 'NONE'] as const;
export type CommentMode = (typeof COMMENT_MODES)[number];

/** Asked on a Fair or Poor rating; the assessor picks any of the options. */
export interface FollowUp {
  prompt: string;
  options: string[];
}

export interface QuestionDoc {
  _id: Types.ObjectId;
  surveyId: Types.ObjectId;
  categoryId: Types.ObjectId;
  /** Null when the question sits directly under its category. */
  subcategoryId: Types.ObjectId | null;
  /** Unique within a survey version; carried across versions so scores can be compared. */
  code: string;
  text: string;
  help: string | null;
  order: number;
  weightPct: number | null;
  mandatory: boolean;
  commentMode: CommentMode;
  stakeholderTypes: StakeholderType[];
  followUp: FollowUp | null;
  /** Inactive questions stay in the version for history but are not asked or scored. */
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const followUpSchema = new Schema<FollowUp>(
  {
    prompt: { type: String, required: true, trim: true },
    options: { type: [String], required: true },
  },
  { _id: false },
);

const schema = new Schema<QuestionDoc>(
  {
    surveyId: { type: Schema.Types.ObjectId, ref: 'Survey', required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    subcategoryId: { type: Schema.Types.ObjectId, ref: 'Subcategory', default: null },
    code: { type: String, required: true, uppercase: true, trim: true },
    text: { type: String, required: true, trim: true },
    help: { type: String, default: null },
    order: { type: Number, required: true, default: 0 },
    weightPct: { type: Number, default: null, min: 0, max: 100 },
    mandatory: { type: Boolean, required: true, default: true },
    commentMode: { type: String, enum: COMMENT_MODES, required: true, default: 'OPTIONAL' },
    stakeholderTypes: { type: [{ type: String, enum: STAKEHOLDER_TYPES }], required: true, default: () => [...STAKEHOLDER_TYPES] },
    followUp: { type: followUpSchema, default: null },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: 'questions' },
);

schema.index({ surveyId: 1, code: 1 }, { unique: true });
schema.index({ surveyId: 1, categoryId: 1, subcategoryId: 1, order: 1 });

export const QuestionModel = model<QuestionDoc>('Question', schema);
