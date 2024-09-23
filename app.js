  const express = require('express');
  const cors = require('cors');
  const connectDB = require('./src/config/database');
  const session = require('express-session');
  const Keycloak = require('keycloak-connect');
  const dotenv = require('dotenv');
  const hasRealmRoles = require('./src/middleware/keycloakMIddleware');

  // Import route handlers
  const userMasterRoutes = require('./src/routes/userMasterRoutes');
  const airportMasterRoutes = require('./src/routes/airportMasterRoutes');
  const feedbackRoutes = require('./src/routes/feedbackRoutes');
  const customerRoutes = require('./src/routes/customerRoutes');
  const userRoutes = require('./src/routes/userRoutes');
  const assessmentCycleRoutes = require('./src/routes/assessmentCycleRoutes');
  const keycloakUserRoutes = require('./src/routes/keycloakUserRoutes');
  const rolesRoutes = require('./src/features/roles/rolesRoutes');
  const moduleRoutes = require('./src/features/modules/moduleRoutes');
  const taskRoutes = require('./src/features/tasks/taskRoutes');
  const permissionRoutes = require('./src/features/permissions/permissionRoutes');
  const organizationsRoutes = require('./src/features/organizations/organizationsRoutes');
  const ctoActivationRoutes = require('./src/routes/ctoActivationRoutes');
  const assessmentFeedbackRoutes = require('./src/routes/assessmentFeedbackRoutes');
  const assessmentHistoryRoutes = require('./src/routes/assessmentHistoryRoutes');
  const registrationFormRoutes = require('./src/routes/registrationFormRoutes');

  // Initialize environment variables
  dotenv.config({ path: './dot.env' });

  const app = express();
  const port = process.env.PORT || 5000;

  // Initialize in-memory session store
  const memoryStore = new session.MemoryStore();

  // Middleware setup
  app.use(cors());
  app.use(express.json());
  app.use(
    session({
      secret: 'random-secret',
      resave: false,
      saveUninitialized: true,
      store: memoryStore,
    })
  );

  // Initialize Keycloak middleware
  const keycloak = new Keycloak({ store: memoryStore });
  app.use(keycloak.middleware());

  // Connect to the database
  connectDB();

  // Route handlers
  app.use('/userType', userMasterRoutes);
  app.use('/air', airportMasterRoutes);
  app.use('/feedback', feedbackRoutes);
  app.use('/user', userRoutes);
  app.use('/customer', customerRoutes);
  app.use('/assessment',assessmentCycleRoutes);
  app.use("/me" , keycloakUserRoutes);
  app.use("/modules", moduleRoutes);
  app.use("/tasks", taskRoutes);
  app.use("/roles", rolesRoutes);
  app.use("/permissions", permissionRoutes);
  app.use("/organizations", organizationsRoutes);
  app.use('/cto', ctoActivationRoutes);
  app.use('/assessmentfeedback', assessmentFeedbackRoutes);
  app.use('/assessmenthistory', assessmentHistoryRoutes);
  app.use('/register', registrationFormRoutes);


  // Start the server
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${port}`);
  });
