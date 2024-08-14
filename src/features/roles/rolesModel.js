const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
    name: { type: String, required: true},
    description: {type: String},
    internal: {type: Boolean, default: false}
});

const Role = mongoose.model('Role', roleSchema);

module.exports = Role;