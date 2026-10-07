import { model, Schema, type Types } from 'mongoose';

import type { CustomerSurveyType, CustomerType } from './domain/csvTemplate.js';

export const CUSTOMER_TYPES = ['FF', 'CB'] as const satisfies readonly CustomerType[];
export const CUSTOMER_SURVEY_TYPES = ['DOMESTIC', 'INTERNATIONAL', 'BOTH'] as const satisfies readonly CustomerSurveyType[];

export const CUSTOMER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/** One FF / CB stakeholder in an operator's directory (ARCHITECTURE §5 `customers`). */
export interface CustomerDoc {
  _id: Types.ObjectId;
  acoId: Types.ObjectId;
  /** The operator's airport at the time the customer was created or last imported. */
  airportId: Types.ObjectId;
  name: string;
  contactPerson: string;
  /** Lower-case; unique per operator and the key on re-import. */
  email: string;
  /** E.164 as produced by the domain normaliser. */
  phone: string;
  type: CustomerType;
  surveyType: CustomerSurveyType;
  status: CustomerStatus;
  tags: string[];
  lastSampledCycleId: Types.ObjectId | null;
  /** The `customer_imports` row that created or last updated this customer. */
  importBatchId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<CustomerDoc>(
  {
    acoId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    airportId: { type: Schema.Types.ObjectId, ref: 'Airport', required: true },
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    type: { type: String, enum: CUSTOMER_TYPES, required: true },
    surveyType: { type: String, enum: CUSTOMER_SURVEY_TYPES, required: true },
    status: { type: String, enum: CUSTOMER_STATUSES, required: true, default: 'ACTIVE' },
    tags: { type: [String], required: true, default: () => [] },
    lastSampledCycleId: { type: Schema.Types.ObjectId, ref: 'Cycle', default: null },
    importBatchId: { type: Schema.Types.ObjectId, ref: 'CustomerImport', default: null },
  },
  { timestamps: true, collection: 'customers' },
);

schema.index({ acoId: 1, email: 1 }, { unique: true });
schema.index({ acoId: 1, status: 1 });
schema.index({ acoId: 1, name: 1 });

export const CustomerModel = model<CustomerDoc>('Customer', schema);
