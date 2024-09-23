const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  customerType: { type: String, required: true },
  customerName: { type: String, required: true },
  email: { type: String, required: true },
  role: { type: String, default: 'Customer' },
  sampledDate:{ type: Date, },
  organizationId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organizations",
  },
  cycleId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "AssessmentCycle",
  },
  createdAt: { type: Date, default: Date.now }
});

const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;