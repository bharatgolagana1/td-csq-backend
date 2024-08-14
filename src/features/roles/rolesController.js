const Role = require("./rolesModel");

exports.createRole = async (req, res) => {
  const { name, description, internal } = req.body;
  const role = new Role({ name, description, internal });
  await role.save();
  res.status(201).json(role);
};

exports.getRoles = async (req, res) => {
  const roles = await Role.find();
  res.status(200).json(roles);
};

exports.getRoleById = async (req, res) => {
  const role = await Role.findById(req.params.id);
  if (!role) {
    return res.status(404).json({ error: "Role not found" });
  }
  res.status(200).json(role);
};
