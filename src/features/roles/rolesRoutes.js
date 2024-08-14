const express = require('express');
const router = express.Router();
const rolesController = require('./rolesController'); // Verify this path

router.post('/', rolesController.createRole); // Verify this is correctly defined in rolesController
router.get('/', rolesController.getRoles);
router.get('/:id', rolesController.getRoleById);

module.exports = router;
