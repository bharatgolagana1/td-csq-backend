const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Define a schema for counters
const counterSchema = new Schema({
  _id: { type: String, required: true },
  sequence_value: { type: Number, default: 0 }
});

// Create a model for the counter
const Counter = mongoose.model('Counter', counterSchema);

module.exports = Counter;
