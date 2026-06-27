const express = require('express');
const { AI_PROVIDERS, DEFAULT_AI } = require('../utils/aiConfig');
const { DEFAULTS, getSettings, saveSettings } = require('../db/settingsStore');

const router = express.Router();

function sanitizeForClient(settings) {
  const { ai, ...rest } = settings;
  return {
    ...rest,
    ai: {
      provider: ai.provider,
      model: ai.model,
      apiKeySet: Boolean(ai.apiKey?.trim()),
    },
    aiProviders: AI_PROVIDERS,
  };
}

router.get('/settings', (req, res) => {
  try {
    res.json(sanitizeForClient(getSettings()));
  } catch (err) {
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

router.post('/settings', (req, res) => {
  try {
    const existing = getSettings();
    const incoming = req.body || {};

    const settings = {
      ...DEFAULTS,
      ...incoming,
      ai: {
        ...DEFAULT_AI,
        ...existing.ai,
        ...incoming.ai,
      },
      phone: {
        ...existing.phone,
        ...incoming.phone,
      },
    };

    const newKey = incoming.ai?.apiKey?.trim();
    if (newKey) {
      settings.ai.apiKey = newKey;
    } else {
      settings.ai.apiKey = existing.ai.apiKey || '';
    }

    const saved = saveSettings(settings);
    res.json(sanitizeForClient(saved));
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = router;
