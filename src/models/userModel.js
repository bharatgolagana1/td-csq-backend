const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  userName: { type: String, required: true },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phoneNo: { type: Number },
  userType: { type: String },
  role: { type: String },
  profile: { type: String },
  organizationId: { 
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organizations",
    required: true
  },
  userStatus: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  gender: {
    type: String,
    enum: ['female', 'male', 'others', 'NA'],
    default: 'NA'
  },
  employeeNo: { type: String },
  identificationNo: { type: String },
  citizenship: { type: String },
  residentOf: { type: String },
  isVisitor: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);
