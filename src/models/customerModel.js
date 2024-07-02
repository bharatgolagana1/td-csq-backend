const mongoose = require('mongoose');

// Helper function to convert dd/mm/yyyy string to Date object
const convertToDate = (dateString) => {
  const [day, month, year] = dateString.split('/');
  return new Date(`${year}-${month}-${day}`);
};

const customerSchema = new mongoose.Schema({
  customerType: { type: String, required: true },
  customerName: { type: String, required: true },
  airportCode: { type: String, required: true },
  email: { type: String, required: true },
  currentSamplingDate: {
    type: Date,
    required: true,
    set: convertToDate
  },
  previousSamplingDate: {
    type: Date,
    required: true,
    set: convertToDate
  }
});

const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;
