const Permission = require("./permissionModel");

exports.getAllPermissions = async (req, res) => {
  try {
    const permissions = await Permission.find();
    res.status(200).json(permissions);
  } catch (error) {
    res
      .status(500)
      .send({ message: "Failed to fetch permissions", error: error.message });
  }
};

exports.updatePermissions = async (req, res) => {
  const { newPermissions } = req.body;
  if (!Array.isArray(newPermissions)) {
    return res
      .status(400)
      .send({ message: "Invalid input, array of permissions required" });
  }
  try {
    // Remove all permissions and add new ones - This is very destructive and should be adjusted according to real use cases
    await Permission.deleteMany({});
    const insertedPermissions = await Permission.insertMany(newPermissions);
    res.status(200).json({
      message: "Permissions updated successfully",
      permissions: insertedPermissions,
    });
  } catch (error) {
    res
      .status(500)
      .send({ message: "Failed to update permissions", error: error.message });
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
