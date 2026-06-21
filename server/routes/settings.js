const path = require('path');
const fs = require('fs');
const express = require('express');

const router = express.Router();
const SETTINGS_FILE = path.join(__dirname, '..', '..', 'settings.json');

const DEFAULTS = {
  zones: [],
  commonFoods: ['Salad', 'Bread', 'Pasta', 'Vegetables', 'Water'],
  seatLayout: 2,
  referenceImage: null,
};

function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return { ...DEFAULTS };
  }
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

router.get('/settings', (req, res) => {
  try {
    res.json(readSettings());
  } catch (err) {
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

router.post('/settings', (req, res) => {
  try {
    const settings = { ...DEFAULTS, ...req.body };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = router;
