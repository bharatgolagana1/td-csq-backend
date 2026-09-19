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

/**
 * The organisation registry lives in the orgs module, not here.
 *
 * An earlier kernel draft declared its own `Organisation` model alongside the
 * module's `Organization`. Different spellings meant they never collided at
 * registration, which made it worse rather than safer: the same concept would
 * have accumulated in two collections with no error to notice. The kernel needs
 * only the users collection to resolve a principal.
 */

