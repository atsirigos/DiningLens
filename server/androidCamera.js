const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const fs = require('node:fs/promises');
const { getSettings } = require('./db/settingsStore');
const { getBundledAdbPath } = require('./adbInstaller');
const { rotateImageFile } = require('./utils/imageRotate');

const execFileAsync = promisify(execFile);

const ROOT = path.join(__dirname, '..');
const CAPTURE_DIR = path.join(ROOT, 'captures');

function getPhoneConfig() {
  return getSettings().phone;
}

function getAdbPath() {
  const configured = getPhoneConfig().adbPath?.trim();
  if (configured) return configured;
  return getBundledAdbPath() || 'adb';
}

async function adb(args, { timeout = 20000 } = {}) {
  const adbPath = getAdbPath();
  try {
    const { stdout, stderr } = await execFileAsync(adbPath, args, { timeout });
    const out = stdout?.toString().trim() || '';
    const err = stderr?.toString().trim() || '';
    return out || err;
  } catch (err) {
    const message = err.stderr?.toString().trim()
      || err.stdout?.toString().trim()
      || err.message;
    throw new Error(message);
  }
}

function adbShell(serial, cmd) {
  return adb(['-s', serial, 'shell', cmd]);
}

async function checkAdb() {
  try {
    const out = await adb(['version'], { timeout: 10000 });
    const match = out.match(/Android Debug Bridge version ([^\s]+)/i);
    return { available: true, version: match?.[1] || out.split('\n')[0] || 'unknown' };
  } catch (err) {
    return { available: false, version: null, error: err.message };
  }
}

function isNetworkSerial(serial) {
  return /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(serial || '');
}

function inferConnectionType(serial) {
  return isNetworkSerial(serial) ? 'wifi' : 'usb';
}

function parseDevices(output) {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const serial = parts[0];
      const state = parts[1] || 'unknown';
      const props = {};

      for (const part of parts.slice(2)) {
        const idx = part.indexOf(':');
        if (idx === -1) continue;
        const key = part.slice(0, idx);
        const value = part.slice(idx + 1);
        props[key] = value;
      }

      const model = props.model ? props.model.replace(/_/g, ' ') : null;

      return {
        serial,
        state,
        model,
        connectionType: inferConnectionType(serial),
      };
    })
    .filter((d) => d.serial);
}

async function listDevices() {
  const out = await adb(['devices', '-l']);
  return parseDevices(out);
}

function getDevices() {
  return getPhoneConfig().devices || [];
}

function findDevice(id) {
  if (!id) return null;
  return getDevices().find((d) => d.id === id) || null;
}

function getDefaultDevice() {
  const config = getPhoneConfig();
  if (config.defaultDeviceId) {
    const device = findDevice(config.defaultDeviceId);
    if (device) return device;
  }
  return getDevices()[0] || null;
}

function getActiveDevice() {
  const config = getPhoneConfig();
  if (config.activeDeviceId) {
    const device = findDevice(config.activeDeviceId);
    if (device) return device;
  }
  return getDefaultDevice();
}

async function ensureConnectedForDevice(device) {
  if (!device) {
    throw new Error('No device configured. Add and select a device in Phone Configuration.');
  }

  if (device.connectionType === 'wifi') {
    const addr = device.address || device.serial;
    if (!addr) {
      throw new Error(`Wi-Fi device "${device.name}" has no connect address.`);
    }

    const out = await adb(['connect', addr], { timeout: 30000 });
    if (!/connected|already connected/i.test(out)) {
      throw new Error(`Could not connect to ${device.name} (${addr}): ${out}`);
    }
    return addr;
  }

  const liveDevices = await listDevices();
  const match = liveDevices.find((d) => d.serial === device.serial);

  if (!match) {
    throw new Error(
      `USB device "${device.name}" (${device.serial}) is not connected. Plug it in and allow USB debugging.`
    );
  }

  if (match.state === 'unauthorized') {
    throw new Error(
      `USB device "${device.name}" is unauthorized. Tap "Allow" on the phone's USB debugging prompt.`
    );
  }

  if (match.state !== 'device') {
    throw new Error(`USB device "${device.name}" is in state "${match.state}".`);
  }

  return device.serial;
}

async function ensureConnected() {
  const device = getActiveDevice();
  return ensureConnectedForDevice(device);
}

async function pairDevice(host, port, code) {
  const addr = `${host}:${port}`;
  const codeStr = String(code).trim();

  if (!host || !port || !codeStr) {
    throw new Error('Host, port, and pairing code are required.');
  }

  try {
    const out = await adb(['pair', addr, codeStr], { timeout: 30000 });
    if (/success|paired/i.test(out)) return { success: true, message: out };
    if (/failed|error/i.test(out)) throw new Error(out);
    return { success: true, message: out || 'Pairing completed.' };
  } catch (directErr) {
    const adbPath = getAdbPath();
    const result = await new Promise((resolve, reject) => {
      const proc = spawn(adbPath, ['pair', addr], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('Pairing timed out. Check the pairing code and try again.'));
      }, 30000);

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      proc.on('close', (codeExit) => {
        clearTimeout(timer);
        const out = (stdout + stderr).trim();
        if (codeExit === 0 || /success|paired/i.test(out)) {
          resolve({ success: true, message: out || 'Pairing completed.' });
        } else {
          reject(new Error(out || directErr.message || 'Pairing failed.'));
        }
      });

      proc.stdin.write(`${codeStr}\n`);
      proc.stdin.end();
    });

    return result;
  }
}

async function connectDevice(host, port) {
  const addr = `${host}:${port}`;
  if (!host || !port) {
    throw new Error('Host and port are required.');
  }

  const out = await adb(['connect', addr], { timeout: 30000 });
  if (!/connected|already connected/i.test(out)) {
    throw new Error(`Could not connect to ${addr}: ${out}`);
  }

  return { address: addr, serial: addr, message: out };
}

async function disconnectAll() {
  const out = await adb(['disconnect']);
  return { message: out || 'Disconnected.' };
}

async function disconnectDevice(address) {
  if (!address?.trim()) {
    throw new Error('Address is required to disconnect a Wi-Fi device.');
  }
  const out = await adb(['disconnect', address.trim()]);
  return { message: out || 'Disconnected.' };
}

async function latestPhotoName(serial) {
  const dcim = getPhoneConfig().dcim;
  const out = await adbShell(serial, `ls -t ${dcim} 2>/dev/null | head -n 1`);
  return out || null;
}

async function waitForNewPhoto(serial, before, { tries = 8, delayMs = 600 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const latest = await latestPhotoName(serial);
    if (latest && latest !== before) return latest;
  }
  return null;
}

async function takePhoto({ device, warmupMs = 2500, destDir = CAPTURE_DIR } = {}) {
  const targetDevice = device || getActiveDevice();
  const serial = await ensureConnectedForDevice(targetDevice);
  const { dcim, shutterKeycodes } = getPhoneConfig();

  const before = await latestPhotoName(serial);

  await adbShell(serial, 'am start -a android.media.action.STILL_IMAGE_CAMERA');
  await new Promise((r) => setTimeout(r, warmupMs));

  let file = null;
  for (const keycode of shutterKeycodes) {
    await adbShell(serial, `input keyevent ${keycode}`);
    file = await waitForNewPhoto(serial, before);
    if (file) break;
  }

  if (!file) {
    throw new Error(
      'Shutter not triggered. Your camera app may need a different key or tap — see troubleshooting in Phone Configuration.'
    );
  }

  await fs.mkdir(destDir, { recursive: true });
  const localPath = path.join(destDir, file);
  await adb(['-s', serial, 'pull', `${dcim}/${file}`, localPath], { timeout: 60000 });

  const frameRotation = getSettings().phone?.frameRotation || 0;
  if (frameRotation) {
    await rotateImageFile(localPath, frameRotation);
  }

  return { file, localPath, deviceId: targetDevice?.id || null, deviceName: targetDevice?.name || serial };
}

function sanitizePhoneFilename(filename) {
  const name = String(filename || '').trim();
  if (!name || name.includes('/') || name.includes('..')) return null;
  return name;
}

async function deletePhonePhotos(serial, filenames, { dcim } = {}) {
  const dcimPath = dcim || getPhoneConfig().dcim;
  const safeFiles = [...new Set(
    (filenames || []).map(sanitizePhoneFilename).filter(Boolean),
  )];

  if (!safeFiles.length) {
    return { deleted: [], failed: [] };
  }

  const deleted = [];
  const failed = [];
  const quoted = safeFiles.map((f) => `"${dcimPath}/${f.replace(/"/g, '')}"`).join(' ');

  try {
    await adbShell(serial, `rm -f ${quoted}`);
    deleted.push(...safeFiles);
  } catch (err) {
    for (const file of safeFiles) {
      try {
        await adbShell(serial, `rm -f "${dcimPath}/${file.replace(/"/g, '')}"`);
        deleted.push(file);
      } catch (fileErr) {
        failed.push({ file, error: fileErr.message });
      }
    }
  }

  return { deleted, failed };
}

async function closePhoneScreen(serial) {
  try {
    await adbShell(serial, 'input keyevent 3');
    return true;
  } catch (err) {
    console.warn('[androidCamera] closePhoneScreen failed:', err.message);
    return false;
  }
}

function parseBatteryDump(output) {
  const text = output || '';
  const levelMatch = text.match(/level:\s*(\d+)/i);
  const statusMatch = text.match(/status:\s*(\d+)/i);
  const tempMatch = text.match(/temperature:\s*(\d+)/i);

  const level = levelMatch ? Number(levelMatch[1]) : null;
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const temperatureRaw = tempMatch ? Number(tempMatch[1]) : null;

  return {
    level: Number.isFinite(level) ? level : null,
    charging: status === 2 || status === 5,
    temperatureCelsius: Number.isFinite(temperatureRaw) ? temperatureRaw / 10 : null,
  };
}

function parseStorageLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) return null;

  const sizeStr = parts[1];
  const usedStr = parts[2];
  const humanSize = /^[\d.]+[KMGT]?$/i.test(sizeStr);

  if (humanSize) {
    const parseHuman = (value) => {
      const match = String(value).match(/^([\d.]+)([KMGT])?$/i);
      if (!match) return null;
      const num = Number(match[1]);
      const unit = (match[2] || '').toUpperCase();
      const multipliers = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
      return Number.isFinite(num) ? Math.round(num * (multipliers[unit] || 1)) : null;
    };

    const totalBytes = parseHuman(sizeStr);
    const usedBytes = parseHuman(usedStr);
    if (!totalBytes || usedBytes == null) return null;

    return {
      mount: parts[parts.length - 1],
      totalBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : null,
    };
  }

  const totalBlocks = Number(parts[1]);
  const usedBlocks = Number(parts[2]);
  const blockSize = 1024;

  if (!Number.isFinite(totalBlocks) || !Number.isFinite(usedBlocks)) {
    return null;
  }

  const totalBytes = totalBlocks * blockSize;
  const usedBytes = usedBlocks * blockSize;

  return {
    mount: parts[parts.length - 1],
    totalBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : null,
  };
}

async function getStorageInfo(serial) {
  for (const mount of ['/sdcard', '/data']) {
    try {
      const out = await adbShell(serial, `df -k ${mount} 2>/dev/null || df ${mount}`);
      const line = out.split('\n').slice(1).find((l) => l.trim());
      const parsed = parseStorageLine(line || '');
      if (parsed) {
        return { ...parsed, mount };
      }
    } catch {
      /* try next mount */
    }
  }
  return null;
}

function parseLocationDump(output) {
  const text = output || '';

  const bracketMatch = text.match(
    /Location\[(\w+)\s+(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\s+.*?(?:acc=|hAcc=)([\d.]+)/i,
  );
  if (bracketMatch) {
    return {
      available: true,
      provider: bracketMatch[1],
      latitude: Number(bracketMatch[2]),
      longitude: Number(bracketMatch[3]),
      accuracyMeters: Number(bracketMatch[4]),
      updatedAt: null,
    };
  }

  const latMatch = text.match(/lat(?:itude)?[=:]\s*(-?\d+(?:\.\d+)?)/i);
  const lngMatch = text.match(/(?:lng|lon|longitude)[=:]\s*(-?\d+(?:\.\d+)?)/i);
  const accMatch = text.match(/(?:accuracy|acc)[=:]\s*([\d.]+)/i);

  if (latMatch && lngMatch) {
    return {
      available: true,
      provider: null,
      latitude: Number(latMatch[1]),
      longitude: Number(lngMatch[1]),
      accuracyMeters: accMatch ? Number(accMatch[1]) : null,
      updatedAt: null,
    };
  }

  if (/location.*disabled|gps.*disabled|no location/i.test(text)) {
    return { available: false, reason: 'Location services disabled on device' };
  }

  return { available: false, reason: 'No location fix available' };
}

async function getDeviceHealth(serial, device = null) {
  const errors = [];
  const fetchedAt = new Date().toISOString();

  let battery = { level: null, charging: false, temperatureCelsius: null };
  try {
    const out = await adbShell(serial, 'dumpsys battery');
    battery = parseBatteryDump(out);
  } catch (err) {
    errors.push({ metric: 'battery', error: err.message });
  }

  let storage = { usedBytes: null, totalBytes: null, usedPercent: null, mount: null };
  try {
    const info = await getStorageInfo(serial);
    if (info) {
      storage = info;
    } else {
      errors.push({ metric: 'storage', error: 'Could not read storage info' });
    }
  } catch (err) {
    errors.push({ metric: 'storage', error: err.message });
  }

  let location = { available: false, reason: 'Unknown' };
  try {
    const out = await adbShell(serial, 'dumpsys location');
    location = parseLocationDump(out);
  } catch (err) {
    location = { available: false, reason: err.message };
    errors.push({ metric: 'location', error: err.message });
  }

  const targetDevice = device || getActiveDevice();

  return {
    connected: true,
    device: targetDevice
      ? { id: targetDevice.id, name: targetDevice.name, serial: targetDevice.serial }
      : { id: null, name: null, serial },
    battery,
    storage,
    location,
    fetchedAt,
    errors,
  };
}

module.exports = {
  CAPTURE_DIR,
  getAdbPath,
  checkAdb,
  listDevices,
  parseDevices,
  isNetworkSerial,
  inferConnectionType,
  getDevices,
  findDevice,
  getDefaultDevice,
  getActiveDevice,
  pairDevice,
  connectDevice,
  disconnectAll,
  disconnectDevice,
  ensureConnected,
  ensureConnectedForDevice,
  takePhoto,
  deletePhonePhotos,
  closePhoneScreen,
  getDeviceHealth,
};
