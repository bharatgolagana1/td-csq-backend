import { model, Schema, type Types } from 'mongoose';

import type { SurveyType } from '../cycles/domain/types.js';

export const SAMPLE_STATES = ['SELECTED', 'LOCKED', 'REMOVED'] as const;
export type SampleState = (typeof SAMPLE_STATES)[number];

export const SAMPLE_SURVEY_TYPES = ['DOMESTIC', 'INTERNATIONAL'] as const;

/**
 * One (customer, surveyType) entry of an operator's sample for a cycle
 * (ARCHITECTURE §5 `samples`). A de-selected entry is kept as REMOVED so the
 * unique key never blocks re-adding the same customer.
 */
export interface SampleDoc {
  _id: Types.ObjectId;
  cycleId: Types.ObjectId;
  acoId: Types.ObjectId;
  customerId: Types.ObjectId;
  surveyType: SurveyType;
  state: SampleState;
  addedBy: Types.ObjectId | null;
  addedAt: Date;
  removedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<SampleDoc>(
  {
    cycleId: { type: Schema.Types.ObjectId, required: true },
    acoId: { type: Schema.Types.ObjectId, required: true },
    customerId: { type: Schema.Types.ObjectId, required: true },
    surveyType: { type: String, enum: SAMPLE_SURVEY_TYPES, required: true },
    state: { type: String, enum: SAMPLE_STATES, required: true, default: 'SELECTED' },
    addedBy: { type: Schema.Types.ObjectId, default: null },
    addedAt: { type: Date, required: true },
    removedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'samples' },
);

schema.index({ cycleId: 1, acoId: 1, customerId: 1, surveyType: 1 }, { unique: true });
schema.index({ cycleId: 1, acoId: 1, state: 1 });
schema.index({ acoId: 1, customerId: 1, state: 1 });

export const SampleModel = model<SampleDoc>('Sample', schema);
