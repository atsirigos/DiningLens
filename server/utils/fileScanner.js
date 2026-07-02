const fs = require('fs');
const path = require('path');

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov',
]);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov']);

function getFileType(ext) {
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return 'unknown';
}

function scanDirectory(dir, baseDir = dir) {
  const results = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === '.trash') continue;
      results.push(...scanDirectory(fullPath, baseDir));
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    const stat = fs.statSync(fullPath);
    const relativePath = path.relative(baseDir, fullPath);

    results.push({
      name: entry.name,
      path: relativePath.split(path.sep).join('/'),
      type: getFileType(ext),
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }

  return results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function scanDataFolder(dataDir) {
  return scanDirectory(dataDir, dataDir);
}

module.exports = { scanDataFolder, SUPPORTED_EXTENSIONS };
