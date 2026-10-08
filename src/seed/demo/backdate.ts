// The one place the demo seed writes to collections directly, and why.
//
// A past cycle is built by replaying its life through the services. Every
// service that takes a `now` (publish, the clock transitions, activation,
// the link page, the OTP, the lock timestamp) is given the story's instant.
// Four writes stamp the real clock with no way to say otherwise, and a
// cycle that closed in May whose answers were "submitted today" would read
// as broken on the history grid:
//
//   - `assessments.submit` / `getOrCreateForInvitation` / `patchAnswers`:
//     `submittedAt`, `startedAt`, `lastSavedAt`;
//   - `invitations.markSubmitted`: `submittedAt`;
//   - the sampling selection: `samples.addedAt`;
//   - the SCORED transition, taken by the `scoring.completed` listener (no
//     `now` reaches it): `cycles.scoredAt`.
//
// Only those fields are touched, only on documents of the cycle being
// built, and every value stays inside the window the service enforced.
// Audit rows, notifications and `scores.computedAt` keep the real instant:
// they are the honest log of the seed run itself.
import type { mongo } from 'mongoose';

import { toId } from '../../core/ids.js';
import { AssessmentModel } from '../../modules/assessments/assessments.model.js';
import { CycleModel } from '../../modules/cycles/cycles.model.js';
import { InvitationModel } from '../../modules/invitations/invitations.model.js';
import { SampleModel } from '../../modules/sampling/sampling.model.js';

import type { Rng } from './prng.js';
import type { Backdates } from './responses.js';

const HOUR = 3_600_000;

export interface CycleBackdate extends Backdates {
  cycleId: string;
  scoredAt: Date;
  samplingStart: Date;
  /** When each operator locked (`cycle_participants.sampling.lockedAt`, already set through the service). */
  lockedAtByAco: ReadonlyMap<string, Date>;
  rng: Rng;
}

/** Operations for the native driver (the models do not know these fields exist). */
type RawOperation = mongo.AnyBulkWriteOperation;

export async function backdateCycle(input: CycleBackdate): Promise<void> {
  const cycleId = toId(input.cycleId);

  const assessmentOps: RawOperation[] = [...input.assessments].map(([id, at]) => ({
    updateOne: { filter: { _id: toId(id) }, update: { $set: { startedAt: at.startedAt, lastSavedAt: at.lastSavedAt, submittedAt: at.submittedAt } } },
  }));
  if (assessmentOps.length > 0) await AssessmentModel.collection.bulkWrite(assessmentOps, { ordered: false });

  const invitationOps: RawOperation[] = [...input.invitations].map(([id, at]) => ({
    updateOne: { filter: { _id: toId(id) }, update: { $set: { submittedAt: at.submittedAt } } },
  }));
  if (invitationOps.length > 0) await InvitationModel.collection.bulkWrite(invitationOps, { ordered: false });

  const samples = await SampleModel.collection.find({ cycleId }, { projection: { _id: 1, acoId: 1 } }).toArray();
  const sampleOps: RawOperation[] = samples.map((sample) => {
    const acoId = String(sample['acoId']);
    const lockedAt = input.lockedAtByAco.get(acoId) ?? new Date(input.samplingStart.getTime() + 24 * HOUR);
    const earliest = input.samplingStart.getTime() + HOUR;
    const latest = Math.max(earliest, lockedAt.getTime() - HOUR);
    const addedAt = new Date(earliest + input.rng.next() * (latest - earliest));
    return { updateOne: { filter: { _id: sample._id }, update: { $set: { addedAt } } } };
  });
  if (sampleOps.length > 0) await SampleModel.collection.bulkWrite(sampleOps, { ordered: false });

  await CycleModel.collection.updateOne({ _id: cycleId }, { $set: { scoredAt: input.scoredAt } });
}
