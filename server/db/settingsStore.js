const path = require('path');
const fs = require('fs');
const { getDb } = require('./database');
const { DEFAULT_AI } = require('../utils/aiConfig');

const LEGACY_SETTINGS_FILE = path.join(__dirname, '..', '..', 'settings.json');

const DEFAULT_PHONE = {
  adbPath: '',
  address: '',
  dcim: '/sdcard/DCIM/Camera',
  shutterKeycodes: [27, 24],
};

const DEFAULTS = {
  zones: [],
  referenceImage: null,
  ai: { ...DEFAULT_AI },
  phone: { ...DEFAULT_PHONE },
};

function normalizePhone(phone) {
  const raw = phone || {};
  const shutterKeycodes = Array.isArray(raw.shutterKeycodes) && raw.shutterKeycodes.length
    ? raw.shutterKeycodes.map((k) => Number(k)).filter((k) => Number.isFinite(k))
    : DEFAULT_PHONE.shutterKeycodes;

  return {
    adbPath: typeof raw.adbPath === 'string' ? raw.adbPath : DEFAULT_PHONE.adbPath,
    address: typeof raw.address === 'string' ? raw.address : DEFAULT_PHONE.address,
    dcim: typeof raw.dcim === 'string' && raw.dcim.trim()
      ? raw.dcim.trim()
      : DEFAULT_PHONE.dcim,
    shutterKeycodes,
  };
}

function normalize(settings) {
  return {
    zones: Array.isArray(settings?.zones) ? settings.zones : DEFAULTS.zones,
    referenceImage: settings?.referenceImage ?? DEFAULTS.referenceImage,
    ai: { ...DEFAULT_AI, ...settings?.ai },
    phone: normalizePhone(settings?.phone),
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
