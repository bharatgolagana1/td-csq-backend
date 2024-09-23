const CtoActivation = require('../models/ctoActivationModel');
const Registration = require('../models/registrationFormModel');
const axios = require('axios');
const { getAccessToken } = require('../middleware/keycloakHelper');

// Fetch all registrations and map them to the ctoActivation schema
exports.getAllRegistrationsForActivation = async (req, res) => {
  try {
    const registrations = await Registration.find({ isApproved: false });
    if (registrations.length === 0) {
      return res.status(404).json({ message: 'No registrations found for activation.' });
    }
    
    const activationData = registrations.map(reg => ({
      _id: reg._id,
      requestId: reg.regId,  // Use regId from the registration model
      assignedDate: reg.createdAt,
      requestFor: reg.ctoName,
      requestType: 'Activation',
      email: reg.email,
      mobile: reg.mobileNumber,
      nonMember: reg.nonMember === 'Y' ? 'Y' : 'N',
      comments: 'Pending approval',
    }));

    res.status(200).json(activationData);
  } catch (error) {
    console.error("Failed to fetch registrations for activation", error);
    res.status(500).json({ error: "Failed to fetch activation data" });
  }
};

// Activate user by updating isApproved and enabling the user in Keycloak
exports.activateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const registration = await Registration.findById(id);

    if (!registration) {
      return res.status(404).json({ error: 'Registration not found.' });
    }

    if (registration.isApproved) {
      return res.status(400).json({ error: 'User is already approved.' });
    }

    const keycloakUserId = registration.keycloakUserId;
    if (!keycloakUserId) {
      return res.status(400).json({ error: 'Keycloak user ID is not set.' });
    }

    const token = await getAccessToken();
    await axios.put(
      `${process.env.KEYCLOAK_URL}/admin/realms/${process.env.KEYCLOAK_REALM_NAME}/users/${keycloakUserId}`,
      { enabled: true },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    registration.isApproved = true;
    await registration.save();

    const ctoActivation = new CtoActivation({
      requestFor: registration.ctoName,
      requestType: 'Activation',
      email: registration.email,
      mobile: registration.mobileNumber,
      nonMember: registration.nonMember,
      comments: 'User activated successfully.',
      assignedDate: registration.createdAt,
    });

    await ctoActivation.save();

    res.status(200).json({ message: 'User activated successfully!', ctoActivation });
  } catch (error) {
    console.error("Failed to activate user", error);

    if (error.response && error.response.data) {
      return res.status(error.response.status).json({ error: error.response.data });
    }

    res.status(500).json({ error: "Failed to activate user." });
  }
};


// Fetch a specific registration for activation by ID
exports.getRegistrationForActivationById = async (req, res) => {
  try {
    const { id } = req.params; // Get ID from request parameters

    // Find the registration by ID
    const registration = await Registration.findById(id);

    // Check if the registration exists
    if (!registration) {
      return res.status(404).json({ message: 'Registration not found.' });
    }

    // Map the registration to the activation data format
    const activationData = {
      _id: registration._id,
      requestId: registration.regId,  // Use regId from the registration model
      assignedDate: registration.createdAt,
      requestFor: registration.ctoName,
      requestType: 'Activation',
      email: registration.email,
      mobile: registration.mobileNumber,
      nonMember: registration.nonMember === 'Y' ? 'Y' : 'N',
      comments: 'Pending approval',
    };

    // Return the activation data
    res.status(200).json(activationData);
  } catch (error) {
    console.error("Failed to fetch registration for activation", error);
    res.status(500).json({ error: "Failed to fetch registration data." });
  }
};
