import { model, Schema, type Types } from 'mongoose';

/** Organisation types that may self-register; ACFI is never onboarded through a link. */
export const ONBOARDING_ORG_TYPES = ['ACO', 'AIRPORT'] as const;
export type OnboardingOrgType = (typeof ONBOARDING_ORG_TYPES)[number];

/**
 * A self-registration link (ARCHITECTURE §5 `onboarding_links`). The raw
 * token appears only in the create response; the database keeps its sha256.
 * The link is tied to one airport so the form cannot pick another.
 */
export interface OnboardingLinkDoc {
  _id: Types.ObjectId;
  tokenHash: string;
  orgType: OnboardingOrgType;
  airportId: Types.ObjectId;
  createdBy: Types.ObjectId;
  expiresAt: Date;
  usedAt: Date | null;
  registrationId: Types.ObjectId | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<OnboardingLinkDoc>(
  {
    tokenHash: { type: String, required: true, unique: true },
    orgType: { type: String, enum: ONBOARDING_ORG_TYPES, required: true },
    airportId: { type: Schema.Types.ObjectId, ref: 'Airport', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    registrationId: { type: Schema.Types.ObjectId, ref: 'Registration', default: null },
    note: { type: String, default: null },
  },
  { timestamps: true, collection: 'onboarding_links' },
);

schema.index({ createdAt: -1 });
schema.index({ usedAt: 1, expiresAt: 1 });

export const OnboardingLinkModel = model<OnboardingLinkDoc>('OnboardingLink', schema);
