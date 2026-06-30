const express = require('express');
const {
  checkAdb,
  listDevices,
  pairDevice,
  connectDevice,
  disconnectAll,
  disconnectDevice,
  takePhoto,
  getActiveDevice,
} = require('../androidCamera');
const { installAdb } = require('../adbInstaller');
const { getSettings, saveSettings, makeDeviceId, normalizeDevice } = require('../db/settingsStore');

let installPromise = null;

const router = express.Router();

function sanitizePhoneConfig(phone) {
  return {
    adbPath: phone.adbPath || '',
    address: phone.address || '',
    dcim: phone.dcim,
    shutterKeycodes: phone.shutterKeycodes,
    devices: phone.devices || [],
    defaultDeviceId: phone.defaultDeviceId || null,
    activeDeviceId: phone.activeDeviceId || null,
  };
}

function mergeDeviceLists(registryDevices, liveDevices) {
  const liveBySerial = new Map(liveDevices.map((d) => [d.serial, d]));
  const registeredSerials = new Set(registryDevices.map((d) => d.serial));

  const registered = registryDevices.map((device) => {
    const live = liveBySerial.get(device.serial);
    return {
      ...device,
      registered: true,
      liveState: live?.state || 'offline',
      model: live?.model || null,
      connected: live?.state === 'device',
    };
  });

  const detected = liveDevices
    .filter((d) => !registeredSerials.has(d.serial))
    .map((d) => ({
      id: null,
      name: d.model || d.serial,
      connectionType: d.connectionType,
      serial: d.serial,
      address: d.connectionType === 'wifi' ? d.serial : '',
      registered: false,
      liveState: d.state,
      model: d.model,
      connected: d.state === 'device',
    }));

  return { registered, detected, all: [...registered, ...detected] };
}

function resolveActiveDeviceInfo(phone, merged) {
  const activeDevice = getActiveDevice();
  if (!activeDevice) {
    return { activeDevice: null, activeDeviceId: phone.activeDeviceId, connected: false };
  }

  const mergedEntry = merged.all.find((d) => d.id === activeDevice.id)
    || merged.all.find((d) => d.serial === activeDevice.serial);

  return {
    activeDevice: {
      ...activeDevice,
      liveState: mergedEntry?.liveState || 'offline',
      connected: mergedEntry?.connected || false,
      model: mergedEntry?.model || null,
    },
    activeDeviceId: phone.activeDeviceId || phone.defaultDeviceId,
    connected: mergedEntry?.connected || false,
  };
}

function addDeviceToSettings({ name, connectionType, serial, address }) {
  const existing = getSettings();
  const device = normalizeDevice({
    id: makeDeviceId(),
    name: name?.trim() || 'Phone',
    connectionType: connectionType === 'usb' ? 'usb' : 'wifi',
    serial: serial?.trim(),
    address: address?.trim() || (connectionType === 'wifi' ? serial?.trim() : ''),
    createdAt: new Date().toISOString(),
  });

  if (!device) {
    throw new Error('Invalid device data. Name and serial are required.');
  }

  const duplicate = existing.phone.devices.find((d) => d.serial === device.serial);
  if (duplicate) {
    throw new Error(`A device with serial "${device.serial}" is already registered as "${duplicate.name}".`);
  }

  const isFirst = existing.phone.devices.length === 0;
  const settings = {
    ...existing,
    phone: {
      ...existing.phone,
      devices: [...existing.phone.devices, device],
      defaultDeviceId: isFirst ? device.id : existing.phone.defaultDeviceId,
      activeDeviceId: isFirst ? device.id : existing.phone.activeDeviceId,
      ...(device.connectionType === 'wifi' && device.address
        ? { address: device.address }
        : {}),
    },
  };

  saveSettings(settings);
  return device;
}

router.get('/phone/status', async (req, res) => {
  try {
    const adbStatus = await checkAdb();
    const settings = getSettings();
    let liveDevices = [];
    let deviceListError = null;

    if (adbStatus.available) {
      try {
        liveDevices = await listDevices();
      } catch (err) {
        deviceListError = err.message;
      }
    }

    const merged = mergeDeviceLists(settings.phone.devices, liveDevices);
    const activeInfo = resolveActiveDeviceInfo(settings.phone, merged);

    res.json({
      adbAvailable: adbStatus.available,
      adbVersion: adbStatus.version,
      adbError: adbStatus.error || deviceListError || null,
      connected: activeInfo.connected,
      connectedDevice: activeInfo.activeDevice?.serial || null,
      activeDevice: activeInfo.activeDevice,
      activeDeviceId: activeInfo.activeDeviceId,
      defaultDeviceId: settings.phone.defaultDeviceId,
      devices: merged.all,
      registeredDevices: merged.registered,
      detectedDevices: merged.detected,
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

router.post('/phone/devices', async (req, res) => {
  const { name, connectionType, serial, address } = req.body || {};

  if (!serial?.trim()) {
    return res.status(400).json({ error: 'serial is required' });
  }

  try {
    const device = addDeviceToSettings({ name, connectionType, serial, address });

    if (device.connectionType === 'wifi' && device.address) {
      const lastColon = device.address.lastIndexOf(':');
      if (lastColon !== -1) {
        const host = device.address.slice(0, lastColon);
        const port = device.address.slice(lastColon + 1);
        await connectDevice(host, port).catch(() => {});
      }
    }

    res.json({ success: true, device });
  } catch (err) {
    res.status(err.message.includes('already registered') ? 409 : 500).json({
      error: err.message || 'Failed to register device',
    });
  }
});

router.patch('/phone/devices/:id', (req, res) => {
  const { id } = req.params;
  const { name, makeDefault } = req.body || {};

  try {
    const existing = getSettings();
    const deviceIndex = existing.phone.devices.findIndex((d) => d.id === id);

    if (deviceIndex === -1) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const devices = [...existing.phone.devices];
    const current = { ...devices[deviceIndex] };

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) {
        return res.status(400).json({ error: 'Device name cannot be empty' });
      }
      current.name = trimmed;
    }

    devices[deviceIndex] = current;

    const settings = {
      ...existing,
      phone: {
        ...existing.phone,
        devices,
        ...(makeDefault ? { defaultDeviceId: id } : {}),
      },
    };

    const saved = saveSettings(settings);
    res.json({
      success: true,
      device: saved.phone.devices.find((d) => d.id === id),
      defaultDeviceId: saved.phone.defaultDeviceId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update device' });
  }
});

router.delete('/phone/devices/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const existing = getSettings();
    const device = existing.phone.devices.find((d) => d.id === id);

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    if (device.connectionType === 'wifi' && device.address) {
      try {
        await disconnectDevice(device.address);
      } catch {
        /* ignore disconnect errors */
      }
    }

    const devices = existing.phone.devices.filter((d) => d.id !== id);
    let { defaultDeviceId, activeDeviceId } = existing.phone;

    if (defaultDeviceId === id) {
      defaultDeviceId = devices[0]?.id || null;
    }
    if (activeDeviceId === id) {
      activeDeviceId = null;
    }

    saveSettings({
      ...existing,
      phone: {
        ...existing.phone,
        devices,
        defaultDeviceId,
        activeDeviceId,
      },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to remove device' });
  }
});

router.post('/phone/active', (req, res) => {
  const { id } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const existing = getSettings();
    const device = existing.phone.devices.find((d) => d.id === id);

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const saved = saveSettings({
      ...existing,
      phone: {
        ...existing.phone,
        activeDeviceId: id,
      },
    });

    res.json({
      success: true,
      activeDeviceId: saved.phone.activeDeviceId,
      device,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to set active device' });
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
  const { host, port, name } = req.body || {};

  if (!host || !port) {
    return res.status(400).json({ error: 'host and port are required' });
  }

  try {
    const result = await connectDevice(host, port);
    let device = null;

    if (name?.trim()) {
      try {
        device = addDeviceToSettings({
          name: name.trim(),
          connectionType: 'wifi',
          serial: result.serial,
          address: result.address,
        });
      } catch (err) {
        if (!err.message.includes('already registered')) {
          throw err;
        }
        device = getSettings().phone.devices.find((d) => d.serial === result.serial) || null;
      }
    } else {
      const existing = getSettings();
      saveSettings({
        ...existing,
        phone: { ...existing.phone, address: result.address },
      });
    }

    res.json({ ...result, device });
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
    const activeDevice = getActiveDevice();
    if (!activeDevice) {
      return res.status(400).json({ error: 'No active device configured. Add and select a device first.' });
    }

    const { file, localPath, deviceId, deviceName } = await takePhoto({ device: activeDevice });
    res.json({
      file,
      localPath,
      deviceId,
      deviceName,
      url: `/captures/${encodeURIComponent(file)}`,
    });
  } catch (err) {
    console.error('snap failed:', err);
    res.status(500).json({ error: err.message || 'Failed to take photo' });
  }
});

module.exports = router;
