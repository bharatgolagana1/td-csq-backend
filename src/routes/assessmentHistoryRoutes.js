const express = require('express');
const router = express.Router();
const assessmentHistoryController = require('../controllers/assessmentHistoryController');

router.get('/history', assessmentHistoryController.getAssessmentHistoryData);
router.get('/history/:assessmentId', assessmentHistoryController.getAssessmentHistoryById);

module.exports = router;
