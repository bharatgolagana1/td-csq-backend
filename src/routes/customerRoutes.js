// src/routes/customerRoutes.js
const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');
const upload = require('../middleware/uploadMiddleware');

router.post('/customer', customerController.addCustomer);
router.get('/customer', customerController.getAllCustomers);
router.get('/customer/:id', customerController.getCustomerById);
router.put('/customer/:id', customerController.updateCustomer);
router.delete('/customer/:id', customerController.deleteCustomer);
router.delete('/customers', customerController.deleteCustomers);

// Add this route for bulk upload
router.post('/customer/bulk-upload', upload.single('file'), customerController.bulkUploadCustomers);
// Sample customers and post them to Keycloak
router.post('/sampleCustomer/:id', customerController.sampleCustomerToKeycloak);
module.exports = router;
