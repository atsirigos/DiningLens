const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** Directories that count toward DiningLens disk usage (user data + caches). */
const APP_DIRS = [
  path.join(ROOT, 'data'),
  path.join(ROOT, 'db'),
  path.join(ROOT, 'captures'),
  path.join(ROOT, 'processed'),
];

const CACHE_TTL_MS = 5000;
let cache = null;
let cacheAt = 0;
let inflight = null;

async function directorySizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await directorySizeBytes(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const stat = await fsp.stat(fullPath);
        total += stat.size;
      }
    } catch {
      // Skip unreadable / raced entries
    }
  }
  return total;
}

async function appUsageBytes() {
  const sizes = await Promise.all(APP_DIRS.map((dir) => directorySizeBytes(dir)));
  return sizes.reduce((sum, n) => sum + n, 0);
}

function volumeStats(dir) {
  const stats = fs.statfsSync(dir);
  const blockSize = Number(stats.bsize) || 4096;
  const totalBytes = Number(stats.blocks) * blockSize;
  const freeBytes = Number(stats.bavail != null ? stats.bavail : stats.bfree) * blockSize;
  return { totalBytes, freeBytes };
}

/**
 * Host disk breakdown for the volume that holds DiningLens data.
 * nonApp = total − free − app (clamped ≥ 0).
 */
async function getStorageInfo() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) {
    return cache;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const dataDir = APP_DIRS[0];
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const { totalBytes, freeBytes } = volumeStats(dataDir);
    const appBytes = await appUsageBytes();
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const nonAppBytes = Math.max(0, usedBytes - appBytes);
    const safeAppBytes = Math.min(appBytes, usedBytes);

    const result = {
      totalBytes,
      freeBytes,
      usedBytes,
      appBytes: safeAppBytes,
      nonAppBytes,
      appBytesRaw: appBytes,
      path: dataDir,
      measuredAt: new Date().toISOString(),
    };
    cache = result;
    cacheAt = Date.now();
    return result;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

module.exports = {
  getStorageInfo,
  APP_DIRS,
};
