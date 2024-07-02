const Airport = require('../models/airportMasterModel');

exports.addAirport = async (req, res) => {
  try {
    const newAirport = new Airport(req.body);
    await newAirport.save();
    res.status(201).json(newAirport);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.getAllAirports = async (_req, res) => {
  try {
    const airports = await Airport.find();
    res.json(airports);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateAirport = async (req, res) => {
  try {
    const { _id } = req.params;
    const updatedAirport = await Airport.findByIdAndUpdate(_id, req.body, { new: true });
    if (!updatedAirport) {
      return res.status(404).json({ message: 'Airport not found' });
    }
    res.json(updatedAirport);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.deleteAirport = async (req, res) => {
  try {
    const { _id } = req.params;
    const deletedAirport = await Airport.findByIdAndDelete(_id);
    if (!deletedAirport) {
      return res.status(404).json({ message: 'Airport not found' });
    }
    res.json({ message: 'Airport deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
