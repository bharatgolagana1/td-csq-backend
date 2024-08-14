const Task = require("./taskModel");

exports.createTask = async (req, res) => {
  try {
    const { name, description, moduleId, task_value } = req.body;
    const task = new Task({ name, description, moduleId, task_value });
    await task.save();
    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTasks = async (req, res) => {
  try {
    const tasks = await Task.find();
    res.status(200).json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTasksByModuleId = async (req, res) => {
  try {
    const tasks = await Task.find({ moduleId: req.params.moduleId });
    res.status(200).json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
