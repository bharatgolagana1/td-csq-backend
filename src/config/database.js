const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect('mongodb+srv://user1:userpass1@cluster0.meowig8.mongodb.net/logins?retryWrites=true&w=majority&appName=Cluster0');
    console.log('MongoDB connected...');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
  }
};

module.exports = connectDB;
