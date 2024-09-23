const Customer = require('../models/customerModel');
const xlsx = require('xlsx');
const axios = require('axios');
const { getAccessToken, } = require('../middleware/keycloakHelper'); // Assuming these are defined in userController

// Function to create user in Keycloak
async function createUserInKeycloak(userData) {
  const token = await getAccessToken();
  const updatedUserData = {
    username: userData.customerName, // Using customerName as username
    email: userData.email,
    enabled: true,
    firstName: userData.customerName, // Assuming customerName for firstName
    lastName: userData.customerName,  // Assuming customerName for lastName
    credentials: [
      {
        type: "password",
        value: "test@123", // Default password, should be updated for production
        temporary: true,   // Require user to change password on first login
      },
    ],
  };
  
  try {
    const response = await axios.post(
      `${process.env.KEYCLOAK_URL}/admin/realms/${process.env.KEYCLOAK_REALM_NAME}/users`,
      updatedUserData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("User created successfully", response.data);
  } catch (error) {
    console.error("Failed to create user in Keycloak", error);
    throw error;
  }
}

// Controller function to create customer from MongoDB in Keycloak
exports.sampleCustomerToKeycloak = async (req, res) => {
  try {
    const customerId = req.params.id;

    // Find customer by ID in MongoDB
    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    // Create user in Keycloak with the customer data
    await createUserInKeycloak(customer);

    // Respond with success message
    res.status(200).json({ message: `Customer ${customer.customerName} created in Keycloak.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};

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

exports.getCustomerById = async (req, res) => {
  try {
    const { id } = req.params;
    const customer = await Customer.findById(id);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};



// Bulk upload customers from an Excel file
exports.bulkUploadCustomers = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Load the uploaded Excel file
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Convert the sheet data to JSON
    const customers = xlsx.utils.sheet_to_json(sheet, { defval: null });

    // Log the parsed data to check its structure
    console.log('Parsed customers data:', customers);

    if (customers.length === 0) {
      return res.status(400).json({ message: 'No valid customer data found in the file' });
    }

    // Validate and format data to match the schema
    const formattedCustomers = customers.map(customer => ({
      customerType: customer.customerType,
      customerName: customer.customerName,
      email: customer.email,
      sampledDate: customer.sampledDate ? new Date(customer.sampledDate) : null
    }));

    // Insert the customer data into the database
    const savedCustomers = await Customer.insertMany(formattedCustomers);

    res.status(201).json({ message: `${savedCustomers.length} customers uploaded successfully`, savedCustomers });
  } catch (error) {
    console.error('Error during bulk upload:', error);
    res.status(500).json({ message: error.message });
  }
};