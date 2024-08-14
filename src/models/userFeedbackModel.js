const mongoose = require('mongoose');
const UserFeedbackSchema = new mongoose.Schema({
  feedbackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Feedback', required: true },
  userName: { type: String, required: true, default: 'pavan' },
  subParameters: [{
    name: { type: String, required: true },
    selected: { type: Boolean, required: true }
  }],
  comments: { type: String, required: false },
  rating: { type: String, required: true }
}, { timestamps: true });
module.exports = mongoose.model('UserFeedback', UserFeedbackSchema);