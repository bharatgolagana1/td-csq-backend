const express = require('express');
const router = express.Router();
const feedbackController = require('../controllers/feedbackController');

router.post('/feedbacks', feedbackController.addFeedback);
router.get('/feedbacks', feedbackController.getAllFeedbacks);
router.put('/feedbacks/:id', feedbackController.updateFeedback);
router.delete('/feedbacks/:id', feedbackController.deleteFeedback);
router.get('/feedbacks/category/:category', feedbackController.getParametersAndSubparameters);

router.post('/feedbacks/:id/subparameters', feedbackController.addSubparameter);
router.get('/feedbacks/:id/subparameters', feedbackController.getAllSubparameters);
router.put('/feedbacks/:feedbackId/subparameters/:subId', feedbackController.updateSubparameter);
router.delete('/feedbacks/:feedbackId/subparameters/:subId', feedbackController.deleteSubparameter);


module.exports = router;
