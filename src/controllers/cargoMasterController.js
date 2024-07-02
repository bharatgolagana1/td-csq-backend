const Aco = require('../models/cargoMasterModel');

exports.addAco = async (req, res) => {
  try {
    const newAco = new Aco(req.body);
    await newAco.save();
    res.status(201).json(newAco);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.getAllAco = async (_req, res) => {
  try {
    const acoList = await Aco.find();
    res.json(acoList);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateAco = async (req, res) => {
  try {
    const { id } = req.params;
    const updatedAco = await Aco.findByIdAndUpdate(id, req.body, { new: true });
    if (!updatedAco) {
      return res.status(404).json({ message: 'Aco not found' });
    }
    res.json(updatedAco);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.deleteAco = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedAco = await Aco.findByIdAndDelete(id);
    if (!deletedAco) {
      return res.status(404).json({ message: 'Aco not found' });
    }
    res.json({ message: 'Aco deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
