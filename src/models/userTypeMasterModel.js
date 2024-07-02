const mongoose = require('mongoose');
const AutoIncrement = require('mongoose-sequence')(mongoose);

const dataSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  userType: { type: String, required: true },
  accFlag: { 
    type: String, 
    required: true,
    validate: {
      validator: function(v) { return v.length === 1; },
      message: props => `${props.value} is not a valid single character!`
    }
  }
});

dataSchema.plugin(AutoIncrement, { inc_field: 'id' });

const Data = mongoose.model('Data', dataSchema);

module.exports = Data;
