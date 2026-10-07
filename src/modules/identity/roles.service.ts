import type { Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';
import { idString, toId } from '../../core/ids.js';
import { audit } from '../audit/audit.service.js';
import type { OrgType } from '../organisations/organisations.model.js';
import { ROLE_SCOPE_FOR_ORG_TYPE } from '../organisations/organisations.service.js';

import type { CreateRoleInput, PatchRoleInput, RoleDto } from './identity.schemas.js';
import { RoleTaskModel } from './role-tasks.model.js';
import { RoleModel, type RoleDoc, type RoleScope } from './roles.model.js';

function toDto(doc: RoleDoc, taskCount: number): RoleDto {
  return {
    id: idString(doc._id),
    code: doc.code,
    name: doc.name,
    description: doc.description,
    scope: doc.scope,
    system: doc.system,
    taskCount,
  };
}

async function taskCounts(roleIds: Types.ObjectId[]): Promise<Map<string, number>> {
  if (roleIds.length === 0) return new Map();
  const rows = await RoleTaskModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { roleId: { $in: roleIds }, enabled: true } },
    { $group: { _id: '$roleId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [idString(row._id), row.count]));
}

/** PLATFORM sees every role; an ACO/AIRPORT administrator only the roles of its own scope. */
export async function listRoles(ctx: RequestContext): Promise<RoleDto[]> {
  const filter = ctx.scope.kind === 'PLATFORM' ? {} : { scope: ROLE_SCOPE_FOR_ORG_TYPE[ctx.org.type] };
  const docs = await RoleModel.find(filter).sort({ scope: 1, code: 1 }).lean<RoleDoc[]>();
  const counts = await taskCounts(docs.map((doc) => doc._id));
  return docs.map((doc) => toDto(doc, counts.get(idString(doc._id)) ?? 0));
}

export async function createRole(ctx: RequestContext, input: CreateRoleInput): Promise<RoleDto> {
  const existing = await RoleModel.findOne({ code: input.code }).lean<RoleDoc>();
  if (existing) throw new AppError('CONFLICT', `Role ${input.code} already exists`);
  const created = (await RoleModel.create({ ...input, system: false })).toObject();
  await audit(ctx, { action: 'role.created', entity: 'role', entityId: idString(created._id), after: toDto(created, 0) });
  return toDto(created, 0);
}

export async function updateRole(ctx: RequestContext, id: string, patch: PatchRoleInput): Promise<RoleDto> {
  const before = await RoleModel.findById(toId(id)).lean<RoleDoc>();
  if (!before) throw new AppError('NOT_FOUND', 'Role not found');
  const $set: Partial<Pick<RoleDoc, 'name' | 'description'>> = {};
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.description !== undefined) $set.description = patch.description;
  const after = await RoleModel.findByIdAndUpdate(before._id, { $set }, { new: true }).lean<RoleDoc>();
  if (!after) throw new AppError('NOT_FOUND', 'Role not found');
  const count = (await taskCounts([after._id])).get(idString(after._id)) ?? 0;
  await audit(ctx, {
    action: 'role.updated',
    entity: 'role',
    entityId: idString(after._id),
    before: toDto(before, count),
    after: toDto(after, count),
  });
  return toDto(after, count);
}

export async function findRoleByCode(code: string): Promise<RoleDoc | null> {
  return RoleModel.findOne({ code: code.trim().toUpperCase() }).lean<RoleDoc>();
}

/** VALIDATION (not 404) when the code is unknown: the role is an input, not the resource. */
export async function requireRoleByCode(code: string): Promise<RoleDoc> {
  const role = await findRoleByCode(code);
  if (!role) throw new AppError('VALIDATION', `Unknown role ${code.toUpperCase()}`, { roleCode: code });
  return role;
}

export async function findRolesByIds(ids: Iterable<string | Types.ObjectId>): Promise<Map<string, RoleDoc>> {
  const unique = [...new Set([...ids].map(idString))];
  if (unique.length === 0) return new Map();
  const docs = await RoleModel.find({ _id: { $in: unique.map((id) => toId(id)) } }).lean<RoleDoc[]>();
  return new Map(docs.map((doc) => [idString(doc._id), doc]));
}

/** A membership's role scope must match the organisation type (PLATFORM ↔ ACFI, ACO ↔ ACO, AIRPORT ↔ AIRPORT). */
export function assertRoleFitsOrg(role: Pick<RoleDoc, 'code' | 'scope'>, orgType: OrgType): void {
  const expected: RoleScope = ROLE_SCOPE_FOR_ORG_TYPE[orgType];
  if (role.scope !== expected) {
    throw new AppError('VALIDATION', `Role ${role.code} (${role.scope}) cannot be used in a ${orgType} organisation`, {
      roleCode: role.code,
      roleScope: role.scope,
      orgType,
    });
  }
}

export interface SeedRole {
  code: string;
  name: string;
  description: string;
  scope: RoleScope;
}

/** Upserts system roles. Names and descriptions are only set on insert so administrators' edits survive re-seeding. */
export async function upsertSeedRoles(roles: readonly SeedRole[]): Promise<Map<string, RoleDoc>> {
  await RoleModel.bulkWrite(
    roles.map((role) => ({
      updateOne: {
        filter: { code: role.code },
        update: {
          $set: { scope: role.scope, system: true },
          $setOnInsert: { code: role.code, name: role.name, description: role.description },
        },
        upsert: true,
      },
    })),
  );
  const docs = await RoleModel.find({ code: { $in: roles.map((role) => role.code) } }).lean<RoleDoc[]>();
  return new Map(docs.map((doc) => [doc.code, doc]));
}
