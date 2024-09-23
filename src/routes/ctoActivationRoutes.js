const express = require('express');
const router = express.Router();
const ctoActivationController = require('../controllers/ctoActivationController');

// Route to fetch all registrations for activation
router.get('/registrations', ctoActivationController.getAllRegistrationsForActivation);
router.get('/registrations/:id', ctoActivationController.getRegistrationForActivationById);
// Route to activate a user by ID
router.put('/activate/:id', ctoActivationController.activateUser);

module.exports = router;
