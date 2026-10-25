const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { getSettings } = require('../db/settingsStore');
const { cropZoneFromPhoto, cropZoneFromBuffer } = require('./zoneCropper');
const { extractVideoFrame } = require('./videoFrame');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CACHE_DIR = path.join(__dirname, '..', '..', 'processed', 'frame-thumbs');
const VIDEO_EXTS = new Set(['.mp4', '.mov']);
const THUMB_WIDTH = 420;
const SOURCE_MAX_WIDTH = 1280;
const MAX_PARALLEL = 2;

let active = 0;
const waiters = [];
const inflight = new Map();

function withSlot(work) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          const next = waiters.shift();
          if (next) next();
        });
    };
    if (active < MAX_PARALLEL) run();
    else waiters.push(run);
  });
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function thumbKey({ fileRel, stat, timeSec, zone, orientation }) {
  const payload = JSON.stringify({
    file: fileRel,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    timeSec: Number.isFinite(Number(timeSec)) ? round4(timeSec) : null,
    orientation: orientation ?? null,
    zone: {
      name: zone.name,
      x: round4(zone.x),
      y: round4(zone.y),
      width: round4(zone.width),
      height: round4(zone.height),
    },
  });
  return crypto.createHash('sha1').update(payload).digest('hex');
}

async function writeThumb(dest, buffer) {
  await fsPromises.mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await fsPromises.writeFile(tmp, buffer);
  await fsPromises.rename(tmp, dest);
}

async function renderThumb({ filePath, timeSec, zone, orientation, isVideo }) {
  const image = isVideo
    ? await cropZoneFromBuffer(
      (await extractVideoFrame(filePath, { timeSec, maxWidth: SOURCE_MAX_WIDTH })).buffer,
      zone,
      orientation,
    )
    : await cropZoneFromPhoto(filePath, zone, orientation);

  return sharp(Buffer.from(image.base64, 'base64'))
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toBuffer();
}

/**
 * Small JPEG of one zone crop. Reused across requests and page reloads.
 * Returns the absolute path of the cached file.
 */
function ensureZoneCropThumb({ filePath, fileRel, timeSec, zone, orientation }) {
  const stat = fs.statSync(filePath);
  const isVideo = VIDEO_EXTS.has(path.extname(filePath).toLowerCase());
  const key = thumbKey({ fileRel, stat, timeSec: isVideo ? timeSec : null, zone, orientation });
  const dest = path.join(CACHE_DIR, `${key}.jpg`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 64) return Promise.resolve(dest);

  const pending = inflight.get(key);
  if (pending) return pending;

  const job = withSlot(() => renderThumb({
    filePath,
    timeSec,
    zone,
    orientation,
    isVideo,
  })).then((buffer) => writeThumb(dest, buffer).then(() => dest));

  const tracked = job.finally(() => {
    if (inflight.get(key) === tracked) inflight.delete(key);
  });
  inflight.set(key, tracked);
  return tracked;
}

function resolveDataFile(fileRel) {
  const decoded = decodeURIComponent(String(fileRel || '')).replace(/\\/g, '/');
  if (!decoded || decoded.includes('..')) return null;
  const resolved = path.resolve(DATA_DIR, decoded);
  const root = path.resolve(DATA_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

function zonesForResult(result, settings, isVideo) {
  const list = (isVideo ? settings.videoZones : settings.zones) || [];
  const named = list.filter((zone) => zone?.name);
  const applied = Array.isArray(result?.zones_applied) ? result.zones_applied : [];
  if (!applied.length) return named;
  const wanted = new Set(applied);
  return named.filter((zone) => wanted.has(zone.name));
}

/** Build thumbnails for a saved analysis without blocking the processing response. */
function warmResultFrameThumbs(result) {
  const frames = Array.isArray(result?.frames) ? result.frames.slice() : [];
  if (!frames.length && result?.mediaType === 'video' && result?.filename) {
    frames.push({ file: result.filename, timeSec: result.frameTimeSec });
  }
  if (!frames.length) return;

  let settings;
  try {
    settings = getSettings();
  } catch (err) {
    console.warn('[thumbs] settings unavailable:', err.message);
    return;
  }

  for (const frame of frames) {
    const fileRel = String(frame?.file || '').replace(/\\/g, '/');
    const filePath = resolveDataFile(fileRel);
    if (!filePath) continue;
    const isVideo = VIDEO_EXTS.has(path.extname(filePath).toLowerCase());
    const orientation = isVideo ? settings.referenceVideoOrientation : settings.referenceOrientation;
    const timeSec = Number(frame.timeSec);
    for (const zone of zonesForResult(result, settings, isVideo)) {
      ensureZoneCropThumb({
        filePath,
        fileRel,
        timeSec: Number.isFinite(timeSec) && timeSec >= 0 ? timeSec : undefined,
        zone,
        orientation,
      }).catch((err) => {
        console.warn(`[thumbs] ${fileRel} / ${zone.name}:`, err.message);
      });
    }
  }
}

module.exports = {
  ensureZoneCropThumb,
  warmResultFrameThumbs,
};
