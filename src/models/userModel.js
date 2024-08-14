
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  userName: { type: String, required: true },
  firstName: {type: String, required: true},
  lastName: {type: String, required: true},
  email: { type: String, required: true, unique: true, },
  phoneNo: { type: Number,},
  OrganizationId: { type: String,},
  userType: {type: String,},
  role: { type: String,},
  profile:{ type: String,},
  userStatus: {
    type : String,
    enum: [ 'active','inactive'],
    default:'active'
  },
  gender:{
    type: String,
    enum: ['female','male','others'],
    default:'male'
  },
  employeeNo:{ type: String,},
  identificationNo:{ type: String,},
  citizenship:{ type: String,},
  residentOf:{type: String},
  isVisitor:{ type: String, default : false},
  createdAt: { type: Date, default: Date.now, },

});


module.exports = mongoose.model('User', UserSchema);

