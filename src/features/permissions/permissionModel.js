const mongoose = require("mongoose");

const permissionSchema = new mongoose.Schema({
  roleId: { type: mongoose.Schema.Types.ObjectId, ref: "Role", required: true },
  taskId: { type: mongoose.Schema.Types.ObjectId, ref: "Task", required: true },
  enable: { type: Boolean, required: true },
});

const Permission = mongoose.model("Permission", permissionSchema);

module.exports = Permission;
