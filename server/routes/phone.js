const express = require('express');
const {
  checkAdb,
  listDevices,
  pairDevice,
  connectDevice,
  disconnectAll,
  takePhoto,
} = require('../androidCamera');
const { installAdb } = require('../adbInstaller');
const { getSettings, saveSettings } = require('../db/settingsStore');

let installPromise = null;

const router = express.Router();

function getConnectedDevice(devices) {
  return devices.find((d) => d.state === 'device') || null;
}

function sanitizePhoneConfig(phone) {
  return {
    adbPath: phone.adbPath || '',
    address: phone.address || '',
    dcim: phone.dcim,
    shutterKeycodes: phone.shutterKeycodes,
  };
}

router.get('/phone/status', async (req, res) => {
  try {
    const adbStatus = await checkAdb();
    const settings = getSettings();
    let devices = [];
    let connected = false;
    let connectedDevice = null;

    if (adbStatus.available) {
      try {
        devices = await listDevices();
        connectedDevice = getConnectedDevice(devices);
        connected = Boolean(connectedDevice);
      } catch (err) {
        adbStatus.deviceListError = err.message;
      }
    }

    res.json({
      adbAvailable: adbStatus.available,
      adbVersion: adbStatus.version,
      adbError: adbStatus.error || adbStatus.deviceListError || null,
      connected,
      connectedDevice: connectedDevice?.serial || null,
      devices,
      address: settings.phone.address || null,
      config: sanitizePhoneConfig(settings.phone),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read phone status' });
  }
});

router.post('/phone/install-adb', async (req, res) => {
  try {
    if (!installPromise) {
      installPromise = installAdb().finally(() => {
        installPromise = null;
      });
    }
    const result = await installPromise;
    res.json({
      success: true,
      version: result.version,
      alreadyInstalled: result.alreadyInstalled,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to install ADB' });
  }
});

router.post('/phone/config', (req, res) => {
  try {
    const existing = getSettings();
    const incoming = req.body || {};

    const settings = {
      ...existing,
      phone: {
        ...existing.phone,
        ...(incoming.adbPath !== undefined ? { adbPath: String(incoming.adbPath).trim() } : {}),
        ...(incoming.dcim !== undefined ? { dcim: String(incoming.dcim).trim() } : {}),
        ...(incoming.shutterKeycodes !== undefined
          ? { shutterKeycodes: incoming.shutterKeycodes }
          : {}),
        ...(incoming.address !== undefined ? { address: String(incoming.address).trim() } : {}),
      },
    };

    const saved = saveSettings(settings);
    res.json({ success: true, config: sanitizePhoneConfig(saved.phone) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save phone config' });
  }
});

router.post('/phone/pair', async (req, res) => {
  const { host, port, code } = req.body || {};

  if (!host || !port || !code) {
    return res.status(400).json({ error: 'host, port, and code are required' });
  }

  try {
    const result = await pairDevice(host, port, code);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Pairing failed' });
  }
});

router.post('/phone/connect', async (req, res) => {
  const { host, port } = req.body || {};

  if (!host || !port) {
    return res.status(400).json({ error: 'host and port are required' });
  }

  try {
    const result = await connectDevice(host, port);
    const existing = getSettings();
    saveSettings({
      ...existing,
      phone: { ...existing.phone, address: result.address },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Connection failed' });
  }
});

router.post('/phone/disconnect', async (req, res) => {
  try {
    const result = await disconnectAll();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Disconnect failed' });
  }
});

router.post('/camera/snap', async (req, res) => {
  try {
    const { file, localPath } = await takePhoto();
    res.json({
      file,
      localPath,
      url: `/captures/${encodeURIComponent(file)}`,
    });
  } catch (err) {
    console.error('snap failed:', err);
    res.status(500).json({ error: err.message || 'Failed to take photo' });
  }
});

module.exports = router;
