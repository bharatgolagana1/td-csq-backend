const express = require('express');
const router = express.Router();
const cargoMasterController = require('../controllers/cargoMasterController');

router.post('/aco', cargoMasterController.addAco);
router.get('/aco', cargoMasterController.getAllAco);
router.put('/aco/:id', cargoMasterController.updateAco);
router.delete('/aco/:id', cargoMasterController.deleteAco);

module.exports = router;
