import { withTransaction } from '../../core/db.js';
import { idString } from '../../core/ids.js';
import { bumpRbacVersion } from '../settings/settings.service.js';

import { RoleTaskModel } from './role-tasks.model.js';
import { RoleModel } from './roles.model.js';
import { TaskModel } from './tasks.model.js';

/** Boot/seed reconciliation for the locked platform administrator matrix.
 * Task sync alone creates task definitions, not grants in existing installs.
 * Only this system role is repaired; custom role grants remain untouched.
 */
export async function migrateSuperAdminGrants(): Promise<void> {
  await withTransaction(async (session) => {
    const role = await RoleModel.findOne({ code: 'SUPER_ADMIN', system: true, scope: 'PLATFORM' }).session(session).lean();
    if (!role) return;
    const tasks = await TaskModel.find({}, { _id: 1 }).session(session).lean();
    const enabled = await RoleTaskModel.find({ roleId: role._id, enabled: true }, { taskId: 1 }).session(session).lean();
    const granted = new Set(enabled.map((grant) => idString(grant.taskId)));
    const missing = tasks.filter((task) => !granted.has(idString(task._id)));
    if (missing.length === 0) return;
    const result = await RoleTaskModel.bulkWrite(missing.map((task) => ({
      updateOne: {
        filter: { roleId: role._id, taskId: task._id },
        update: { $set: { enabled: true }, $setOnInsert: { roleId: role._id, taskId: task._id } },
        upsert: true,
      },
    })), { session });
    if (result.modifiedCount > 0 || result.upsertedCount > 0) await bumpRbacVersion(session);
  });
}
