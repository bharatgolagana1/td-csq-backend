const AssessmentCycle = require('../models/assessmentCycleModel');

/// Add a new assessment cycle
exports.addAssessmentCycle = async (req, res) => {
  try {
    const { status } = req.body;

    // Check if there's an active assessment cycle
    if (status === 'active') {
      const activeCycle = await AssessmentCycle.findOne({ status: 'active' });
      if (activeCycle) {
        return res.status(400).json({ message: 'An active assessment cycle is already running. You cannot add another until it is complete.' });
      }
    }
    const newAssessmentCycle = new AssessmentCycle(req.body);
    await newAssessmentCycle.save();
    res.status(201).json(newAssessmentCycle);
  } catch (error) {
    res.status(400).json({ message: error.message });
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
    const { status } = req.body;

    // Prevent multiple active assessment cycles
    if (status === 'active') {
      const activeCycle = await AssessmentCycle.findOne({ status: 'active', _id: { $ne: id } });
      if (activeCycle) {
        return res.status(400).json({ message: 'Another active assessment cycle is already running. Please deactivate it before activating a new one.' });
      }
    }

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

// Delete multiple assessment cycles by IDs
exports.deleteAssessmentCycles = async (req, res) => {
  try {
    const { ids } = req.body; // Expecting an array of IDs in the request body

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Please provide an array of IDs to delete.' });
    }

    const result = await AssessmentCycle.deleteMany({ _id: { $in: ids } });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'No Assessment Cycles found to delete.' });
    }

    res.json({ message: `${result.deletedCount} Assessment Cycles deleted.` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


exports.cyclesList = async (req, res) => {
  try {
    const {
      cycleIdOrminSamplingSize,
      status,
      date,
      customDate,
      samplingStartDate, // New query parameters for sampling date range
      samplingEndDate,
      assessmentStartDate, // New query parameters for assessment date range
      assessmentEndDate,
    } = req.query;
    let query = {};

    if (cycleIdOrminSamplingSize) {
      query.$or = [
        { cycleId: new RegExp(cycleIdOrminSamplingSize, "i") },
        { minSamplingSize: new RegExp(cycleIdOrminSamplingSize, "i") },
      ];
    }
    
    if (status && status !== "All") {
      query.status = status;
    }
    if (date && date !== "All Time") {
      let dateQuery = {};
      let currentDate = moment().endOf("day");
      switch (date) {
        case "Today":
          dateQuery = {
            $gte: moment().startOf("day").toDate(),
            $lte: currentDate.toDate(),
          };
          break;
        case "Yesterday":
          dateQuery = {
            $gte: moment().subtract(1, "days").startOf("day").toDate(),
            $lte: moment().subtract(1, "days").endOf("day").toDate(),
          };
          break;
        case "This Month":
          dateQuery = {
            $gte: moment().startOf("month").toDate(),
            $lte: currentDate.toDate(),
          };
          break;
        case "Last Month":
          dateQuery = {
            $gte: moment().subtract(1, "months").startOf("month").toDate(),
            $lte: moment().subtract(1, "months").endOf("month").toDate(),
          };
          break;
        case "This Year":
          dateQuery = {
            $gte: moment().startOf("year").toDate(),
            $lte: currentDate.toDate(),
          };
          break;
      }
      query.createdAt = dateQuery;
    }

    if (customDate) {
      const selectedDate = moment(customDate).toDate();
      query.createdAt = selectedDate;
    }

    // Sampling date range filter
    if (samplingStartDate && samplingEndDate) {
      query.samplingStartDate = { $gte: new Date(samplingStartDate) };
      query.samplingEndDate = { $lte: new Date(samplingEndDate) };
    }

    // Assessment date range filter
    if (assessmentStartDate && assessmentEndDate) {
      query.assessmentStartDate = { $gte: new Date(assessmentStartDate) };
      query.assessmentEndDate = { $lte: new Date(assessmentEndDate) };
    }

    const assessmentCycles = await AssessmentCycle.find(query).sort({ createdAt: -1 });

    res.json({ assessmentCycles });
  } catch (error) {
    console.error("Error getting screens:", error);
    res.status(500).json({ error: error.message });
  }
};
