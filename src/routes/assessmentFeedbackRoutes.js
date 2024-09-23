const express = require('express');
const router = express.Router();
const assessmentfeedbackController = require('../controllers/assessmentFeedbackController');

router.post('/submit', assessmentfeedbackController.createAssessmentFeedback);
router.get('/get', assessmentfeedbackController.getAllAssessmentFeedbacks);

module.exports = router;
