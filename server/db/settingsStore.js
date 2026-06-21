const path = require('path');
const fs = require('fs');
const { getDb } = require('./database');
const { DEFAULT_AI } = require('../utils/aiConfig');

const LEGACY_SETTINGS_FILE = path.join(__dirname, '..', '..', 'settings.json');

const DEFAULTS = {
  zones: [],
  commonFoods: ['Salad', 'Bread', 'Pasta', 'Vegetables', 'Water'],
  seatLayout: 2,
  referenceImage: null,
  ai: { ...DEFAULT_AI },
};

function normalize(settings) {
  return {
    ...DEFAULTS,
    ...settings,
    ai: { ...DEFAULT_AI, ...settings?.ai },
  };
}

function readLegacyFile() {
  if (!fs.existsSync(LEGACY_SETTINGS_FILE)) return null;
  try {
    return normalize(JSON.parse(fs.readFileSync(LEGACY_SETTINGS_FILE, 'utf8')));
  } catch {
    return null;
  }
}

function migrateLegacySettings() {
  const database = getDb();
  const existing = database.prepare('SELECT id FROM app_settings WHERE id = 1').get();
  if (existing) return;

  const legacy = readLegacyFile();
  const settings = legacy || { ...DEFAULTS, ai: { ...DEFAULT_AI } };

  database.prepare(`
    INSERT INTO app_settings (id, data, updated_at)
    VALUES (1, ?, datetime('now'))
  `).run(JSON.stringify(settings));
}

function getSettings() {
  migrateLegacySettings();

  const database = getDb();
  const row = database.prepare('SELECT data FROM app_settings WHERE id = 1').get();

  if (!row) {
    const settings = { ...DEFAULTS, ai: { ...DEFAULT_AI } };
    saveSettings(settings);
    return settings;
  }

  return normalize(JSON.parse(row.data));
}

function saveSettings(settings) {
  const normalized = normalize(settings);

  const database = getDb();
  database.prepare(`
    INSERT INTO app_settings (id, data, updated_at)
    VALUES (1, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `).run(JSON.stringify(normalized));

  return normalized;
}

module.exports = {
  DEFAULTS,
  getSettings,
  saveSettings,
};
