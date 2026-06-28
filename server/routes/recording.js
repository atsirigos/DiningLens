const express = require('express');
const {
  startRecording,
  stopRecording,
  getStatus,
} = require('../recordingManager');

const router = express.Router();

router.get('/recording/status', (req, res) => {
  try {
    res.json(getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read recording status' });
  }
});

router.post('/recording/start', async (req, res) => {
  try {
    const status = await startRecording(req.body || {});
    res.json(status);
  } catch (err) {
    console.error('recording start failed:', err);
    res.status(500).json({ error: err.message || 'Failed to start recording' });
  }
});

router.post('/recording/stop', (req, res) => {
  try {
    res.json(stopRecording());
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to stop recording' });
  }
});

module.exports = router;
