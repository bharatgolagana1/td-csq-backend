const express = require('express');
const router = express.Router();
const assessmentCycleController = require('../controllers/assessmentCycleController');

router.post('/Cycle', assessmentCycleController.addAssessmentCycle);
router.get('/Cycle', assessmentCycleController.cyclesList);
router.get('/Cycle/:id', assessmentCycleController.getAssessmentCycleById);
router.put('/Cycle/:id', assessmentCycleController.updateAssessmentCycle);
router.delete('/Cycle/:id', assessmentCycleController.deleteAssessmentCycle);
router.delete('/Cycles', assessmentCycleController.deleteAssessmentCycles);

module.exports = router;
