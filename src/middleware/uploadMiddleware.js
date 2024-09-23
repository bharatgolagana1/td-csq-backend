// src/middleware/uploadMiddleware.js
const multer = require('multer');
const path = require('path');

// Set up storage engine
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Directory where files will be stored
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

// File filter to only allow Excel files
const fileFilter = (req, file, cb) => {
  const fileTypes = /xls|xlsx/;
  const extname = fileTypes.test(path.extname(file.originalname).toLowerCase());

  if (extname) {
    return cb(null, true);
  } else {
    cb(new Error('Only Excel files are allowed'));
  }
};

// Initialize multer with storage engine and file filter
const upload = multer({
  storage: storage,
  fileFilter: fileFilter
});

module.exports = upload;
