const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  userName: { type: String, required: true },
  email: { type: String, required: true },
  firstName: {type: String, required: true},
  lastName: {type: String, required: true}
});


module.exports = mongoose.model('User', UserSchema);

