const mongoose = require('mongoose');

const airportSchema = new mongoose.Schema({
  airportCode: { type: String, required: true },
  airportName: { type: String, required: true },
  cityCode: { type: String, required: true },
  cityName: { type: String, required: true },
  countryCode: { type: String, required: true },
  countryName: { type: String, required: true },
  regionCode: { type: String, required: true },
  regionName: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true }
});

const Airport = mongoose.model('Airport', airportSchema);

module.exports = Airport;

