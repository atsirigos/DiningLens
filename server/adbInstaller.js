const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const AdmZip = require('adm-zip');

const execFileAsync = promisify(execFile);

const ROOT = path.join(__dirname, '..');
const PLATFORM_TOOLS_DIR = path.join(ROOT, 'platform-tools');

const DOWNLOAD_URLS = {
  win32: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  darwin: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
  linux: 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
};

function adbBinaryName() {
  return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

function getBundledAdbPath() {
  const candidate = path.join(PLATFORM_TOOLS_DIR, adbBinaryName());
  return fs.existsSync(candidate) ? candidate : null;
}

function downloadUrlForPlatform() {
  const url = DOWNLOAD_URLS[process.platform];
  if (!url) {
    throw new Error(`Automatic ADB install is not supported on platform "${process.platform}".`);
  }
  return url;
}

function downloadFile(url, destPath, { redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error('Too many redirects while downloading platform-tools.'));
          return;
        }
        resolve(downloadFile(res.headers.location, destPath, { redirects: redirects - 1 }));
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed with HTTP ${res.statusCode}.`));
        return;
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(() => resolve(destPath)));
      fileStream.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(120000, () => {
      request.destroy(new Error('Download timed out.'));
    });
  });
}

async function verifyAdb(adbPath) {
  const { stdout } = await execFileAsync(adbPath, ['version'], { timeout: 15000 });
  const out = stdout.toString().trim();
  const match = out.match(/Android Debug Bridge version ([^\s]+)/i);
  return match?.[1] || out.split('\n')[0] || 'unknown';
}

async function installAdb() {
  const existing = getBundledAdbPath();
  if (existing) {
    const version = await verifyAdb(existing).catch(() => null);
    if (version) return { adbPath: existing, version, alreadyInstalled: true };
  }

  const url = downloadUrlForPlatform();
  const tmpZip = path.join(os.tmpdir(), `platform-tools-${Date.now()}.zip`);

  try {
    await downloadFile(url, tmpZip);

    if (fs.existsSync(PLATFORM_TOOLS_DIR)) {
      await fsp.rm(PLATFORM_TOOLS_DIR, { recursive: true, force: true });
    }

    const zip = new AdmZip(tmpZip);
    zip.extractAllTo(ROOT, true);

    const adbPath = getBundledAdbPath();
    if (!adbPath) {
      throw new Error('platform-tools extracted but adb binary was not found.');
    }

    if (process.platform !== 'win32') {
      await fsp.chmod(adbPath, 0o755).catch(() => {});
    }

    const version = await verifyAdb(adbPath);
    return { adbPath, version, alreadyInstalled: false };
  } finally {
    await fsp.rm(tmpZip, { force: true }).catch(() => {});
  }
}

module.exports = {
  PLATFORM_TOOLS_DIR,
  getBundledAdbPath,
  installAdb,
};
