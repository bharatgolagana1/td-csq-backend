const Feedback = require('../models/FeedbackModel');

// Add new feedback
exports.addFeedback = async (req, res) => {
  try {
    const newFeedback = new Feedback(req.body);
    await newFeedback.save();
    res.status(201).json(newFeedback);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
// Get all feedbacks
exports.getAllFeedbacks = async (_req, res) => {
  try {
    const feedbackList = await Feedback.find();
    res.json(feedbackList);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// Update feedback by _id
exports.updateFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const updatedFeedback = await Feedback.findByIdAndUpdate(id, req.body, { new: true });
    if (!updatedFeedback) {
      return res.status(404).json({ message: 'Feedback not found' });
    }
    res.json(updatedFeedback);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Delete feedback by _id
exports.deleteFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedFeedback = await Feedback.findByIdAndDelete(id);
    if (!deletedFeedback) {
      return res.status(404).json({ message: 'Feedback not found' });
    }
    res.json({ message: 'Feedback deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// Add subparameter to feedback
exports.addSubparameter = async (req, res) => {
  try {
    const { id } = req.params;
    const feedback = await Feedback.findById(id);
    if (!feedback) {
      return res.status(404).json({ message: 'Feedback not found' });
    }
    feedback.subParameter.push(req.body);
    await feedback.save();
    res.status(201).json(feedback);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
// Update subparameter by feedback _id and subparameter _id
exports.updateSubparameter = async (req, res) => {
  try {
    const { feedbackId, subId } = req.params;
    const feedback = await Feedback.findById(feedbackId);
    if (!feedback) {
      return res.status(404).json({ message: 'Feedback not found' });
    }
    const subparameter = feedback.subParameter.id(subId);
    if (!subparameter) {
      return res.status(404).json({ message: 'Subparameter not found' });
    }
    Object.assign(subparameter, req.body);
    await feedback.save();
    res.json(feedback);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
// Delete subparameter
exports.deleteSubparameter = async (req, res) => {
  try {
    const { feedbackId, subId } = req.params;
    const feedback = await Feedback.findById(feedbackId);
    if (!feedback) {
      return res.status(404).json({ message: 'Feedback not found' });
    }
    feedback.subParameter = feedback.subParameter.filter(sub => sub._id.toString() !== subId);
    await feedback.save();
    res.json({ message: 'Subparameter deleted' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
// Get all subparameters for a specific feedback
exports.getAllSubparameters = async (req, res) => {
  try {
    const { id } = req.params;
    const feedback = await Feedback.findById(id);
    if (!feedback) {
      return res.status(404).json({ message: 'Feedback not found' });
    }
    res.json(feedback.subParameter);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// Get all parameters and subparameters for a specific category
exports.getParametersAndSubparameters = async (req, res) => {
  const { category } = req.params;
  try {
    const feedbacks = await Feedback.find({ category });
    if (!feedbacks || feedbacks.length === 0) {
      return res.status(404).json({ message: 'No feedback found for this category' });
    }
    // Extract parameters and their subparameters with feedbackId
    const parametersWithSubparameters = feedbacks.map(feedback => ({
      feedbackId: feedback._id,
      parameter: feedback.parameter,
      subParameters: feedback.subParameter
    }));
    res.json(parametersWithSubparameters);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Delete multiple feedbacks by their IDs
exports.deleteManyFeedbacks = async (req, res) => {
  try {
    const { ids } = req.body; // Expect an array of feedback IDs in the request body
    const result = await Feedback.deleteMany({ _id: { $in: ids } });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'No feedback found to delete' });
    }
    res.json({ message: `${result.deletedCount} feedback(s) deleted successfully` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  } 
};

// Delete multiple subparameters by their IDs from a specific feedback
exports.deleteManySubparameters = async (req, res) => {
  try {
    const { feedbackId } = req.params; // Feedback ID
    const { subIds } = req.body; // Expect an array of subparameter IDs in the request body

    const feedback = await Feedback.findById(feedbackId);
    if (!feedback) {
      return res.status(404).json({ message: 'Feedback not found' });
    }

    // Filter out subparameters that are not in the provided subIds
    feedback.subParameter = feedback.subParameter.filter(sub => !subIds.includes(sub._id.toString()));

    await feedback.save();
    res.json({ message: `${subIds.length} subparameter(s) deleted successfully` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get feedback by category
exports.getFeedbackByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const feedbacks = await Feedback.find({ category });
    if (!feedbacks || feedbacks.length === 0) {
      return res.status(404).json({ message: 'No feedback found for this category' });
    }
    res.json(feedbacks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// Get all unique category names
exports.getAllCategoryNames = async (_req, res) => {
  try {
    const categories = await Feedback.distinct('category');
    if (!categories || categories.length === 0) {
      return res.status(404).json({ message: 'No categories found' });
    }
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
