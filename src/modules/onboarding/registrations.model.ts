import { model, Schema, type Types } from 'mongoose';

import type { Address, Contact, Operations } from '../organisations/organisations.model.js';

import { ONBOARDING_ORG_TYPES, type OnboardingOrgType } from './onboarding-links.model.js';

export const REGISTRATION_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** What the form said about the organisation: the `organisations` shape minus code, status and airport. */
export interface RegistrationOrganisation {
  name: string;
  legalName: string | null;
  address: Address;
  contact: Contact;
}

export interface RegistrationAdmin {
  name: string;
  email: string;
  phone: string;
}

/**
 * A submitted registration form (ARCHITECTURE §5 `registrations`). Approval
 * creates the organisation and the admin user and records them here; the
 * registration itself is never edited afterwards.
 */
export interface RegistrationDoc {
  _id: Types.ObjectId;
  linkId: Types.ObjectId | null;
  orgType: OnboardingOrgType;
  airportId: Types.ObjectId;
  organisation: RegistrationOrganisation;
  operations: Operations;
  admin: RegistrationAdmin;
  /** The share the applicant asked for (ACO only); the reviewer decides the granted value. */
  marketSharePct: number | null;
  status: RegistrationStatus;
  reviewedBy: Types.ObjectId | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  resultOrgId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const addressSchema = new Schema<Address>(
  {
    line1: { type: String, required: true },
    line2: { type: String, default: null },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
  },
  { _id: false },
);

const contactSchema = new Schema<Contact>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, required: true },
  },
  { _id: false },
);

const organisationSchema = new Schema<RegistrationOrganisation>(
  {
    name: { type: String, required: true, trim: true },
    legalName: { type: String, default: null },
    address: { type: addressSchema, required: true },
    contact: { type: contactSchema, required: true },
  },
  { _id: false },
);

const operationsSchema = new Schema<Operations>(
  {
    domestic: { type: Boolean, required: true, default: false },
    international: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const adminSchema = new Schema<RegistrationAdmin>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, required: true },
  },
  { _id: false },
);

const schema = new Schema<RegistrationDoc>(
  {
    linkId: { type: Schema.Types.ObjectId, ref: 'OnboardingLink', default: null },
    orgType: { type: String, enum: ONBOARDING_ORG_TYPES, required: true },
    airportId: { type: Schema.Types.ObjectId, ref: 'Airport', required: true },
    organisation: { type: organisationSchema, required: true },
    operations: { type: operationsSchema, required: true, default: () => ({ domestic: false, international: false }) },
    admin: { type: adminSchema, required: true },
    marketSharePct: { type: Number, default: null, min: 0, max: 100 },
    status: { type: String, enum: REGISTRATION_STATUSES, required: true, default: 'SUBMITTED' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: null },
    resultOrgId: { type: Schema.Types.ObjectId, ref: 'Organisation', default: null },
  },
  { timestamps: true, collection: 'registrations' },
);

schema.index({ status: 1, createdAt: -1 });
schema.index({ airportId: 1 });
schema.index({ linkId: 1 });

export const RegistrationModel = model<RegistrationDoc>('Registration', schema);
