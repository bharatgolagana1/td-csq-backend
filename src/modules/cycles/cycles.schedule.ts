import { model, Schema, type ClientSession, type Types } from 'mongoose';

import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { idString } from '../../core/ids.js';

import { CycleModel, type CycleDoc } from './cycles.model.js';
import { RESERVING_CYCLE_STATUSES, type CycleWindows } from './domain/types.js';

const ScheduleLock = model('CycleScheduleLock', new Schema({
  _id: { type: String, required: true },
  revision: { type: Number, required: true },
}, { collection: 'cycle_schedule_locks', versionKey: false }));

/** All schedule writers must acquire the same document before reading cycles.
 * The real write forces concurrent transactions to retry with a fresh snapshot;
 * a transaction containing only a conflict query would permit write skew.
 */
export async function withCycleScheduleTransaction<T>(write: (session: ClientSession) => Promise<T>): Promise<T> {
  await ScheduleLock.updateOne({ _id: 'global' }, { $setOnInsert: { revision: 0 } }, { upsert: true });
  return withTransaction(async (session) => {
    await ScheduleLock.updateOne({ _id: 'global' }, { $inc: { revision: 1 } }, { session });
    return write(session);
  });
}

/** Only published/active cycles reserve their complete half-open schedule.
 * Drafts and assessment-closed cycles do not; sampling closure stays reserved.
 */
export async function assertScheduleAvailable(windows: CycleWindows, session: ClientSession, exceptId?: Types.ObjectId): Promise<void> {
  const conflicts = await CycleModel.find({
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    // Query the cycle itself: stale publication metadata cannot make a draft reserve dates.
    status: { $in: [...RESERVING_CYCLE_STATUSES] },
    'sampling.start.utc': { $lt: windows.assessment.end.utc },
    'assessment.end.utc': { $gt: windows.sampling.start.utc },
  }, null, { session }).sort({ 'sampling.start.utc': 1, _id: 1 }).lean<CycleDoc[]>();
  if (conflicts.length === 0) return;
  throw new AppError('CYCLE_SCHEDULE_OVERLAP', undefined,
    { conflicts: conflicts.map((cycle) => ({ id: idString(cycle._id), code: cycle.code, name: cycle.name, tz: cycle.tz, endsAt: cycle.assessment.end.utc.toISOString() })) });
}
