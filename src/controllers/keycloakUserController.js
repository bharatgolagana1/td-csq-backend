const mongoose = require('mongoose');
const tokenValidator = require('../middleware/auth');
const User = require('../models/userModel');
const Registration = require('../models/registrationFormModel'); // Import the Registration model
const Permission = require('../features/permissions/permissionModel');
const Role = require('../features/roles/rolesModel');

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

  const { email } = payload;

  if (!email) {
    return res.status(400).json({ message: 'Email not found in token' });
  }

  try {
    // Attempt to find the user in the User collection
    let user = await User.findOne({ email }).populate('role');
    let registration;

    // If not found in User collection, attempt to find in Registration collection
    if (!user) {
      registration = await Registration.findOne({ email });

      if (!registration) {
        return res.status(404).json({ message: 'User or registration details not found' });
      }

      // Combine registration details into a user profile object
      user = {
        _id: registration._id,
        userName: registration.ctoName,
        firstName: registration.ctoName, // Assuming `ctoName` as the first name
        lastName: '', // No last name in registration, set as empty
        email: registration.email,
        phoneNo: registration.mobileNumber,
        organizationId: '', // No organization ID in registration
        userType: registration.userType,
        role: registration.role,
        profile: '', // No profile in registration
        userStatus: registration.isApproved ? 'active' : 'inactive',
        gender: '', // No gender in registration
        employeeNo: '', // No employee number in registration
        identificationNo: '', // No identification number in registration
        citizenship: '', // No citizenship in registration
        residentOf: '', // No resident of in registration
        isVisitor: false // No visitor status in registration
      };
    }

    const { role } = user;

    if (!role) {
      return res.status(400).json({ message: 'User role not found' });
    }

    // Find the role document by name
    const roleDoc = await Role.findOne({ name: role });

    if (!roleDoc) {
      return res.status(404).json({ message: 'Role not found' });
    }

    // Fetch permissions based on the role's ObjectId
    const permissions = await Permission.aggregate([
      {
        $match: { roleId: roleDoc._id }
      },
      {
        $lookup: {
          from: "roles",
          localField: "roleId",
          foreignField: "_id",
          as: "role"
        }
      },
      {
        $unwind: "$role"
      },
      {
        $lookup: {
          from: "tasks",
          localField: "taskId",
          foreignField: "_id",
          as: "task"
        }
      },
      {
        $unwind: "$task"
      },
      {
        $project: {
          _id: 0,
          roleId: "$role._id",
          roleName: "$role.name",
          taskId: "$task._id",
          taskName: "$task.name",
          taskValue: "$task.task_value",
          enable: 1
        }
      }
    ]);

    res.json({ 
      userId: user._id,
      userName: user.userName,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phoneNo: user.phoneNo,
      organizationId: user.organizationId,
      userType: user.userType,
      role: user.role,
      profile: user.profile,
      userStatus: user.userStatus,
      gender: user.gender,
      employeeNo: user.employeeNo,
      identificationNo: user.identificationNo,
      citizenship: user.citizenship,
      residentOf: user.residentOf,
      isVisitor: user.isVisitor,
      permissions // Include permissions based on user's role in the response
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { getUserProfile };