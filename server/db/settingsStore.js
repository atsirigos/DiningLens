const { normalizeOrientation } = require('../utils/imageRotate');
const { normalizeChargeControl } = require('../utils/chargeControlConfig');
const { normalizeVideoTargetFps } = require('../utils/videoFps');
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
  devices: [],
  defaultDeviceId: null,
  activeDeviceId: null,
  frameRotation: 0,
  /** 0 = keep native screenrecord FPS; otherwise downsample after pull. */
  videoTargetFps: 0,
  chargeControl: {
    enabled: true,
    stopAt: 80,
    startAt: 20,
  },
};

function makeDeviceId() {
  return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDevice(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : makeDeviceId();
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Phone';
  const connectionType = raw.connectionType === 'usb' ? 'usb' : 'wifi';
  const serial = typeof raw.serial === 'string' ? raw.serial.trim() : '';
  const address = typeof raw.address === 'string' ? raw.address.trim() : '';
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt.trim()
    ? raw.createdAt.trim()
    : new Date().toISOString();

  if (!serial) return null;

  return {
    id,
    name,
    connectionType,
    serial,
    address: connectionType === 'wifi' ? (address || serial) : '',
    createdAt,
  };
}

const DEFAULTS = {
  zones: [],
  referenceImage: null,
  referenceOrientation: null,
  videoZones: [],
  referenceVideo: null,
  referenceVideoOrientation: null,
  ai: { ...DEFAULT_AI },
  phone: { ...DEFAULT_PHONE },
};

function normalizePhone(phone) {
  const raw = phone || {};
  const shutterKeycodes = Array.isArray(raw.shutterKeycodes) && raw.shutterKeycodes.length
    ? raw.shutterKeycodes.map((k) => Number(k)).filter((k) => Number.isFinite(k))
    : DEFAULT_PHONE.shutterKeycodes;

  let devices = Array.isArray(raw.devices)
    ? raw.devices.map(normalizeDevice).filter(Boolean)
    : [];

  let defaultDeviceId = typeof raw.defaultDeviceId === 'string' && raw.defaultDeviceId.trim()
    ? raw.defaultDeviceId.trim()
    : null;
  let activeDeviceId = typeof raw.activeDeviceId === 'string' && raw.activeDeviceId.trim()
    ? raw.activeDeviceId.trim()
    : null;

  const legacyAddress = typeof raw.address === 'string' ? raw.address.trim() : '';

  if (!devices.length && legacyAddress) {
    const migrated = normalizeDevice({
      id: makeDeviceId(),
      name: 'Phone 1',
      connectionType: 'wifi',
      serial: legacyAddress,
      address: legacyAddress,
      createdAt: new Date().toISOString(),
    });
    if (migrated) {
      devices = [migrated];
      defaultDeviceId = migrated.id;
    }
  }

  const deviceIds = new Set(devices.map((d) => d.id));
  if (defaultDeviceId && !deviceIds.has(defaultDeviceId)) {
    defaultDeviceId = devices[0]?.id || null;
  }
  if (activeDeviceId && !deviceIds.has(activeDeviceId)) {
    activeDeviceId = null;
  }
  if (!defaultDeviceId && devices.length) {
    defaultDeviceId = devices[0].id;
  }

  return {
    adbPath: typeof raw.adbPath === 'string' ? raw.adbPath : DEFAULT_PHONE.adbPath,
    address: legacyAddress,
    dcim: typeof raw.dcim === 'string' && raw.dcim.trim()
      ? raw.dcim.trim()
      : DEFAULT_PHONE.dcim,
    shutterKeycodes,
    devices,
    defaultDeviceId,
    activeDeviceId,
    frameRotation: normalizeOrientation(raw.frameRotation),
    videoTargetFps: normalizeVideoTargetFps(
      raw.videoTargetFps ?? DEFAULT_PHONE.videoTargetFps,
    ),
    chargeControl: normalizeChargeControl(raw.chargeControl ?? DEFAULT_PHONE.chargeControl),
  };
}

function normalize(settings) {
  return {
    zones: Array.isArray(settings?.zones) ? settings.zones : DEFAULTS.zones,
    referenceImage: settings?.referenceImage ?? DEFAULTS.referenceImage,
    referenceOrientation: settings?.referenceOrientation != null
      ? normalizeOrientation(settings.referenceOrientation)
      : null,
    videoZones: Array.isArray(settings?.videoZones) ? settings.videoZones : DEFAULTS.videoZones,
    referenceVideo: settings?.referenceVideo ?? DEFAULTS.referenceVideo,
    referenceVideoOrientation: settings?.referenceVideoOrientation != null
      ? normalizeOrientation(settings.referenceVideoOrientation)
      : null,
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
  makeDeviceId,
  normalizeDevice,
};
