const AssessmentFeedback = require('../models/assessmentFeedbackModel');

// Controller to handle posting assessment feedback
const createAssessmentFeedback = async (req, res) => {
  try {
    const { userId, userName, userType, email, organizationId, finalRating, feedbacks } = req.body;

    // Validate required fields
    if (!userId || !organizationId || finalRating === undefined || !Array.isArray(feedbacks) || feedbacks.length === 0) {
      return res.status(400).json({ message: 'Invalid input data' });
    }

    // Find the maximum existing assessmentId
    const maxAssessment = await AssessmentFeedback.findOne({}, 'assessmentId').sort({ assessmentId: -1 }).exec();

    // Calculate nextAssessmentId
    let nextAssessmentId = 1; // Default to 1 if no existing assessmentId is found
    if (maxAssessment && maxAssessment.assessmentId !== undefined) {
      nextAssessmentId = maxAssessment.assessmentId + 1;
    }

    console.log('Next Assessment ID:', nextAssessmentId); // Debugging log

    // Create the new assessment feedback
    const newAssessmentFeedback = new AssessmentFeedback({
      assessmentId: nextAssessmentId, // Assign incremented assessmentId
      userId,
      userName, 
      userType, 
      email,
      organizationId,
      finalRating,
      feedbacks,
    });

    // Save the new assessment feedback
    const savedFeedback = await newAssessmentFeedback.save();
    return res.status(201).json({ message: 'Assessment feedback created successfully', data: savedFeedback });
  } catch (error) {
    console.error('Error creating assessment feedback:', error.message);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Controller to get all assessment feedbacks
const getAllAssessmentFeedbacks = async (req, res) => {
  try {
    const feedbacks = await AssessmentFeedback.find();
    return res.status(200).json({ message: 'Assessment feedbacks retrieved successfully', data: feedbacks });
  } catch (error) {
    console.error('Error retrieving assessment feedbacks:', error.message);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = {
  createAssessmentFeedback,
  getAllAssessmentFeedbacks,
};
