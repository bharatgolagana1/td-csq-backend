const tokenValidator = require('../middleware/auth');
const User = require('../models/userModel');

const getUserProfile = async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: 'Authorization header missing' });
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Token missing from Authorization header' });
  }

  const payload = tokenValidator(req);

  if (!payload) {
    return res.status(401).json({ message: 'Invalid token' });
  }

  // Ensure payload contains an email
  const { email } = payload;

  if (!email) {
    return res.status(400).json({ message: 'Email not found in token' });
  }

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const { 
      userName,
      firstName,
      lastName,
      phoneNo,
      OrganizationId,
      userType,
      role,
      profile,
      userStatus,
      gender,
      employeeNo,
      identificationNo,
      citizenship,
      residentOf,
      isVisitor,
    } = user;

    res.json({ 
      userName,
      firstName,
      lastName,
      email,
      phoneNo,
      OrganizationId,
      userType,
      role,
      profile,
      userStatus,
      gender,
      employeeNo,
      identificationNo,
      citizenship,
      residentOf,
      isVisitor,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { getUserProfile };
