const Organizations = require("./organizationsModel");
const User = require('../../models/userModel');

exports.createOrganization = async (req, res) => {
  try {
    const { name, description, status, firstName, lastName, email } = req.body;
    const organization = new Organizations({ name, description, status });
    await organization.save();

    // Optionally create a user related to this organization (if needed)
    if (firstName && lastName && email) {
      const user = new User({ firstName, lastName, email });
      await user.save();
    }

    res.status(201).json(organization);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getOrganizations = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '' } = req.query;
    const query = { name: { $regex: search, $options: 'i' } };
    const organizations = await Organizations.find(query)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const count = await Organizations.countDocuments(query);
    res.status(200).json({
      organizations,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getOrganizationById = async (req, res) => {
  try {
    const organization = await Organizations.findById(req.params.id);
    if (!organization) {
      return res.status(404).json({ error: "Organization not found" });
    }
    res.status(200).json(organization);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.deleteOrganization = async (req, res) => {
  try {
    const organization = await Organizations.findByIdAndDelete(req.params.id);
    if (!organization) {
      return res.status(404).json({ error: "Organization not found" });
    }
    res.status(200).json({ message: "Organization deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
