const Customer = require('../models/customerModel');

exports.addCustomer = async (req, res) => {
  try {
    const newCustomer = new Customer(req.body);
    await newCustomer.save();
    res.status(201).json(newCustomer);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.getAllCustomers = async (_req, res) => {
  try {
    const customerList = await Customer.find();
    res.json(customerList);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const updatedCustomer = await Customer.findByIdAndUpdate(id, req.body, { new: true });
    if (!updatedCustomer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    res.json(updatedCustomer);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.deleteCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedCustomer = await Customer.findByIdAndDelete(id);
    if (!deletedCustomer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    res.json({ message: 'Customer deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteCustomers = async (req, res) => {
  try {
    const { ids } = req.body; 
    const deletedCustomers = await Customer.deleteMany({
      _id: { $in: ids }
    });
    
    if (deletedCustomers.deletedCount === 0) {
      return res.status(404).json({ message: 'No customers found' });
    }

    res.json({ message: `${deletedCustomers.deletedCount} customer(s) deleted` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

