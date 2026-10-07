import { model, Schema, type Types } from 'mongoose';

/** The Role → Task matrix. A missing row means "not granted", same as `enabled: false`. */
export interface RoleTaskDoc {
  _id: Types.ObjectId;
  roleId: Types.ObjectId;
  taskId: Types.ObjectId;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<RoleTaskDoc>(
  {
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    enabled: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: 'role_tasks' },
);

schema.index({ roleId: 1, taskId: 1 }, { unique: true });

export const RoleTaskModel = model<RoleTaskDoc>('RoleTask', schema);
