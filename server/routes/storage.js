const express = require('express');
const { getStorageInfo } = require('../utils/storageInfo');

const router = express.Router();

router.get('/storage', async (req, res) => {
  try {
    res.json(await getStorageInfo());
  } catch (err) {
    console.error('storage info failed:', err);
    res.status(500).json({ error: err.message || 'Failed to read storage info' });
  }
});

module.exports = router;
