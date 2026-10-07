import { model, Schema, type Types } from 'mongoose';

/**
 * The scheduler's idempotency record (ARCHITECTURE §5 `jobs`). One row per
 * (type, refId, slot); RUNNING is the claim state while `once()` executes.
 */
export const JOB_STATUSES = ['RUNNING', 'DONE', 'FAILED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobDoc {
  _id: Types.ObjectId;
  type: string;
  refId: string;
  slot: string;
  status: JobStatus;
  ranAt: Date;
  finishedAt: Date | null;
  detail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<JobDoc>(
  {
    type: { type: String, required: true },
    refId: { type: String, required: true },
    slot: { type: String, required: true },
    status: { type: String, enum: JOB_STATUSES, required: true },
    ranAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    detail: { type: String, default: null },
  },
  { timestamps: true, collection: 'jobs' },
);

schema.index({ type: 1, refId: 1, slot: 1 }, { unique: true });

export const JobModel = model<JobDoc>('Job', schema);
