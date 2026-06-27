const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const fs = require('node:fs/promises');
const { getSettings } = require('./db/settingsStore');
const { getBundledAdbPath } = require('./adbInstaller');

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

function parseDevices(output) {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    })
    .filter((d) => d.serial);
}

async function listDevices() {
  const out = await adb(['devices']);
  return parseDevices(out);
}

async function discoverDevice() {
  const { address } = getPhoneConfig();
  if (address?.trim()) return address.trim();

  try {
    const out = await adb(['mdns', 'services']);
    const m = out.match(/_adb-tls-connect\._tcp\s+(\S+:\d+)/);
    if (m) return m[1];
  } catch {
    /* mdns may be unsupported */
  }

  throw new Error('No phone address configured and no wireless device found via mDNS.');
}

async function ensureConnected() {
  const addr = await discoverDevice();
  const out = await adb(['connect', addr]);
  if (!/connected/i.test(out)) {
    throw new Error(`Could not connect to ${addr}: ${out}`);
  }
  return addr;
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
  if (!/connected/i.test(out)) {
    throw new Error(`Could not connect to ${addr}: ${out}`);
  }

  return { address: addr, message: out };
}

async function disconnectAll() {
  const out = await adb(['disconnect']);
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

async function takePhoto({ warmupMs = 2500 } = {}) {
  const serial = await ensureConnected();
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

  await fs.mkdir(CAPTURE_DIR, { recursive: true });
  const localPath = path.join(CAPTURE_DIR, file);
  await adb(['-s', serial, 'pull', `${dcim}/${file}`, localPath], { timeout: 60000 });

  return { file, localPath };
}

module.exports = {
  CAPTURE_DIR,
  getAdbPath,
  checkAdb,
  listDevices,
  pairDevice,
  connectDevice,
  disconnectAll,
  ensureConnected,
  takePhoto,
};
