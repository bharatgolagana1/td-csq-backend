const AssessmentFeedback = require('../models/assessmentFeedbackModel');
const AssessmentHistory = require('../models/assessmentHistoryModel');

// Fetch and format data for AssessmentHistory
exports.getAssessmentHistoryData = async (req, res) => {
  try {
    // Fetch all feedbacks
    const feedbacks = await AssessmentFeedback.find();

    if (feedbacks.length === 0) {
      return res.status(404).json({ message: 'No feedbacks found.' });
    }

    // Map feedbacks to AssessmentHistory format
    const assessmentHistories = feedbacks.map(feedback => ({
      cycleId: feedback.cycleId, // Assuming you want to include cycleId if it's part of the feedback
      assessmentId: feedback.assessmentId,
      assessorType: feedback.userType, // Assuming this is a constant value, adjust as needed
      assessorName: feedback.userName, // Map userName to assessorName
      assessorEmail: feedback.email, 
      submissionDate: feedback.createdAt, // Use current date and time
      feedback: feedback.finalRating,
    }));

    res.status(200).json({ message: 'Assessment histories retrieved successfully', data: assessmentHistories });
  } catch (error) {
    console.error('Error fetching assessment history:', error.message);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Get Assessment Feedback by assessmentId
exports.getAssessmentHistoryById = async (req, res) => {
  try {
      const { assessmentId } = req.params;

      // Fetch the unique assessment feedback by ID
      const feedback = await AssessmentFeedback.findOne({ assessmentId });

      if (!feedback) {
          return res.status(404).json({ message: 'Assessment feedback not found' });
      }

      // Fetch all parameters, ratings, and comments grouped by category
      const assessmentData = feedback.parameters.map(param => {
          return {
              category: param.category,
              parameter: param.name,
              rating: param.rating,
              comments: param.comments,
          };
      });

      // Group the data by categories
      const groupedData = assessmentData.reduce((acc, item) => {
          const { category } = item;
          if (!acc[category]) {
              acc[category] = [];
          }
          acc[category].push({
              parameter: item.parameter,
              rating: item.rating,
              comments: item.comments,
          });
          return acc;
      }, {});

      // Return grouped data
      res.status(200).json({
          assessmentId: feedback.assessmentId,
          assessorName: feedback.assessorName,
          feedbackData: groupedData,
      });
  } catch (error) {
      console.error('Error fetching assessment history:', error);
      res.status(500).json({ message: 'Internal server error' });
  }
};
