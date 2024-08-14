const express = require('express');
const router = express.Router();
const keycloakUserController = require('../controllers/keycloakUserController');

router.get('/', keycloakUserController.getUserProfile);

module.exports = router;
