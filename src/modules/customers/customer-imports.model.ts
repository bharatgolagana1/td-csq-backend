import { model, Schema, type Types } from 'mongoose';

import { CUSTOMER_SURVEY_TYPES, CUSTOMER_TYPES } from './customers.model.js';
import type { AcceptedCustomerRow, CustomerCsvAction } from './domain/csvValidate.js';

export const IMPORT_STATUSES = ['VALIDATED', 'COMMITTED'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const IMPORT_ACTIONS = ['CREATE', 'UPDATE'] as const satisfies readonly CustomerCsvAction[];

export interface CustomerImportError {
  row: number;
  field: string;
  message: string;
}

export interface CustomerImportHeaders {
  matched: Record<string, string>;
  ignored: string[];
  missing: string[];
}

export interface CustomerImportResult {
  created: number;
  updated: number;
}

/**
 * One validated upload (ARCHITECTURE §5 `customer_imports`). The accepted
 * rows are kept on the document so the commit replays exactly what the
 * operator reviewed.
 */
export interface CustomerImportDoc {
  _id: Types.ObjectId;
  acoId: Types.ObjectId;
  fileName: string;
  rows: number;
  accepted: number;
  rejected: number;
  errors: CustomerImportError[];
  status: ImportStatus;
  createdBy: Types.ObjectId;
  records: AcceptedCustomerRow[];
  headers: CustomerImportHeaders;
  result: CustomerImportResult | null;
  committedAt: Date | null;
  committedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const errorSchema = new Schema<CustomerImportError>(
  {
    row: { type: Number, required: true },
    field: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

const recordSchema = new Schema<AcceptedCustomerRow>(
  {
    row: { type: Number, required: true },
    action: { type: String, enum: IMPORT_ACTIONS, required: true },
    data: {
      type: new Schema(
        {
          name: { type: String, required: true },
          contactPerson: { type: String, required: true },
          email: { type: String, required: true },
          phone: { type: String, required: true },
          type: { type: String, enum: CUSTOMER_TYPES, required: true },
          surveyType: { type: String, enum: CUSTOMER_SURVEY_TYPES, required: true },
          tags: { type: [String], required: true, default: () => [] },
        },
        { _id: false },
      ),
      required: true,
    },
  },
  { _id: false },
);

const headersSchema = new Schema<CustomerImportHeaders>(
  {
    matched: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
    ignored: { type: [String], required: true, default: () => [] },
    missing: { type: [String], required: true, default: () => [] },
  },
  { _id: false, minimize: false },
);

const resultSchema = new Schema<CustomerImportResult>(
  {
    created: { type: Number, required: true },
    updated: { type: Number, required: true },
  },
  { _id: false },
);

const schema = new Schema<CustomerImportDoc>(
  {
    acoId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    fileName: { type: String, required: true },
    rows: { type: Number, required: true },
    accepted: { type: Number, required: true },
    rejected: { type: Number, required: true },
    errors: { type: [errorSchema], required: true, default: () => [] },
    status: { type: String, enum: IMPORT_STATUSES, required: true, default: 'VALIDATED' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    records: { type: [recordSchema], required: true, default: () => [] },
    headers: { type: headersSchema, required: true, default: () => ({ matched: {}, ignored: [], missing: [] }) },
    result: { type: resultSchema, default: null },
    committedAt: { type: Date, default: null },
    committedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  // `errors` is the field name ARCHITECTURE §5 gives this collection; mongoose only warns about it.
  { timestamps: true, collection: 'customer_imports', minimize: false, suppressReservedKeysWarning: true },
);

schema.index({ acoId: 1, createdAt: -1 });

export const CustomerImportModel = model<CustomerImportDoc>('CustomerImport', schema);
