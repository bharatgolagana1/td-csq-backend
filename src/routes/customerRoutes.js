const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');

router.post('/customer', customerController.addCustomer);
router.get('/customer', customerController.getAllCustomers);
router.put('/customer/:id', customerController.updateCustomer);
router.delete('/customer/:id', customerController.deleteCustomer);
router.delete('/customers',customerController.deleteCustomers);

module.exports = router;
