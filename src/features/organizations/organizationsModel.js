const mongoose = require("mongoose");

const organizationsSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
    required: true,
  },
});

const Organizations = mongoose.model("Organizations", organizationsSchema); 

module.exports = Organizations;
