const UserFeedback = require('../models/userFeedbackModel');
const Feedback = require('../models/FeedbackModel');
// Helper function to calculate the rating
const calculateRating = (selectedCount, totalCount) => {
  if (selectedCount === totalCount) return 5;
  if (selectedCount === totalCount - 1) return 4;
  if (selectedCount === totalCount - 2) return 3;
  if (selectedCount === totalCount - 3) return 2;
  return 1;
};
// Controller to handle final submission of feedback
exports.finalSubmit = async (req, res) => {
  try {
    const { feedbackResponses } = req.body;
    const feedbackPromises = feedbackResponses.map(async (feedback) => {
      const feedbackDoc = await Feedback.findById(feedback.feedbackId);
      if (!feedbackDoc) {
        throw new Error(`Feedback with ID ${feedback.feedbackId} not found`);
      }
      const selectedCount = feedback.subParameters.filter((sub) => sub.selected).length;
      const totalCount = feedback.subParameters.length;
      const rating = calculateRating(selectedCount, totalCount);
      const userFeedback = new UserFeedback({
        feedbackId: feedback.feedbackId,
        subParameters: feedback.subParameters,
        comments: feedback.comments,
        rating,
      });
      await userFeedback.save();
    });
    await Promise.all(feedbackPromises);
    res.status(200).json({ message: 'Feedback submitted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};