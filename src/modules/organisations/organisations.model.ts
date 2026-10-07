import { model, Schema, type Types } from 'mongoose';

export const ORG_TYPES = ['ACFI', 'ACO', 'AIRPORT'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const ORG_STATUSES = ['PENDING', 'ACTIVE', 'INACTIVE'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const CREATED_VIA = ['ADMIN', 'LINK'] as const;
export type CreatedVia = (typeof CREATED_VIA)[number];

export interface Address {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
}

export interface Contact {
  name: string;
  email: string;
  phone: string;
}

export interface Operations {
  domestic: boolean;
  international: boolean;
}

export interface OrganisationDoc {
  _id: Types.ObjectId;
  type: OrgType;
  code: string;
  name: string;
  /** ACO and AIRPORT organisations belong to one airport; ACFI does not. */
  airportId: Types.ObjectId | null;
  legalName: string | null;
  address: Address | null;
  contact: Contact | null;
  operations: Operations;
  status: OrgStatus;
  createdVia: CreatedVia;
  approvedAt: Date | null;
  approvedBy: Types.ObjectId | null;
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

const operationsSchema = new Schema<Operations>(
  {
    domestic: { type: Boolean, required: true, default: false },
    international: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const schema = new Schema<OrganisationDoc>(
  {
    type: { type: String, enum: ORG_TYPES, required: true },
    code: { type: String, required: true, uppercase: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    airportId: { type: Schema.Types.ObjectId, ref: 'Airport', default: null },
    legalName: { type: String, default: null },
    address: { type: addressSchema, default: null },
    contact: { type: contactSchema, default: null },
    operations: { type: operationsSchema, required: true, default: () => ({ domestic: false, international: false }) },
    status: { type: String, enum: ORG_STATUSES, required: true, default: 'ACTIVE' },
    createdVia: { type: String, enum: CREATED_VIA, required: true, default: 'ADMIN' },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'organisations' },
);

schema.index({ airportId: 1 });
schema.index({ type: 1, status: 1 });

export const OrganisationModel = model<OrganisationDoc>('Organisation', schema);
