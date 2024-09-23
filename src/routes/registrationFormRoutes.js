const express = require('express');
const router = express.Router();
const registrationFormController = require('../controllers/registrationFormController'); // Adjust the path as needed

// Route to register a new user (create a registration)
router.post('/user', registrationFormController.registerUser);
router.get('/all', registrationFormController.getAllRegistrations);
router.get('/:id', registrationFormController.getRegistrationById);
router.delete('/delete', registrationFormController.deleteRegistrations);


module.exports = router;
