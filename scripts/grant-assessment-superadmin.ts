
import { loadEnv } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/core/db.js';
import { RoleModel } from '../src/modules/identity/roles.model.js';
import { TaskModel } from '../src/modules/identity/tasks.model.js';
import { RoleTaskModel } from '../src/modules/identity/role-tasks.model.js';
import { bumpRbacVersion } from '../src/modules/settings/settings.service.js';

const env = loadEnv();

const permissionCodes = [
  'assessments.scores',
  'assessments.details',
];

await connectDb(env.MONGO_URI);

try {
  const role = await RoleModel.findOne({
    code: 'SUPER_ADMIN',
  });

  if (!role) {
    throw new Error('SUPER_ADMIN role not found');
  }

  const tasks = await TaskModel.find({
    code: { $in: permissionCodes },
  });

  if (tasks.length !== permissionCodes.length) {
    throw new Error('Assessment permissions are not registered in MongoDB');
  }

  for (const task of tasks) {
    await RoleTaskModel.updateOne(
      {
        roleId: role._id,
        taskId: task._id,
      },
      {
        $set: { enabled: true },
        $setOnInsert: {
          roleId: role._id,
          taskId: task._id,
        },
      },
      { upsert: true },
    );

    console.log(`Granted ${task.code} to SUPER_ADMIN`);
  }

  // Refresh the backend's role-permission cache.
  await bumpRbacVersion();

  console.log('Super Admin assessment permissions updated successfully');
} finally {
  await disconnectDb();
}
