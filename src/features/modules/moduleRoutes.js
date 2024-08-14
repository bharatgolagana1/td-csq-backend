const express = require("express");
const router = express.Router();
const { createModule, getModuleById, getModules,} = require("./moduleController");

router.post("/", createModule);
router.get("/", getModules);
router.get("/:id", getModuleById);

module.exports = router;
