const path = require('path');
const fs = require('fs');
const { getStatus } = require('../recordingManager');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const TRASH_DIR = path.join(DATA_DIR, '.trash');
const RESULTS_FILE = path.join(__dirname, '..', '..', 'processed', 'results.json');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov']);
const SUPPORTED_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

function getFileType(ext) {
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return 'unknown';
}

function normalizeRelativePath(relativePath) {
  const decoded = decodeURIComponent(String(relativePath || ''));
  const normalized = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.startsWith('.trash/') || normalized === '.trash') {
    return null;
  }
  return normalized;
}

function resolveUnderDir(baseDir, relativePath, { requireExists = true } = {}) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return null;

  const resolved = path.resolve(baseDir, normalized);
  const normalizedBase = path.resolve(baseDir);

  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    return null;
  }

  if (requireExists && !fs.existsSync(resolved)) {
    return null;
  }

  return { resolved, relative: normalized };
}

function resolveDataPath(relativePath) {
  return resolveUnderDir(DATA_DIR, relativePath);
}

function resolveTrashPath(relativePath) {
  return resolveUnderDir(TRASH_DIR, relativePath);
}

function ensureTrashDir() {
  if (!fs.existsSync(TRASH_DIR)) {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
  }
}

function assertNotActiveRecording(relativePath) {
  const status = getStatus();
  if (status.status !== 'recording' || !status.sessionId) return;

  const sessionPrefix = `recordings/${status.sessionId}`;
  if (relativePath === sessionPrefix || relativePath.startsWith(`${sessionPrefix}/`)) {
    const err = new Error('Cannot trash files from an active recording session');
    err.code = 'ACTIVE_RECORDING';
    throw err;
  }
}

function removeEmptyParentDirs(dirPath, stopAt) {
  let current = dirPath;
  const stopResolved = path.resolve(stopAt);

  while (current && current !== stopResolved) {
    if (!fs.existsSync(current)) break;
    const entries = fs.readdirSync(current);
    if (entries.length > 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function uniqueTrashDest(destPath) {
  if (!fs.existsSync(destPath)) return destPath;

  const dir = path.dirname(destPath);
  const base = path.basename(destPath, path.extname(destPath));
  const ext = path.extname(destPath);
  const suffix = Date.now();
  return path.join(dir, `${base}-${suffix}${ext}`);
}

function moveEntry(srcResolved, destResolved) {
  ensureTrashDir();
  fs.mkdirSync(path.dirname(destResolved), { recursive: true });
  const finalDest = uniqueTrashDest(destResolved);
  fs.renameSync(srcResolved, finalDest);
  return path.relative(TRASH_DIR, finalDest).split(path.sep).join('/');
}

function readResults() {
  if (!fs.existsSync(RESULTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeResults(results) {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf8');
}

function collectPathsFromEntry(resolved) {
  const paths = [];
  const stat = fs.statSync(resolved);

  if (stat.isDirectory()) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else paths.push(path.relative(DATA_DIR, full).split(path.sep).join('/'));
      }
    };
    walk(resolved);
  } else {
    paths.push(path.relative(DATA_DIR, resolved).split(path.sep).join('/'));
  }

  return paths;
}

function clearResultsForPaths(paths) {
  if (!paths.length) return;

  const results = readResults();
  let changed = false;

  for (const p of paths) {
    const basename = path.basename(p);
    if (results[basename]) {
      delete results[basename];
      changed = true;
    }
  }

  if (changed) writeResults(results);
}

function scanTrashDirectory(dir, baseDir = dir) {
  const results = [];

  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...scanTrashDirectory(fullPath, baseDir));
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
    if (/\.thumb\.(jpe?g|png|webp)$/i.test(entry.name)) continue;

    const stat = fs.statSync(fullPath);
    const relativePath = path.relative(baseDir, fullPath).split(path.sep).join('/');
    const item = {
      name: entry.name,
      path: relativePath,
      type: getFileType(ext),
      size: stat.size,
      modified: stat.mtime.toISOString(),
    };

    if (item.type === 'video') {
      const thumbRel = relativePath.replace(/\.(mp4|mov)$/i, '.thumb.jpg');
      const thumbAbs = path.join(baseDir, thumbRel);
      if (fs.existsSync(thumbAbs)) {
        item.thumbPath = thumbRel;
      }
    }

    results.push(item);
  }

  return results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function listTrash() {
  return scanTrashDirectory(TRASH_DIR, TRASH_DIR);
}

function moveToTrash(relativePath) {
  const dataPath = resolveDataPath(relativePath);
  if (!dataPath) {
    const err = new Error('Path not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  assertNotActiveRecording(dataPath.relative);

  const wasFile = fs.statSync(dataPath.resolved).isFile();
  const affectedPaths = collectPathsFromEntry(dataPath.resolved);
  const destResolved = path.join(TRASH_DIR, dataPath.relative);
  const trashedRelative = moveEntry(dataPath.resolved, destResolved);

  // Keep gallery video posters with their clips.
  if (wasFile && /\.(mp4|mov)$/i.test(dataPath.relative)) {
    const thumbRel = dataPath.relative.replace(/\.(mp4|mov)$/i, '.thumb.jpg');
    const thumbSrc = path.join(DATA_DIR, thumbRel);
    if (fs.existsSync(thumbSrc) && fs.statSync(thumbSrc).isFile()) {
      const thumbDest = path.join(TRASH_DIR, thumbRel);
      try {
        moveEntry(thumbSrc, thumbDest);
      } catch {
        /* ignore thumb move failures */
      }
    }
  }

  if (wasFile) {
    const parent = path.dirname(dataPath.resolved);
    if (parent !== DATA_DIR) {
      removeEmptyParentDirs(parent, DATA_DIR);
    }
  }

  clearResultsForPaths(affectedPaths);

  return { path: trashedRelative };
}

function restoreFromTrash(relativePath) {
  const trashPath = resolveTrashPath(relativePath);
  if (!trashPath) {
    const err = new Error('Trashed item not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const destResolved = path.join(DATA_DIR, trashPath.relative);
  if (fs.existsSync(destResolved)) {
    const err = new Error('A file already exists at the original location');
    err.code = 'CONFLICT';
    throw err;
  }

  fs.mkdirSync(path.dirname(destResolved), { recursive: true });
  fs.renameSync(trashPath.resolved, destResolved);

  const parent = path.dirname(trashPath.resolved);
  if (parent !== TRASH_DIR) {
    removeEmptyParentDirs(parent, TRASH_DIR);
  }

  return { path: trashPath.relative };
}

function deleteFromTrashPermanent(relativePath) {
  const trashPath = resolveTrashPath(relativePath);
  if (!trashPath) {
    const err = new Error('Trashed item not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  fs.rmSync(trashPath.resolved, { recursive: true, force: true });

  const parent = path.dirname(trashPath.resolved);
  if (parent !== TRASH_DIR) {
    removeEmptyParentDirs(parent, TRASH_DIR);
  }

  return { path: trashPath.relative };
}

function emptyTrash() {
  if (fs.existsSync(TRASH_DIR)) {
    fs.rmSync(TRASH_DIR, { recursive: true, force: true });
  }
  ensureTrashDir();
  return { success: true };
}

function resolveTrashFileForServe(relativePath) {
  const trashPath = resolveTrashPath(relativePath);
  if (!trashPath) return null;

  const stat = fs.statSync(trashPath.resolved);
  if (!stat.isFile()) return null;

  return trashPath.resolved;
}

module.exports = {
  DATA_DIR,
  TRASH_DIR,
  resolveDataPath,
  resolveTrashPath,
  resolveTrashFileForServe,
  moveToTrash,
  restoreFromTrash,
  listTrash,
  emptyTrash,
  deleteFromTrashPermanent,
  clearResultsForPaths,
};
