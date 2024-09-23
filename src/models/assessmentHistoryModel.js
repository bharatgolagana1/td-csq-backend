const mongoose = require('mongoose');

const AssessmentHistorySchema = new mongoose.Schema({
  organizationId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organizations",
  },
  cycleId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "AssessmentCycle",
  }, 
  assessmentId: { type: Number, required: true },
  assessorType: { type: String, required: true },
  assessorName: { type: String, required: true },
  assessorEmail: { type: String, required: true },
  submissionDate: { type: String, required: true },
  feedback: { type: String, required: true}
}); 

module.exports = mongoose.model('AssessmentHistory', AssessmentHistorySchema);
