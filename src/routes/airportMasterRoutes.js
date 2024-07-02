const express = require('express');
const router = express.Router();
const airportMasterController = require('../controllers/airportMasterController');

router.post('/airports', airportMasterController.addAirport);
router.get('/airports', airportMasterController.getAllAirports);
router.put('/airports/:_id', airportMasterController.updateAirport);
router.delete('/airports/:_id', airportMasterController.deleteAirport);

module.exports = router;
