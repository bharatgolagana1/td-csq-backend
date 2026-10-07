// Low-level membership store: who belongs to which organisation with which
// role. The ctx-aware operations (add/remove through the API) live in
// users.service.ts because they are user-management actions.
import type { ClientSession, Types } from 'mongoose';

import { idString, toId } from '../../core/ids.js';
import type { OrgStatus, OrgType } from '../organisations/organisations.model.js';
import { findOrganisationsByIds } from '../organisations/organisations.service.js';

import { MembershipModel, type MembershipDoc, type MembershipStatus } from './memberships.model.js';
import type { RoleScope } from './roles.model.js';
import { findRolesByIds } from './roles.service.js';

/** A membership joined with its organisation and role. */
export interface MembershipView {
  id: string;
  userId: string;
  orgId: string;
  orgCode: string;
  orgName: string;
  orgType: OrgType;
  orgStatus: OrgStatus;
  airportId: string | null;
  roleId: string;
  roleCode: string;
  roleName: string;
  roleScope: RoleScope;
  status: MembershipStatus;
  createdAt: Date;
}

async function joinMemberships(docs: MembershipDoc[]): Promise<MembershipView[]> {
  const [orgs, roles] = await Promise.all([
    findOrganisationsByIds(docs.map((doc) => doc.orgId)),
    findRolesByIds(docs.map((doc) => doc.roleId)),
  ]);
  const views: MembershipView[] = [];
  for (const doc of docs) {
    const org = orgs.get(idString(doc.orgId));
    const role = roles.get(idString(doc.roleId));
    // A membership whose organisation or role vanished is unusable; skip rather than crash.
    if (!org || !role) continue;
    views.push({
      id: idString(doc._id),
      userId: idString(doc.userId),
      orgId: idString(org._id),
      orgCode: org.code,
      orgName: org.name,
      orgType: org.type,
      orgStatus: org.status,
      airportId: org.airportId ? idString(org.airportId) : null,
      roleId: idString(role._id),
      roleCode: role.code,
      roleName: role.name,
      roleScope: role.scope,
      status: doc.status,
      createdAt: doc.createdAt,
    });
  }
  return views;
}

export async function listMembershipsForUser(userId: string | Types.ObjectId): Promise<MembershipView[]> {
  const docs = await MembershipModel.find({ userId: toId(idString(userId)) }).sort({ createdAt: 1 }).lean<MembershipDoc[]>();
  return joinMemberships(docs);
}

export async function listMembershipsForUsers(userIds: Iterable<string | Types.ObjectId>): Promise<Map<string, MembershipView[]>> {
  const ids = [...new Set([...userIds].map(idString))];
  const out = new Map<string, MembershipView[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const docs = await MembershipModel.find({ userId: { $in: ids.map((id) => toId(id)) } })
    .sort({ createdAt: 1 })
    .lean<MembershipDoc[]>();
  for (const view of await joinMemberships(docs)) out.get(view.userId)?.push(view);
  return out;
}

export async function findMembershipById(id: string): Promise<MembershipDoc | null> {
  return MembershipModel.findById(toId(id)).lean<MembershipDoc>();
}

export interface EnsureMembershipInput {
  userId: string | Types.ObjectId;
  orgId: string | Types.ObjectId;
  roleId: string | Types.ObjectId;
}

/** Creates the membership or re-activates it with the given role. */
export async function ensureMembership(input: EnsureMembershipInput, session?: ClientSession): Promise<MembershipDoc> {
  const doc = await MembershipModel.findOneAndUpdate(
    { userId: toId(idString(input.userId)), orgId: toId(idString(input.orgId)) },
    { $set: { roleId: toId(idString(input.roleId)), status: 'ACTIVE' } },
    { upsert: true, new: true, ...(session ? { session } : {}) },
  ).lean<MembershipDoc | null>();
  if (!doc) throw new Error('Membership upsert returned nothing');
  return doc;
}

export async function setMembershipStatus(id: string | Types.ObjectId, status: MembershipStatus): Promise<MembershipDoc | null> {
  return MembershipModel.findByIdAndUpdate(toId(idString(id)), { $set: { status } }, { new: true }).lean<MembershipDoc>();
}

export async function listActiveUserIdsInOrg(orgId: string | Types.ObjectId): Promise<Types.ObjectId[]> {
  const docs = await MembershipModel.find({ orgId: toId(idString(orgId)), status: 'ACTIVE' }, { userId: 1 }).lean<
    Pick<MembershipDoc, 'userId'>[]
  >();
  return docs.map((doc) => doc.userId);
}

export async function countActiveMembersByOrg(orgIds: Iterable<string | Types.ObjectId>): Promise<Map<string, number>> {
  const ids = [...new Set([...orgIds].map(idString))];
  if (ids.length === 0) return new Map();
  const rows = await MembershipModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { orgId: { $in: ids.map((id) => toId(id)) }, status: 'ACTIVE' } },
    { $group: { _id: '$orgId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [idString(row._id), row.count]));
}
