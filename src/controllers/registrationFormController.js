const Registration = require("../models/registrationFormModel"); // Your Registration MongoDB model
const axios = require("axios");
const Counter = require("../models/counterModel");
// Function to get access token from Keycloak
async function getAccessToken() {
  try {
    const response = await axios.post(
      `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM_NAME}/protocol/openid-connect/token`,
      new URLSearchParams({
        client_id: process.env.KEYCLOAK_CLIENT_ID,
        client_secret: process.env.KEYCLOAK_SECRET,
        grant_type: "client_credentials",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    return response.data.access_token;
  } catch (error) {
    console.error("Failed to get access token", error);
    throw error;
  }
}

// Function to create a user in Keycloak
async function createUserInKeycloak(userData) {
  const token = await getAccessToken();
  const keycloakUserData = {
    username: userData.email, // Using email as username
    email: userData.email,
    enabled: false, // User will be created in a disabled state
    firstName: userData.firstName,  // Use firstName from req.body
    lastName: userData.lastName,    // Use lastName from req.body
    credentials: [
      {
        type: "password",
        value: "test@123", // Temporary password
        temporary: true, // User will be prompted to change password on first login
      },
    ],
  };

  try {
    const response = await axios.post(
      `${process.env.KEYCLOAK_URL}/admin/realms/${process.env.KEYCLOAK_REALM_NAME}/users`,
      keycloakUserData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Return Keycloak user ID from the response headers
    return response.headers.location.split('/').pop();
  } catch (error) {
    console.error("Failed to create user in Keycloak", error);
    throw error;
  }
}

// Controller to handle registration
exports.registerUser = async (req, res) => {
  try {
    // Extract user data from request body
    const {
      userType, ctoCode, region, airport, ctoName, nonMember, role, referredBy, ctoMarketShare,
      country, officeName, officeAddress, city, postalCode, mobileNumber, email, businessPhone,
      firstName, lastName
    } = req.body;

    // Create a new registration document
    const registration = new Registration({
      userType, ctoCode, region, airport, ctoName, nonMember, role, referredBy, ctoMarketShare,
      country, officeName, officeAddress, city, postalCode, mobileNumber, email, businessPhone,
      firstName, lastName, isApproved: false, createdAt: new Date(),
    });

    // Save the registration
    await registration.save();

    // Create the user in Keycloak
    const keycloakUserId = await createUserInKeycloak(req.body);

    // Update the registration with the Keycloak user ID
    registration.keycloakUserId = keycloakUserId;
    await registration.save();

    res.status(201).json( registration );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};

// Controller to get all registrations
exports.getAllRegistrations = async (req, res) => {
  try {
    const registrations = await Registration.find();
    res.status(200).json({ registrations });
  } catch (error) {
    console.error("Failed to fetch all registrations", error);
    res.status(500).json({ error: "Failed to fetch registrations" });
  }
};

// Controller to get a registration by ID
exports.getRegistrationById = async (req, res) => {
  try {
    const { id } = req.params;
    const registration = await Registration.findById(id);
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }
    res.status(200).json({ registration });
  } catch (error) {
    console.error("Failed to fetch registration by ID", error);
    res.status(500).json({ error: "Failed to fetch registration" });
  }
};

exports.deleteRegistrations = async (req, res) => {
  try {
    const { ids } = req.body; 
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Please provide an array of registration IDs to delete.' });
    }
    const result = await Registration.deleteMany({ _id: { $in: ids } });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'No registrations found to delete.' });
    }
    res.json({ message: `${result.deletedCount} registrations deleted.` });
  } catch (error) {
    console.error("Error deleting registrations:", error);
    res.status(500).json({ message: error.message });
  }
};
