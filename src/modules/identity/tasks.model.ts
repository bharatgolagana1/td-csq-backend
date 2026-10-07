import { model, Schema, type Types } from 'mongoose';

/** Capability codes declared by modules (`index.ts`) and upserted at boot; never deleted. */
export interface TaskDoc {
  _id: Types.ObjectId;
  code: string;
  module: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<TaskDoc>(
  {
    code: { type: String, required: true, trim: true, unique: true },
    module: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
  },
  { timestamps: true, collection: 'tasks' },
);

schema.index({ module: 1, code: 1 });

export const TaskModel = model<TaskDoc>('Task', schema);
