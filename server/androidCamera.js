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

function sanitizePhoneFilename(filename) {
  const name = String(filename || '').trim();
  if (!name || name.includes('/') || name.includes('..')) return null;
  return name;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

/** Android screenrecord hard-caps each clip at 180 seconds. */
const SCREENRECORD_MAX_SECONDS = 180;
const SCREENRECORD_REMOTE_DIR = '/sdcard/DiningLens';

async function preparePhoneForVideo(serial, { warmupMs = 2000 } = {}) {
  try {
    await adbShell(serial, 'input keyevent KEYCODE_WAKEUP');
  } catch {
    /* ignore */
  }
  try {
    await adbShell(serial, 'am start -a android.media.action.STILL_IMAGE_CAMERA');
  } catch {
    /* ignore — screenrecord still works without camera preview */
  }
  await new Promise((r) => setTimeout(r, warmupMs));
}

/**
 * Start `adb shell screenrecord` as a long-running process.
 * Call stopScreenRecord() then pullPhoneFile() when finished.
 */
async function startScreenRecord({
  device,
  remotePath,
  timeLimitSec = SCREENRECORD_MAX_SECONDS,
} = {}) {
  const targetDevice = device || getActiveDevice();
  const serial = await ensureConnectedForDevice(targetDevice);
  const limit = Math.max(1, Math.min(SCREENRECORD_MAX_SECONDS, Math.round(timeLimitSec)));
  const remote = String(remotePath || '').trim();
  if (!remote.startsWith('/')) {
    throw new Error('Remote video path must be an absolute path on the phone.');
  }

  await adbShell(serial, `mkdir -p ${shellQuote(SCREENRECORD_REMOTE_DIR)}`);
  try {
    await adbShell(serial, `rm -f ${shellQuote(remote)}`);
  } catch {
    /* ignore */
  }

  const adbPath = getAdbPath();
  const proc = spawn(
    adbPath,
    ['-s', serial, 'shell', 'screenrecord', '--time-limit', String(limit), remote],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderr = '';
  proc.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const exitPromise = new Promise((resolve) => {
    proc.on('close', (code, signal) => {
      resolve({ code, signal, stderr: stderr.trim() });
    });
  });

  // Fail fast if screenrecord cannot start
  await new Promise((r) => setTimeout(r, 800));
  if (proc.exitCode != null) {
    const result = await exitPromise;
    throw new Error(
      result.stderr || `screenrecord exited immediately (code ${result.code}). Is the phone screen on?`,
    );
  }

  return {
    serial,
    remotePath: remote,
    timeLimitSec: limit,
    process: proc,
    exitPromise,
    deviceId: targetDevice?.id || null,
    deviceName: targetDevice?.name || serial,
  };
}

async function stopScreenRecord(handle) {
  if (!handle?.serial) return { stopped: false };

  // Send SIGINT (signal 2) to screenrecord so it finalizes the MP4 (writes moov).
  // Do NOT use `pkill -l` — on Android/toybox `-l` means "list signals", not "send signal".
  try {
    await adbShell(
      handle.serial,
      'kill -2 $(pidof screenrecord) 2>/dev/null || pkill -2 screenrecord 2>/dev/null || true',
    );
  } catch {
    /* ignore */
  }

  // Prefer letting the adb shell process exit on its own after screenrecord finishes.
  // Force-killing adb mid-shutdown truncates the file (no moov atom → unplayable).
  if (handle.exitPromise) {
    await Promise.race([
      handle.exitPromise,
      new Promise((r) => setTimeout(r, 20000)),
    ]);
  }

  // Wait until screenrecord is gone on device (moov flush)
  for (let i = 0; i < 20; i += 1) {
    try {
      const out = await adbShell(handle.serial, 'pidof screenrecord 2>/dev/null || true');
      if (!out.trim()) break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (handle.process && handle.process.exitCode == null && !handle.process.killed) {
    try {
      handle.process.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  // Extra settle time before adb pull
  await new Promise((r) => setTimeout(r, 1500));
  return { stopped: true };
}

async function pullPhoneFile(serial, remotePath, localPath, { timeout = 300000 } = {}) {
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await adb(['-s', serial, 'pull', remotePath, localPath], { timeout });
  return localPath;
}

/**
 * Android screenrecord writes moov at the end. Abrupt kills leave mdat-only files
 * that browsers cannot play. Returns true if a moov atom is present.
 */
async function isPlayableMp4(localPath) {
  const fh = await fs.open(localPath, 'r');
  try {
    const stat = await fh.stat();
    if (stat.size < 64) return false;

    const buf = Buffer.alloc(Math.min(stat.size, 256 * 1024));
    await fh.read(buf, 0, buf.length, 0);
    if (buf.includes(Buffer.from('moov'))) return true;

    // moov is often at the end — check the last 512KB
    const tailLen = Math.min(stat.size, 512 * 1024);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, stat.size - tailLen);
    return tail.includes(Buffer.from('moov'));
  } catch {
    return false;
  } finally {
    await fh.close();
  }
}

async function deletePhoneFilesByPath(serial, remotePaths) {
  const deleted = [];
  const failed = [];

  for (const remotePath of remotePaths || []) {
    const remote = String(remotePath || '').trim();
    if (!remote.startsWith('/')) {
      failed.push({ path: remote, error: 'Invalid path' });
      continue;
    }
    try {
      await adbShell(serial, `rm -f ${shellQuote(remote)}`);
      if (await phoneFileExists(serial, remote)) {
        failed.push({ path: remote, error: 'File still present on phone' });
      } else {
        deleted.push(remote);
      }
    } catch (err) {
      failed.push({ path: remote, error: err.message });
    }
  }

  return { deleted, failed };
}

function expandDcimPaths(dcimPath, filename) {
  const paths = new Set();
  const dcim = (dcimPath || '/sdcard/DCIM/Camera').replace(/\/+$/, '');

  paths.add(`${dcim}/${filename}`);

  if (dcim.startsWith('/sdcard/')) {
    paths.add(`/storage/emulated/0${dcim.slice('/sdcard'.length)}/${filename}`);
  }

  if (dcim.startsWith('/storage/emulated/0/')) {
    paths.add(`/sdcard${dcim.slice('/storage/emulated/0'.length)}/${filename}`);
  }

  paths.add(`/sdcard/DCIM/Camera/${filename}`);
  paths.add(`/storage/emulated/0/DCIM/Camera/${filename}`);

  return [...paths];
}

async function findPhonePhotoPaths(serial, filename) {
  const safeName = sanitizePhoneFilename(filename);
  if (!safeName) return [];

  const dcim = getPhoneConfig().dcim;
  const paths = new Set(expandDcimPaths(dcim, safeName));

  try {
    const found = await adbShell(
      serial,
      `find /sdcard/DCIM /storage/emulated/0/DCIM /sdcard/Pictures /storage/emulated/0/Pictures -name ${shellQuote(safeName)} 2>/dev/null`,
    );
    found.split('\n').map((line) => line.trim()).filter(Boolean).forEach((line) => paths.add(line));
  } catch {
    /* ignore find errors */
  }

  return [...paths];
}

async function phoneFileExists(serial, filePath) {
  try {
    const out = await adbShell(serial, `test -f ${shellQuote(filePath)} && echo 1 || echo 0`);
    return out.trim() === '1';
  } catch {
    return false;
  }
}

async function removeFromMediaStore(serial, filename, filePaths) {
  const uris = [
    'content://media/external/images/media',
    'content://media/external/video/media',
    'content://media/external/file',
    'content://media/external/primary/images/media',
    'content://media/external/primary/file',
  ];

  for (const uri of uris) {
    try {
      await adbShell(
        serial,
        `content delete --uri ${uri} --where "_display_name=${shellQuote(filename)}"`,
      );
    } catch {
      /* ignore per-uri failures */
    }

    for (const filePath of filePaths) {
      try {
        await adbShell(
          serial,
          `content delete --uri ${uri} --where "_data=${shellQuote(filePath)}"`,
        );
      } catch {
        /* ignore per-path failures */
      }
    }
  }
}

async function refreshMediaStore(serial, dcimPath) {
  const dcim = (dcimPath || '/sdcard/DCIM/Camera').replace(/\/+$/, '');
  const scanPaths = [dcim];
  if (dcim.startsWith('/sdcard/')) {
    scanPaths.push(`/storage/emulated/0${dcim.slice('/sdcard'.length)}`);
  }

  for (const scanPath of scanPaths) {
    const uri = scanPath.startsWith('/sdcard/')
      ? `file:///storage/emulated/0${scanPath.slice('/sdcard'.length)}`
      : `file://${scanPath}`;

    try {
      await adbShell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shellQuote(uri)}`);
    } catch {
      /* ignore */
    }

    try {
      await adbShell(serial, `cmd media scan-file ${shellQuote(scanPath)}`);
    } catch {
      /* ignore */
    }
  }
}

async function deletePhonePhoto(serial, filename, { dcim } = {}) {
  const safeName = sanitizePhoneFilename(filename);
  if (!safeName) {
    return { file: filename, deleted: false, error: 'Invalid filename' };
  }

  const dcimPath = dcim || getPhoneConfig().dcim;
  const filePaths = await findPhonePhotoPaths(serial, safeName);
  let removedFromDisk = false;

  for (const filePath of filePaths) {
    try {
      await adbShell(serial, `rm -f ${shellQuote(filePath)}`);
      if (!(await phoneFileExists(serial, filePath))) {
        removedFromDisk = true;
      }
    } catch (err) {
      if (!removedFromDisk) {
        return { file: safeName, deleted: false, error: err.message };
      }
    }
  }

  await removeFromMediaStore(serial, safeName, filePaths);
  await refreshMediaStore(serial, dcimPath);

  const stillOnDisk = [];
  for (const filePath of filePaths) {
    if (await phoneFileExists(serial, filePath)) {
      stillOnDisk.push(filePath);
    }
  }

  if (stillOnDisk.length) {
    return {
      file: safeName,
      deleted: false,
      error: `File still present on phone (${stillOnDisk.join(', ')})`,
    };
  }

  return { file: safeName, deleted: true };
}

async function deletePhonePhotos(serial, filenames, { dcim } = {}) {
  const safeFiles = [...new Set(
    (filenames || []).map(sanitizePhoneFilename).filter(Boolean),
  )];

  if (!safeFiles.length) {
    return { deleted: [], failed: [] };
  }

  const deleted = [];
  const failed = [];

  for (const file of safeFiles) {
    const result = await deletePhonePhoto(serial, file, { dcim });
    if (result.deleted) {
      deleted.push(file);
    } else {
      failed.push({ file, error: result.error || 'Delete failed' });
    }
  }

  return { deleted, failed };
}

async function closePhoneScreen(serial) {
  try {
    await adbShell(serial, 'input keyevent 3');
    await new Promise((r) => setTimeout(r, 400));

    const sleepCommands = [
      'cmd power sleep',
      'input keyevent 223',
      'input keyevent 26',
    ];

    for (const cmd of sleepCommands) {
      try {
        await adbShell(serial, cmd);
        return true;
      } catch {
        /* try next sleep method */
      }
    }

    return false;
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
  const plugged = /AC powered:\s*true/i.test(text)
    || /USB powered:\s*true/i.test(text)
    || /Wireless powered:\s*true/i.test(text);

  return {
    level: Number.isFinite(level) ? level : null,
    charging: status === 2 || status === 5,
    plugged,
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
  SCREENRECORD_MAX_SECONDS,
  SCREENRECORD_REMOTE_DIR,
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
  preparePhoneForVideo,
  startScreenRecord,
  stopScreenRecord,
  pullPhoneFile,
  deletePhoneFilesByPath,
  isPlayableMp4,
  deletePhonePhotos,
  closePhoneScreen,
  getDeviceHealth,
  adbShell,
};
