const express = require('express');
const router = express.Router();
const userTypeMasterController = require('../controllers/userTypeMasterController');

router.post('/data', userTypeMasterController.addData);
router.get('/data', userTypeMasterController.getAllData);
router.put('/data/:_id', userTypeMasterController.updateData);
router.delete('/data/:_id', userTypeMasterController.deleteData);

module.exports = router;
