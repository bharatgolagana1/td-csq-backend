const express = require("express");
const router = express.Router();
const permissionController = require("./permissionController");

router.get("/", permissionController.getAllPermissions);
router.put("/", permissionController.updatePermissions);
router.get("/role/:roleId", permissionController.getPermissionsByRole);

module.exports = router;
