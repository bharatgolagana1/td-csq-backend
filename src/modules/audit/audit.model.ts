import { model, Schema, type Types } from 'mongoose';

export interface AuditDoc {
  _id: Types.ObjectId;
  actorUserId: Types.ObjectId | null;
  actorEmail: string | null;
  /** The actor's active organisation. */
  actorOrgId: Types.ObjectId | null;
  /** The organisation the entry concerns (defaults to the actor's); tenancy filters use it. */
  orgId: Types.ObjectId | null;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  ip: string;
  requestId: string;
  at: Date;
}

const schema = new Schema<AuditDoc>(
  {
    actorUserId: { type: Schema.Types.ObjectId, default: null },
    actorEmail: { type: String, default: null },
    actorOrgId: { type: Schema.Types.ObjectId, default: null },
    orgId: { type: Schema.Types.ObjectId, default: null },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String, required: true },
    before: { type: Schema.Types.Mixed, default: undefined },
    after: { type: Schema.Types.Mixed, default: undefined },
    ip: { type: String, default: '' },
    requestId: { type: String, default: '' },
    at: { type: Date, required: true },
  },
  { collection: 'audit_log', minimize: false, versionKey: false },
);

schema.index({ entity: 1, entityId: 1, at: -1 });
schema.index({ orgId: 1, at: -1 });
schema.index({ at: -1 });

export const AuditModel = model<AuditDoc>('AuditLog', schema);
