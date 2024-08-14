const AssessmentCycle = require('../models/assessmentCycleModel');

// Add a new assessment cycle
exports.addAssessmentCycle = async (req, res) => {
  try {
    const newAssessmentCycle = new AssessmentCycle(req.body);
    await newAssessmentCycle.save();
    res.status(201).json(newAssessmentCycle);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};



// Get all assessment cycles
exports.getAllAssessmentCycles = async (_req, res) => {
  try {
    const assessmentCycles = await AssessmentCycle.find();
    res.json(assessmentCycles);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get an assessment cycle by ID
exports.getAssessmentCycleById = async (req, res) => {
  try {
    const { id } = req.params;
    const assessmentCycle = await AssessmentCycle.findById(id);
    if (!assessmentCycle) {
      return res.status(404).json({ message: 'Assessment Cycle not found' });
    }
    res.json(assessmentCycle);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update an assessment cycle by ID
exports.updateAssessmentCycle = async (req, res) => {
  try {
    const { id } = req.params;
    const updatedAssessmentCycle = await AssessmentCycle.findByIdAndUpdate(id, req.body, { new: true });
    if (!updatedAssessmentCycle) {
      return res.status(404).json({ message: 'Assessment Cycle not found' });
    }
    res.json(updatedAssessmentCycle);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Delete an assessment cycle by ID
exports.deleteAssessmentCycle = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedAssessmentCycle = await AssessmentCycle.findByIdAndDelete(id);
    if (!deletedAssessmentCycle) {
      return res.status(404).json({ message: 'Assessment Cycle not found' });
    }
    res.json({ message: 'Assessment Cycle deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
