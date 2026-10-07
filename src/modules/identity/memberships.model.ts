import { model, Schema, type Types } from 'mongoose';

export const MEMBERSHIP_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** A user's role in one organisation; one membership per (user, organisation). */
export interface MembershipDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  orgId: Types.ObjectId;
  roleId: Types.ObjectId;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<MembershipDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organisation', required: true },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
    status: { type: String, enum: MEMBERSHIP_STATUSES, required: true, default: 'ACTIVE' },
  },
  { timestamps: true, collection: 'memberships' },
);

schema.index({ userId: 1, orgId: 1 }, { unique: true });
schema.index({ orgId: 1, status: 1 });

export const MembershipModel = model<MembershipDoc>('Membership', schema);
