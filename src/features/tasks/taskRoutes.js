const express = require("express");
const router = express.Router();
const { createTask, getTasksByModuleId, getTasks,} = require("./taskController");

router.post("/", createTask);
router.get("/", getTasks);
router.get("/module/:moduleId", getTasksByModuleId);

module.exports = router;
