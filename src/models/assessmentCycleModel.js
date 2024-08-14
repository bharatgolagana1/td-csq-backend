const mongoose = require('mongoose');

const assessmentCycleSchema = new mongoose.Schema({
  initiationDate: { type: Date, required: true },
  minSamplingSize: { type: Number, required: true },
  samplingStartDate: { type: Date, required: true },
  samplingDuration: { type: Number, required: true },
  samplingEndDate: { type: Date },
  reminderCount: { type: Number, required: true },
  assessmentStartDate: { type: Date, required: true },
  assessmentDuration: { type: Number, required: true },
  assessmentEndDate: { type: Date },
  
},{timestamps: true});

assessmentCycleSchema.pre('save', async function (next) {
  // Check if there are any existing assessment cycles
  const existingCycles = await mongoose.models.AssessmentCycle.find();

  if (existingCycles.length > 0) {
    const error = new Error('An assessment cycle is already running. Only one assessment cycle can be added at a time.');
    return next(error);
  }

  next();
});

const AssessmentCycle = mongoose.model('AssessmentCycle', assessmentCycleSchema);

module.exports = AssessmentCycle;
