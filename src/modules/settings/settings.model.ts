import { model, Schema, type Types } from 'mongoose';

export const WEIGHTING_MODES = ['EQUAL', 'WEIGHTED'] as const;
export type WeightingMode = (typeof WEIGHTING_MODES)[number];

export interface ReminderRule {
  count: number;
  everyDays: number;
}

export interface SettingsDoc {
  _id: Types.ObjectId;
  /** Always 'global' — there is exactly one settings document. */
  key: 'global';
  scoring: { minResponses: number; weightingMode: WeightingMode };
  defaults: {
    samplingDays: number;
    assessmentDays: number;
    reminders: { sampling: ReminderRule; assessment: ReminderRule };
    tz: string;
  };
  branding: { orgName: string };
  /** When true, ACO users see assessor identities on returned assessments. */
  revealAssessorIdentity: boolean;
  /** Bumped on every matrix save; the RBAC cache keys on it. */
  rbacVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const reminderSchema = new Schema<ReminderRule>(
  {
    count: { type: Number, required: true, min: 0 },
    everyDays: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const schema = new Schema<SettingsDoc>(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    scoring: {
      minResponses: { type: Number, required: true, min: 1 },
      weightingMode: { type: String, enum: WEIGHTING_MODES, required: true },
    },
    defaults: {
      samplingDays: { type: Number, required: true, min: 1 },
      assessmentDays: { type: Number, required: true, min: 1 },
      reminders: {
        sampling: { type: reminderSchema, required: true },
        assessment: { type: reminderSchema, required: true },
      },
      tz: { type: String, required: true },
    },
    branding: {
      orgName: { type: String, required: true },
    },
    revealAssessorIdentity: { type: Boolean, required: true, default: false },
    rbacVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'settings', minimize: false },
);

export const SettingsModel = model<SettingsDoc>('Settings', schema);
