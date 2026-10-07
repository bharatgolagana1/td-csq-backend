import type { AnyBulkWriteOperation, ClientSession, Types } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { withTransaction } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { idString, toId } from '../../core/ids.js';
import { audit } from '../audit/audit.service.js';
import { bumpRbacVersion } from '../settings/settings.service.js';

import type { MatrixDto, MatrixInput } from './identity.schemas.js';
import { RoleTaskModel, type RoleTaskDoc } from './role-tasks.model.js';
import { RoleModel, type RoleDoc } from './roles.model.js';
import { TaskModel, type TaskDoc } from './tasks.model.js';

export interface TaskUpsert {
  code: string;
  module: string;
  name: string;
  description: string;
}

/** Boot-time sync of module-declared tasks. Never deletes: a retired code stays until cleaned by hand. */
export async function upsertTasks(definitions: readonly TaskUpsert[]): Promise<void> {
  if (definitions.length === 0) return;
  await TaskModel.bulkWrite(
    definitions.map((task) => ({
      updateOne: {
        filter: { code: task.code },
        update: { $set: { module: task.module, name: task.name, description: task.description } },
        upsert: true,
      },
    })),
  );
}

export async function listTasks(): Promise<TaskDoc[]> {
  return TaskModel.find().sort({ module: 1, code: 1 }).lean<TaskDoc[]>();
}

/** roleId → enabled task codes; the RBAC cache loads this once per rbacVersion. */
export async function loadRoleTaskCodes(): Promise<Map<string, ReadonlySet<string>>> {
  const [tasks, grants] = await Promise.all([
    TaskModel.find({}, { code: 1 }).lean<Pick<TaskDoc, '_id' | 'code'>[]>(),
    RoleTaskModel.find({ enabled: true }, { roleId: 1, taskId: 1 }).lean<Pick<RoleTaskDoc, 'roleId' | 'taskId'>[]>(),
  ]);
  const codeByTaskId = new Map(tasks.map((task) => [idString(task._id), task.code]));
  const byRole = new Map<string, Set<string>>();
  for (const grant of grants) {
    const code = codeByTaskId.get(idString(grant.taskId));
    if (!code) continue;
    const roleId = idString(grant.roleId);
    let set = byRole.get(roleId);
    if (!set) {
      set = new Set();
      byRole.set(roleId, set);
    }
    set.add(code);
  }
  return byRole;
}

export async function getMatrix(): Promise<MatrixDto> {
  const [tasks, roles, byRole] = await Promise.all([
    listTasks(),
    RoleModel.find().sort({ scope: 1, code: 1 }).lean<RoleDoc[]>(),
    loadRoleTaskCodes(),
  ]);
  return {
    tasks: tasks.map((task) => ({ code: task.code, module: task.module, name: task.name, description: task.description })),
    roles: roles.map((role) => ({
      id: idString(role._id),
      code: role.code,
      name: role.name,
      scope: role.scope,
      system: role.system,
      tasks: [...(byRole.get(idString(role._id)) ?? [])].sort(),
    })),
  };
}

/**
 * Whole-matrix save: every role in the payload gets exactly the listed tasks;
 * roles not in the payload are untouched. Bumps `settings.rbacVersion` in the
 * same transaction and audits before/after per role.
 */
export async function saveMatrix(ctx: RequestContext, input: MatrixInput): Promise<MatrixDto> {
  const [tasks, roles] = await Promise.all([listTasks(), RoleModel.find().lean<RoleDoc[]>()]);
  const taskByCode = new Map(tasks.map((task) => [task.code, task]));
  const roleById = new Map(roles.map((role) => [idString(role._id), role]));

  const problems: { path: string; message: string }[] = [];
  const seen = new Set<string>();
  input.roles.forEach((entry, index) => {
    if (!roleById.has(entry.roleId)) problems.push({ path: `roles.${index}.roleId`, message: `Unknown role ${entry.roleId}` });
    if (seen.has(entry.roleId)) problems.push({ path: `roles.${index}.roleId`, message: 'Role listed twice' });
    seen.add(entry.roleId);
    entry.tasks.forEach((code, taskIndex) => {
      if (!taskByCode.has(code)) problems.push({ path: `roles.${index}.tasks.${taskIndex}`, message: `Unknown task ${code}` });
    });
  });
  if (problems.length > 0) throw new AppError('VALIDATION', 'Matrix references unknown roles or tasks', { issues: problems });

  const own = input.roles.find((entry) => entry.roleId === ctx.role.id);
  if (own && !own.tasks.includes('roles.manage')) {
    throw new AppError('PRECONDITION_FAILED', 'You cannot remove roles.manage from your own role');
  }

  const before = await getMatrix();
  await withTransaction(async (session) => {
    const ops: AnyBulkWriteOperation<RoleTaskDoc>[] = [];
    for (const entry of input.roles) {
      const roleId = toId(entry.roleId);
      const wanted = new Set(entry.tasks);
      for (const task of tasks) {
        ops.push({
          updateOne: {
            filter: { roleId, taskId: task._id },
            update: { $set: { enabled: wanted.has(task.code) }, $setOnInsert: { roleId, taskId: task._id } },
            upsert: true,
          },
        });
      }
    }
    if (ops.length > 0) await RoleTaskModel.bulkWrite(ops, { session });
    await bumpRbacVersion(session);
  });
  const after = await getMatrix();

  const changed = new Set(input.roles.map((entry) => entry.roleId));
  const snapshot = (matrix: MatrixDto) =>
    Object.fromEntries(matrix.roles.filter((role) => changed.has(role.id)).map((role) => [role.code, role.tasks]));
  await audit(ctx, {
    action: 'roles.matrix.saved',
    entity: 'roles.matrix',
    entityId: 'global',
    before: snapshot(before),
    after: snapshot(after),
  });
  return after;
}

/** Seed helper: grants tasks a role does not have a row for yet; existing rows (including disabled) are left alone. */
export async function grantTasksIfAbsent(roleId: Types.ObjectId, taskIds: Types.ObjectId[], session?: ClientSession): Promise<void> {
  if (taskIds.length === 0) return;
  await RoleTaskModel.bulkWrite(
    taskIds.map((taskId) => ({
      updateOne: {
        filter: { roleId, taskId },
        update: { $setOnInsert: { roleId, taskId, enabled: true } },
        upsert: true,
      },
    })),
    session ? { session } : {},
  );
}
