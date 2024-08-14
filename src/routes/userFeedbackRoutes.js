const express = require('express');
const router = express.Router();
const userFeedbackController = require('../controllers/userFeedbackController');
// Define route for selecting subparameters
router.post('/submit', userFeedbackController.finalSubmit);
module.exports = router;