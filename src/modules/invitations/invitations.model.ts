import { model, Schema, type Types } from 'mongoose';

import type { SurveyType } from '../../core/events.js';
import { SURVEY_TYPES } from '../cycles/domain/types.js';

import { INVITATION_STATES, type InvitationState } from './domain/states.js';

export const CUSTOMER_TYPES = ['FF', 'CB'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

/** What the customer looked like when the sample was locked; the public page masks it. */
export interface InvitationCustomer {
  name: string;
  contactPerson: string;
  type: CustomerType;
}

/** The current one-time code; `sentAts` is the send history the resend throttle reads. */
export interface InvitationOtp {
  hash: string | null;
  expiresAt: Date | null;
  attempts: number;
  sentAts: Date[];
}

export interface InvitationDoc {
  _id: Types.ObjectId;
  cycleId: Types.ObjectId;
  acoId: Types.ObjectId;
  /** The operator's airport at lock time, so AIRPORT scopes can filter without a join. */
  airportId: Types.ObjectId | null;
  customerId: Types.ObjectId;
  surveyType: SurveyType;
  assessmentId: Types.ObjectId | null;
  /** sha256 of the raw link token; null while PENDING (no token yet). */
  tokenHash: string | null;
  /**
   * Hashes of the links sent earlier for this invitation. A reminder carries a
   * fresh link (the raw token is never stored, so it cannot be repeated) and
   * the earlier links keep working; a resend kills them all.
   */
  previousTokenHashes: string[];
  state: InvitationState;
  email: string;
  customer: InvitationCustomer;
  otp: InvitationOtp;
  sentAt: Date | null;
  openedAt: Date | null;
  verifiedAt: Date | null;
  submittedAt: Date | null;
  revokedAt: Date | null;
  expiredAt: Date | null;
  remindersSent: number;
  lastReminderAt: Date | null;
  /** The cycle's assessment end; refreshed when the window is extended. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Every state except REVOKED: a sample may hold one invitation among these at a time. */
export const NON_REVOKED_STATES: readonly InvitationState[] = INVITATION_STATES.filter((state) => state !== 'REVOKED');

const customerSchema = new Schema<InvitationCustomer>(
  {
    name: { type: String, required: true },
    contactPerson: { type: String, required: true, default: '' },
    type: { type: String, enum: CUSTOMER_TYPES, required: true },
  },
  { _id: false },
);

const otpSchema = new Schema<InvitationOtp>(
  {
    hash: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
    sentAts: { type: [Date], required: true, default: () => [] },
  },
  { _id: false },
);

const schema = new Schema<InvitationDoc>(
  {
    cycleId: { type: Schema.Types.ObjectId, required: true },
    acoId: { type: Schema.Types.ObjectId, required: true },
    airportId: { type: Schema.Types.ObjectId, default: null },
    customerId: { type: Schema.Types.ObjectId, required: true },
    surveyType: { type: String, enum: SURVEY_TYPES, required: true },
    assessmentId: { type: Schema.Types.ObjectId, default: null },
    tokenHash: { type: String, default: null },
    previousTokenHashes: { type: [String], required: true, default: () => [] },
    state: { type: String, enum: INVITATION_STATES, required: true, default: 'PENDING' },
    email: { type: String, required: true, lowercase: true, trim: true },
    customer: { type: customerSchema, required: true },
    otp: { type: otpSchema, required: true, default: () => ({ hash: null, expiresAt: null, attempts: 0, sentAts: [] }) },
    sentAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    remindersSent: { type: Number, required: true, default: 0 },
    lastReminderAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'invitations' },
);

// The raw token is never stored; its hash is unique among invitations that have one.
schema.index({ tokenHash: 1 }, { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } });
// Idempotency key of `sample.locked`: one live (or finished) invitation per sample; a
// revoked one stays as history and does not block the next lock.
schema.index(
  { cycleId: 1, acoId: 1, customerId: 1, surveyType: 1 },
  { unique: true, partialFilterExpression: { state: { $in: [...NON_REVOKED_STATES] } }, name: 'one_invitation_per_sample' },
);
schema.index({ previousTokenHashes: 1 });
schema.index({ cycleId: 1, acoId: 1, state: 1 });
schema.index({ state: 1, expiresAt: 1 });
schema.index({ airportId: 1 });

export const InvitationModel = model<InvitationDoc>('Invitation', schema);
