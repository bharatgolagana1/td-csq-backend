const mongoose = require('mongoose');

const AssessmentFeedbackSchema = new mongoose.Schema({
  assessmentId: { type: Number, unique: true }, // Auto-incremented field
  userId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  organizationId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organizations",
  },
  cycleId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "AssessmentCycle",
  },
  userName: { type: String, required: true },
  userType: { type: String, required: true },
  email: { type: String, required: true},
  finalRating: { type: Number, required: true },
  feedbacks: [{
    feedbackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Feedback', required: true },
    rating: { type: String, required: true },
    ratingValue: { type: Number, required: true },
    comments: { type: String },
    parameter: { type: String, required: true },
    subParameters: [{
      name: { type: String, required: true },
      selected: { type: Boolean, required: true },
    }]
  }],
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('AssessmentFeedback', AssessmentFeedbackSchema);
