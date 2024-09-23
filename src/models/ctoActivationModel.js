const mongoose = require('mongoose');

const ctoActivationSchema = new mongoose.Schema({
  requestId: { 
    type: String, unique: true,      
  },
  organizationId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organizations",
  },
  assignedDate: { 
    type: Date, 
    default: function() { 
      return this.createdAt;  // Use createdAt as assignedDate
    } 
  },
  requestFor: { type: String, required: true },
  requestType: { type: String, required: true },
  email: { type: String, required: true },
  mobile: { type: Number, required: true },
  nonMember: { type: String, required: true, default: 'N' }, // Added nonMember field
  comments: { type: String, required: true },
}, { timestamps: true }); // Automatically adds createdAt and updatedAt

const CtoActivation = mongoose.model('CtoActivation', ctoActivationSchema);

module.exports = CtoActivation;
