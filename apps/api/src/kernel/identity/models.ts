import { Schema, model, models, type HydratedDocument, type Model } from 'mongoose';
import { newId } from '../ids.js';

/**
 * Identity lives outside tenancy on purpose. A user may hold memberships in
 * several organisations, so a users collection filtered by one organisation
 * could not represent that, and the tenancy plugin must never be applied here.
 */

export interface MembershipDoc {
  orgId: string;
  roles: string[];
  /** The authority actually checked at a route. Roles are for display. */
  capabilities: string[];
  active: boolean;
}

export interface UserDoc {
  _id: string;
  /** The "sub" claim. The only thing we trust a token to tell us about identity. */
  subject: string;
  email: string | null;
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED';
  memberships: MembershipDoc[];
  lastSeenAt: Date | null;
}

const MembershipSchema = new Schema<MembershipDoc>(
  {
    orgId: { type: String, required: true },
    roles: { type: [String], default: [] },
    capabilities: { type: [String], default: [] },
    active: { type: Boolean, default: true },
  },
  { _id: false },
);

const UserSchema = new Schema<UserDoc>(
  {
    _id: { type: String, default: newId },
    subject: { type: String, required: true, unique: true, index: true },
    email: { type: String, default: null },
    displayName: { type: String, required: true },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' },
    memberships: { type: [MembershipSchema], default: [] },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true },
);

UserSchema.index({ 'memberships.orgId': 1 });

// reuse the compiled model when one exists: mongoose's registry is global,
// and a second registration of the same name throws OverwriteModelError
export const UserModel: Model<UserDoc> =
  (models['User'] as Model<UserDoc> | undefined) ?? model<UserDoc>('User', UserSchema);
export type UserDocument = HydratedDocument<UserDoc>;

export interface OrganisationDoc {
  _id: string;
  name: string;
  /** ACO is an air cargo operator, the terminal being assessed. */
  kind: 'ACO' | 'AUDITOR' | 'ACFI' | 'CUSTOMER';
  status: 'ACTIVE' | 'SUSPENDED';
}

const OrganisationSchema = new Schema<OrganisationDoc>(
  {
    _id: { type: String, default: newId },
    name: { type: String, required: true },
    kind: { type: String, enum: ['ACO', 'AUDITOR', 'ACFI', 'CUSTOMER'], required: true },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' },
  },
  { timestamps: true },
);

/** The tenancy root. Every tenant-scoped document points at one of these. */
export const OrganisationModel: Model<OrganisationDoc> =
  (models['Organisation'] as Model<OrganisationDoc> | undefined) ??
  model<OrganisationDoc>(
    'Organisation',
  OrganisationSchema,
);
