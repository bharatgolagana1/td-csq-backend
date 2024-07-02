const Feedback = require('../models/FeedbackModel');

exports.addFeedback = async (req, res) => {
  try {
    const newFeedback = new Feedback(req.body);
    await newFeedback.save();
    res.status(201).json(newFeedback);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.getAllFeedbacks = async (_req, res) => {
  try {
    const feedbackList = await Feedback.find();
    res.json(feedbackList);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

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

//  subparameter controllers
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

exports.getParametersAndSubparameters = async (req, res) => {
  const { category } = req.params;

  try {
    const feedbacks = await Feedback.find({ category });

    if (!feedbacks || feedbacks.length === 0) {
      return res.status(404).json({ message: 'No feedback found for this category' });
    }

    const parametersWithSubparameters = feedbacks.map(feedback => ({
      parameter: feedback.parameter,
      subParameters: feedback.subParameter
    }));

    res.json(parametersWithSubparameters);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


