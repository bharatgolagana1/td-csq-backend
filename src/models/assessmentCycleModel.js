const mongoose = require('mongoose');

const assessmentCycleSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'inactive'
  },
  cycleId: { type: Number, unique: true },
  initiationDuration: { type: Number, required: true },
  initiationDate: { type: Date, required: true },
  minSamplingSize: { type: Number, required: true },
  samplingStartDate: { type: Date, required: true },
  samplingEndDate: { type: Date },
  samplingReminder: { type: Date, required: true },
  assessmentDuration: { type: Number, required: true },
  assessmentStartDate: { type: Date, required: true },
  assessmentEndDate: { type: Date, required: true },
  assessmentReminder: { type: Date, required: true },
}, { timestamps: true });

// Pre-save hook to prevent multiple active assessment cycles
assessmentCycleSchema.pre('save', async function (next) {
  const newCycle = this;
  
  // Only perform check if the new cycle is set to active
  if (newCycle.status === 'active') {
    const activeCycles = await mongoose.models.AssessmentCycle.find({ status: 'active' });
    
    if (activeCycles.length > 0) {
      const error = new Error('An active assessment cycle is already running. You cannot add another active cycle until the current one is inactive.');
      return next(error);
    }
  }

  next();
});

const AssessmentCycle = mongoose.model('AssessmentCycle', assessmentCycleSchema);

module.exports = AssessmentCycle;
