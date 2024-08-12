const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');


router.post('/',  userController.createUser);
router.put('/:id', userController.updateUser);
router.get('/:id', userController.getUser);
router.get('/', userController.listUsers);
router.delete('/:id',  userController.deleteUser);

module.exports = router;

