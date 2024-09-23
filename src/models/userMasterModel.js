const mongoose = require('mongoose');

const userMasterSchema = new mongoose.Schema({
  userid: { type: Number }, // Removed unique: true
  userType: { type: String, required: true },
  userName: { type: String, required: true },
  email: { type: String, required: true },
  mobileNo: { type: Number, required: true },
  officeName: { type: String, required: true },
  officeAddress: { type: String, required: true },
  city: { type: String, required: true },
  country: { type: String, required: true }
});

const UserMaster = mongoose.model('UserMaster', userMasterSchema);

module.exports = UserMaster;
