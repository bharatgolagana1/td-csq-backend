const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  moduleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Module",
    required: true,
  },
  task_value: { type: String, required: true },
});

const Task = mongoose.model("Task", taskSchema);

module.exports = Task;
