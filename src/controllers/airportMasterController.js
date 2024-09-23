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

exports.getAirportById = async (req, res) => {
  try {
    const { id } = req.params;
    const airport = await Airport.findById(id);
    if (!airport) {
      return res.status(404).json({ message: 'Airport not found' });
    }
    res.json(airport);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteAirports = async (req, res) => {
  try {
    const { ids } = req.body; // Expecting an array of IDs in the request body
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Please provide an array of IDs to delete.' });
    }
    const result = await Airport.deleteMany({ _id: { $in: ids } });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'No airports found to delete.' });
    }
    res.json({ message: `${result.deletedCount} airports deleted.` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};