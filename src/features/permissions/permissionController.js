const Permission = require("./permissionModel");
const mongoose = require('mongoose');



exports.updatePermissions = async (req, res) => {
  const newPermissions = req.body; // Directly use req.body as newPermissions

  // Validate input
  if (!Array.isArray(newPermissions)) {
    return res
      .status(400)
      .send({ message: "Invalid input, array of permissions required" });
  }

  try {
    await Permission.deleteMany({});
    const insertedPermissions = await Permission.insertMany(newPermissions);
    res.status(200).json(insertedPermissions);
  } catch (error) {
    res
      .status(500)
      .send({ message: "Failed to update permissions", error: error.message });
  }
};


exports.getAllPermissions = async (req, res) => {
  try {
    const permissions = await Permission.aggregate([
      {
        $lookup: {
          from: "roles",
          localField: "roleId",
          foreignField: "_id",
          as: "role",
        },
      },
      {
        $unwind: "$role",
      },
      {
        $lookup: {
          from: "tasks",
          localField: "taskId",
          foreignField: "_id",
          as: "task",
        },
      },
      {
        $unwind: "$task",
      },
      {
        $project: {
          _id: 0,
          roleId: "$role._id",
          roleName: "$role.name",
          taskId: "$task._id",
          taskName: "$task.name",
          taskValue: "$task.task_value",
          enable: 1,
        },
      },
    ]);

    res.status(200).json(permissions);
  } catch (error) {
    res.status(500).json({ message: "Error retrieving user permissions", error });
  }
};



exports.getPermissionsByRole = async (req, res) => {
  const { roleId } = req.params;
  try {
    const permissions = await Permission.find({ roleId: roleId });
    if (permissions.length > 0) {
      res.status(200).json(permissions);
    } else {
      res
        .status(404)
        .send({ message: "No permissions found for the given role" });
    }
  } catch (error) {
    res
      .status(500)
      .send({ message: "Failed to fetch permissions", error: error.message });
  }
};