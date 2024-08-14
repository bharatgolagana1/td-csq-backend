const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  customerType: { type: String, required: true },
  customerName: { type: String, required: true },
  email: { type: String, required: true },
  sampledDate:{ type: Date, },
  createdAt: { type: Date, default: Date.now }
});

const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;