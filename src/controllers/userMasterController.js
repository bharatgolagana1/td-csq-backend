// src/controllers/userMasterController.js
const UserMaster = require('../models/userMasterModel'); // Updated model import
const xlsx = require('xlsx');

// Add Data Entry
exports.addData = async (req, res) => {
  try {
    const newData = new UserMaster(req.body); // Use UserMaster model
    await newData.save();
    res.status(201).json(newData);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Get All Data Entries
exports.getAllData = async (_req, res) => {
  try {
    const data = await UserMaster.find(); // Use UserMaster model
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get Data by ID
exports.getDataById = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await UserMaster.findById(id); // Use UserMaster model
    if (!data) {
      return res.status(404).json({ message: 'Data not found' });
    }
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update Data Entry
exports.updateData = async (req, res) => {
  try {
    const { id } = req.params;
    const updatedData = await UserMaster.findByIdAndUpdate(id, req.body, { new: true }); // Use UserMaster model
    if (!updatedData) {
      return res.status(404).json({ message: 'Data not found' });
    }
    res.json(updatedData);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Delete Data Entry
exports.deleteData = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedData = await UserMaster.findByIdAndDelete(id); // Use UserMaster model
    if (!deletedData) {
      return res.status(404).json({ message: 'Data not found' });
    }
    res.json({ message: 'Data deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Delete Multiple Data Entries
exports.deleteDataEntries = async (req, res) => {
  try {
    const { ids } = req.body; 
    const deletedEntries = await UserMaster.deleteMany({ // Use UserMaster model
      _id: { $in: ids }
    });
    
    if (deletedEntries.deletedCount === 0) {
      return res.status(404).json({ message: 'No data found' });
    }

    res.json({ message: `${deletedEntries.deletedCount} data entries deleted` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Bulk Upload Data Entries from an Excel file
exports.bulkUploadData = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Load the uploaded Excel file
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Convert the sheet data to JSON
    const dataEntries = xlsx.utils.sheet_to_json(sheet, { defval: null });

    // Log the parsed data to check its structure
    console.log('Parsed data entries:', dataEntries);

    if (dataEntries.length === 0) {
      return res.status(400).json({ message: 'No valid data found in the file' });
    }

    // Validate and format data to match the schema
    const formattedDataEntries = dataEntries.map(entry => ({
      userType: entry.userType,
      userName: entry.userName,
      email: entry.email,
      mobileNo: entry.mobileNo,
      officeName: entry.officeName,
      officeAddress: entry.officeAddress,
      city: entry.city,
      country: entry.country
    }));

    // Insert the data entries into the database
    const savedDataEntries = await UserMaster.insertMany(formattedDataEntries); // Use UserMaster model

    res.status(201).json({ message: `${savedDataEntries.length} data entries uploaded successfully`, savedDataEntries });
  } catch (error) {
    console.error('Error during bulk upload:', error);
    res.status(500).json({ message: error.message });
  }
};
