const User = require("../models/userModel");
const axios = require("axios");

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

async function createUserInKeycloak(userData) {
  const token = await getAccessToken();
  const updatedUserData = {
    username: userData.userName,
    email: userData.email,
    enabled: true,
    firstName: userData.firstName,
    lastName: userData.lastName,
    credentials: [
      {
        type: "password",
        value: "test@123",
        temporary: true,
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
    console.error("Failed to create user", error);
    throw error;
  }
}
exports.createUser = async (req, res) => {
  try {
    const {
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
      isVisitor
    } = req.body;

    const user = new User({
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

    await createUserInKeycloak(user); // Assuming this function handles Keycloak user creation
    const savedUser = await user.save();

    res.status(201).json({ user: savedUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { ...updateParams } = req.body;

    const updatedUser = await User.findByIdAndUpdate(id, updateParams, { new: true });

    if (!updatedUser) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user: updatedUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
};

exports.getUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
};

exports.listUsers = async (req, res) => {
  try {
    const { pageIndex = 0, pageSize = 10, search = "", sortBy = "updatedAt", sortOrder = "desc" } = req.query;
    const skip = pageIndex * pageSize;
    const limit = parseInt(pageSize);

    const query = {
      $or: [
        { userName: { $regex: search, $options: "i" } },
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ],
    };

    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const users = await User.find(query).sort(sort).skip(skip).limit(limit);
    const totalUsers = await User.countDocuments(query);

    res.json({ users, totalUsers, pageIndex: parseInt(pageIndex), pageSize: parseInt(pageSize) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedUser = await User.findByIdAndDelete(id);

    if (!deletedUser) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ message: "User deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};
