import { model, Schema, type Types } from 'mongoose';

import type { SurveyType } from '../../core/events.js';

export const ASSESSMENT_KINDS = ['CUSTOMER', 'SELF'] as const;
export type AssessmentKind = (typeof ASSESSMENT_KINDS)[number];

export const ASSESSMENT_STATUSES = ['DRAFT', 'SUBMITTED'] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

export const CUSTOMER_TYPES = ['FF', 'CB'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const SURVEY_TYPES = ['DOMESTIC', 'INTERNATIONAL'] as const satisfies readonly SurveyType[];

/** Rating scale: Poor = 1, Fair = 2, Good = 3, Very Good = 4, Excellent = 5. */
export const RATINGS = [1, 2, 3, 4, 5] as const;
export type Rating = (typeof RATINGS)[number];

/**
 * One answer. `questionId` is the survey question's id as a string so the
 * assessment never depends on how the surveys module keys its questions.
 * Answered = a rating or NA; a stored answer with neither cannot exist (the
 * validation refuses it), so `answeredCount` is simply `answers.length`
 * restricted to questions that are still on the form.
 */
export interface StoredAnswer {
  questionId: string;
  rating: Rating | null;
  na: boolean;
  comment: string | null;
  followUp: string[];
}

export interface AssessmentDoc {
  _id: Types.ObjectId;
  cycleId: Types.ObjectId;
  acoId: Types.ObjectId;
  airportId: Types.ObjectId;
  /** The survey version pinned by the cycle for `surveyType`; immutable once published. */
  surveyId: string;
  surveyType: SurveyType;
  kind: AssessmentKind;
  customerId: Types.ObjectId | null;
  customerType: CustomerType | null;
  invitationId: Types.ObjectId | null;
  /** The signed-in user who opened a SELF assessment. */
  userId: Types.ObjectId | null;
  status: AssessmentStatus;
  answers: StoredAnswer[];
  answeredCount: number;
  questionCount: number;
  startedAt: Date;
  lastSavedAt: Date | null;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const answerSchema = new Schema<StoredAnswer>(
  {
    questionId: { type: String, required: true },
    rating: { type: Number, enum: [...RATINGS, null], default: null },
    na: { type: Boolean, required: true, default: false },
    comment: { type: String, default: null },
    followUp: { type: [String], required: true, default: () => [] },
  },
  { _id: false },
);

const schema = new Schema<AssessmentDoc>(
  {
    cycleId: { type: Schema.Types.ObjectId, ref: 'Cycle', required: true },
    acoId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    airportId: { type: Schema.Types.ObjectId, ref: 'Airport', required: true },
    surveyId: { type: String, required: true },
    surveyType: { type: String, enum: SURVEY_TYPES, required: true },
    kind: { type: String, enum: ASSESSMENT_KINDS, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerType: { type: String, enum: [...CUSTOMER_TYPES, null], default: null },
    invitationId: { type: Schema.Types.ObjectId, ref: 'Invitation', default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ASSESSMENT_STATUSES, required: true, default: 'DRAFT' },
    answers: { type: [answerSchema], required: true, default: () => [] },
    answeredCount: { type: Number, required: true, default: 0 },
    questionCount: { type: Number, required: true, default: 0 },
    startedAt: { type: Date, required: true },
    lastSavedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'assessments' },
);

schema.index({ cycleId: 1, acoId: 1, kind: 1 });
schema.index({ airportId: 1, cycleId: 1 });
// One assessment per invitation (null = SELF, which the partial filter leaves out).
schema.index({ invitationId: 1 }, { unique: true, partialFilterExpression: { invitationId: { $type: 'objectId' } } });
// One SELF assessment per operator, cycle and survey type.
schema.index({ cycleId: 1, acoId: 1, surveyType: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: 'SELF' } });

export const AssessmentModel = model<AssessmentDoc>('Assessment', schema);
