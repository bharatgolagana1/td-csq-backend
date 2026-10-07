import { model, Schema, type Types } from 'mongoose';

export const NOTIFICATION_CHANNELS = ['EMAIL', 'LOG'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['QUEUED', 'SENT', 'FAILED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Links from a notification back to the records it was about; list filters use them. */
export interface NotificationRefs {
  cycleId: Types.ObjectId | null;
  acoId: Types.ObjectId | null;
  customerId: Types.ObjectId | null;
  invitationId: Types.ObjectId | null;
  userId: Types.ObjectId | null;
}

export interface NotificationDoc {
  _id: Types.ObjectId;
  channel: NotificationChannel;
  template: string;
  to: string;
  subject: string;
  body: string;
  html: string;
  vars: Record<string, unknown>;
  refs: NotificationRefs;
  status: NotificationStatus;
  error: string | null;
  sentAt: Date | null;
  resendOf: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const refsSchema = new Schema<NotificationRefs>(
  {
    cycleId: { type: Schema.Types.ObjectId, default: null },
    acoId: { type: Schema.Types.ObjectId, default: null },
    customerId: { type: Schema.Types.ObjectId, default: null },
    invitationId: { type: Schema.Types.ObjectId, default: null },
    userId: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const schema = new Schema<NotificationDoc>(
  {
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
    template: { type: String, required: true },
    to: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    html: { type: String, default: '' },
    vars: { type: Schema.Types.Mixed, default: () => ({}) },
    refs: { type: refsSchema, required: true, default: () => ({}) },
    status: { type: String, enum: NOTIFICATION_STATUSES, required: true, default: 'QUEUED' },
    error: { type: String, default: null },
    sentAt: { type: Date, default: null },
    resendOf: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'notifications', minimize: false },
);

schema.index({ 'refs.cycleId': 1 });
schema.index({ 'refs.acoId': 1, createdAt: -1 });
schema.index({ status: 1 });
schema.index({ template: 1, createdAt: -1 });

export const NotificationModel = model<NotificationDoc>('Notification', schema);
