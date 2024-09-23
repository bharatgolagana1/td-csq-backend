const express = require('express');
const router = express.Router();
const feedbackController = require('../controllers/feedbackController');

router.post('/feedbacks', feedbackController.addFeedback);
router.get('/feedbacks', feedbackController.getAllFeedbacks);
router.put('/feedbacks/:id', feedbackController.updateFeedback);
router.delete('/feedbacks/:id', feedbackController.deleteFeedback);
router.get('/feedbacks/categorys/:category', feedbackController.getParametersAndSubparameters);
router.post('/feedbacks/:id/subparameters', feedbackController.addSubparameter);
router.get('/feedbacks/:id/subparameters', feedbackController.getAllSubparameters);
router.put('/feedbacks/:feedbackId/subparameters/:subId', feedbackController.updateSubparameter);
router.delete('/feedbacks/:feedbackId/subparameters/:subId', feedbackController.deleteSubparameter);
router.delete('/feedbacks/:feedbackId/subparameters', feedbackController.deleteManySubparameters);
router.delete('/feedbacks', feedbackController.deleteManyFeedbacks);
// Get feedback by category
router.get('/feedback/category/:category', feedbackController.getFeedbackByCategory);
// Get all category names
router.get('/feedback/categories', feedbackController.getAllCategoryNames);


module.exports = router;