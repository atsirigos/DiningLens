const express = require('express');
const { getUsageSummary, clearUsageLog } = require('../db/apiUsageStore');

const router = express.Router();

router.get('/usage', (req, res) => {
  try {
    res.json(getUsageSummary());
  } catch (err) {
    res.status(500).json({ error: 'Failed to read API usage' });
  }
});

router.delete('/usage', (req, res) => {
  try {
    clearUsageLog();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear API usage log' });
  }
});

module.exports = router;
