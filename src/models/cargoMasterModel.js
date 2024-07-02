const mongoose = require('mongoose');

const acoSchema = new mongoose.Schema({
  acoCode: { type: String, required: true },
  acoName: { type: String, required: true },
  acoAddress: { type: String, required: true },
  airportCode: { type: String, required: true },
  pincode: { type: Number, required: true },
  emailId: { type: String, required: true },
  mobileNumber: { type: Number, required: true }
});

const Aco = mongoose.model('Aco', acoSchema);

module.exports = Aco;
