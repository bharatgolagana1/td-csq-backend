// Marking what the demo wrote, and taking it away again. Documents the seed
// creates by hand carry a `demoKey`; everything the services derived from
// them (memberships, shares, participants, samples, invitations,
// assessments, scores, the e-mail log, the audit trail, the scheduler's
// idempotency rows) is swept with `demo: true` from the ids of the demo
// organisations, users and cycles, plus everything logged during the run.
// `--reset` deletes exactly that set and nothing else.
import mongoose from 'mongoose';

import { toId } from '../../core/ids.js';
import { AssessmentModel } from '../../modules/assessments/assessments.model.js';
import { AuditModel } from '../../modules/audit/audit.model.js';
import { CustomerModel } from '../../modules/customers/customers.model.js';
import { CycleParticipantModel } from '../../modules/cycles/cycle-participants.model.js';
import { MembershipModel } from '../../modules/identity/memberships.model.js';
import { InvitationModel } from '../../modules/invitations/invitations.model.js';
import { NotificationModel } from '../../modules/notifications/notifications.model.js';
import { MarketShareModel } from '../../modules/organisations/market-shares.model.js';
import { SampleModel } from '../../modules/sampling/sampling.model.js';
import { AirportScoreModel } from '../../modules/scoring/airport-scores.model.js';
import { ScoreModel } from '../../modules/scoring/scores.model.js';

import { DEMO_FILTER } from './runtime.js';

export interface DemoScope {
  /** When the run began: log rows at or after it were written by the seed. */
  startedAt: Date;
  orgIds: readonly string[];
  userIds: readonly string[];
  cycleIds: readonly string[];
}

const DEMO_TAG = { $set: { demo: true } };

export async function tagDemoData(scope: DemoScope): Promise<void> {
  const orgs = scope.orgIds.map((id) => toId(id));
  const users = scope.userIds.map((id) => toId(id));
  const cycles = scope.cycleIds.map((id) => toId(id));
  const since = scope.startedAt;

  await MembershipModel.collection.updateMany({ $or: [{ orgId: { $in: orgs } }, { userId: { $in: users } }] }, DEMO_TAG);
  await MarketShareModel.collection.updateMany({ acoId: { $in: orgs } }, DEMO_TAG);
  await CustomerModel.collection.updateMany({ acoId: { $in: orgs } }, DEMO_TAG);
  for (const model of [CycleParticipantModel, SampleModel, InvitationModel, AssessmentModel, ScoreModel, AirportScoreModel]) {
    await model.collection.updateMany({ cycleId: { $in: cycles } }, DEMO_TAG);
  }
  await NotificationModel.collection.updateMany(
    { $or: [{ createdAt: { $gte: since } }, { 'refs.acoId': { $in: orgs } }, { 'refs.cycleId': { $in: cycles } }, { 'refs.userId': { $in: users } }] },
    DEMO_TAG,
  );
  await AuditModel.collection.updateMany({ $or: [{ at: { $gte: since } }, { orgId: { $in: orgs } }] }, DEMO_TAG);
  await mongoose.connection.collection('jobs').updateMany({ $or: [{ ranAt: { $gte: since } }, { refId: { $in: scope.cycleIds } }] }, DEMO_TAG);
}

/** Deletes every tagged document from every collection; returns what went, per collection. */
export async function resetDemoData(): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  const names = new Set<string>(Object.values(mongoose.models).map((model) => model.collection.collectionName));
  names.add('jobs');
  for (const name of [...names].sort()) {
    const result = await mongoose.connection.collection(name).deleteMany(DEMO_FILTER);
    if (result.deletedCount > 0) deleted[name] = result.deletedCount;
  }
  return deleted;
}

/** How many tagged documents each collection holds (the test's stability check). */
export async function countDemoData(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const names = new Set<string>(Object.values(mongoose.models).map((model) => model.collection.collectionName));
  names.add('jobs');
  for (const name of [...names].sort()) {
    counts[name] = await mongoose.connection.collection(name).countDocuments(DEMO_FILTER);
  }
  return counts;
}
