const express = require('express');
const router = express.Router();
const airportMasterController = require('../controllers/airportMasterController');

router.post('/airports', airportMasterController.addAirport);
router.get('/airports', airportMasterController.getAllAirports);
router.put('/airports/:_id', airportMasterController.updateAirport);
router.delete('/airports/:_id', airportMasterController.deleteAirport);
router.get('/airports/:id', airportMasterController.getAirportById);
router.delete('/airports/', airportMasterController.deleteAirports);

module.exports = router;
