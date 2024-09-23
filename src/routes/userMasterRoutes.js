// src/routes/userMasterRoutes.js
const express = require('express');
const router = express.Router();
const userMasterController = require('../controllers/userMasterController'); // Updated controller import
const upload = require('../middleware/uploadMiddleware');

// Updated route definitions to use the new userMasterController
router.post('/data', userMasterController.addData);
router.get('/data', userMasterController.getAllData);
router.get('/data/:id', userMasterController.getDataById);
router.put('/data/:id', userMasterController.updateData);
router.delete('/data/:id', userMasterController.deleteData);

// Routes for deleting multiple entries and bulk upload
router.delete('/data', userMasterController.deleteDataEntries);
router.post('/data/bulk-upload', upload.single('file'), userMasterController.bulkUploadData);

module.exports = router;
