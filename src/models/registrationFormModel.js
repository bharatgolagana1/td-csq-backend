const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const Counter = require('./counterModel'); 


// Define a schema for registrations
const registrationSchema = new Schema({
  regId: { type: Number, unique: true }, 
  organizationId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organizations",
  },
  userType: { type: String, required: true },
  ctoCode: { type: String, required: true },
  region: { type: String, required: true },
  airport: { type: String, required: true },
  ctoName: { type: String, required: true },
  nonMember: { type: String, enum: ['Y', 'N'], default: 'N', required: true },
  role: { type: String, default: 'CTO' },
  referredBy: { type: String, required: true },
  ctoMarketShare: { type: String, required: true },
  country: { type: String, required: true },
  officeName: { type: String, required: true },
  officeAddress: { type: String, required: true },
  city: { type: String, required: true },
  postalCode: { type: String, required: true },
  mobileNumber: { type: Number, required: true },
  email: { type: String, required: true },
  businessPhone: { type: Number, required: true },
  isApproved: { type: Boolean, default: false }, // Approval status
  keycloakUserId: { type: String }, // Keycloak user ID
  firstName: { type: String, required: true }, // New firstName field
  lastName: { type: String, required: true },  // New lastName field
  createdAt: { type: Date, default: Date.now }, // New createdAt field
});

// Pre-save hook to auto-increment regId
registrationSchema.pre('save', async function(next) {
  if (this.isNew) {
    try {
      // Find or create a counter
      const counter = await Counter.findByIdAndUpdate(
        { _id: 'regId' },
        { $inc: { sequence_value: 1 } },
        { new: true, upsert: true }
      );
      
      this.regId = counter.sequence_value;

      next();
    } catch (error) {
      next(error);
    }
  } else {
    next();
  }
});

// Post-remove hook to reset the counter if no documents are left
registrationSchema.post('remove', async function(doc) {
  try {
    const count = await Registration.countDocuments();
    if (count === 0) {
      await Counter.findByIdAndUpdate(
        { _id: 'regId' },
        { sequence_value: 0 }
      );
    }
  } catch (error) {
    console.error('Error resetting counter:', error);
  }
});

const Registration = mongoose.model('Registration', registrationSchema);

module.exports = Registration;
