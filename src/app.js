const express = require('express');
const cors = require('cors');
const connectDB = require('./config/database');
const userTypeMasterRoutes = require('./routes/userTypeMasterRoutes');
const cargoMasterRoutes = require('./routes/cargoMasterRoutes');
const airporMasterRoutes = require('./routes/airportMasterRoutes');
const feedbackRoutes = require('./routes/feedbackRoutes');
const customerRoutes = require('./routes/customerRoutes');


const app = express();
const port = 5000;

// Connect to database
connectDB();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/user', userTypeMasterRoutes);
app.use('/cargo', cargoMasterRoutes);
app.use('/air', airporMasterRoutes);
app.use('/feedback', feedbackRoutes);
app.use('/customer', customerRoutes);

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${port}`);
});
