const mongoose = require('mongoose');
const SubparameterSchema = new mongoose.Schema({
  name: { type: String, required: true }
});
const FeedbackSchema = new mongoose.Schema({
  category: { type: String, required: true },
  subCategory: { type: String, required: true },
  parameter: { type: String, required: true },
  frequency: { type: String },
  weightage: { type: Number },
  subParameter: [SubparameterSchema],
  organizationId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organizations",
  }
});
module.exports = mongoose.model('Feedback', FeedbackSchema);