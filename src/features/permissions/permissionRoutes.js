const express = require("express");
const router = express.Router();
const permissionController = require("./permissionController");

// Existing routes
router.get("/", permissionController.getAllPermissions);
router.put("/", permissionController.updatePermissions);
router.get("/role/:roleId", permissionController.getPermissionsByRole);

// New route for getting user permissions
//router.get("/user-permissions", permissionController.getUserPermissions);

module.exports = router;
