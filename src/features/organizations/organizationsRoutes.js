const express = require("express");
const router = express.Router();
const {
  createOrganization,
  getOrganizationById,
  getOrganizations,
  deleteOrganization,
} = require("./organizationsController");

router.post("/", createOrganization);
router.get("/", getOrganizations);
router.get("/:id", getOrganizationById);
router.delete("/:id", deleteOrganization);

module.exports = router;
