const path = require('path');
const fs = require('fs');
const express = require('express');
const { scanDataFolder } = require('../utils/fileScanner');
const { getSettings } = require('../db/settingsStore');
const { cropZoneFromPhoto } = require('../utils/zoneCropper');
const { rotateImageFile, normalizeOrientation } = require('../utils/imageRotate');
const { thumbPathForVideo, ensureVideoThumbnail } = require('../utils/videoThumb');

const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function resolveSafePath(filename) {
  let raw = filename;
  if (Array.isArray(raw)) {
    raw = raw.map(String).join('/');
  }
  const decoded = decodeURIComponent(String(raw || ''));
  const resolved = path.resolve(DATA_DIR, decoded);
  const normalizedData = path.resolve(DATA_DIR);

  if (!resolved.startsWith(normalizedData + path.sep) && resolved !== normalizedData) {
    return null;
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return null;
  }

  return resolved;
}

async function attachVideoThumbs(files) {
  const enriched = [];
  for (const file of files) {
    if (file.type !== 'video') {
      enriched.push(file);
      continue;
    }

    const absVideo = path.join(DATA_DIR, file.path);
    const thumbRel = thumbPathForVideo(file.path).split(path.sep).join('/');
    const absThumb = path.join(DATA_DIR, thumbRel);

    if (!fs.existsSync(absThumb)) {
      try {
        await ensureVideoThumbnail(absVideo);
      } catch (err) {
        console.warn(`[files] video thumb failed for ${file.path}:`, err.message);
      }
    }

    enriched.push({
      ...file,
      thumbPath: fs.existsSync(absThumb) ? thumbRel : null,
    });
  }
  return enriched;
}

router.get('/files', async (req, res) => {
  try {
    const files = scanDataFolder(DATA_DIR);
    const withThumbs = await attachVideoThumbs(files);
    res.json(withThumbs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to scan data folder' });
  }
});

router.get('/zone-crop', async (req, res) => {
  try {
    const { file, zone } = req.query;
    if (!file || !zone) {
      return res.status(400).json({ error: 'file and zone query parameters are required' });
    }

    const filePath = resolveSafePath(file);
    if (!filePath) {
      return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      return res.status(400).json({ error: 'Zone crops are only available for images' });
    }

    const zoneName = decodeURIComponent(zone);
    const settings = getSettings();
    const zoneConfig = settings.zones.find((entry) => entry.name === zoneName);
    if (!zoneConfig) {
      return res.status(404).json({ error: `Zone "${zoneName}" not found in settings` });
    }

    const image = await cropZoneFromPhoto(filePath, zoneConfig, settings.referenceOrientation);
    const buffer = Buffer.from(image.base64, 'base64');
    res.setHeader('Content-Type', image.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to crop zone' });
  }
});

router.post('/files/rotate', async (req, res) => {
  try {
    const { path: filePath, degrees } = req.body || {};
    if (!filePath) {
      return res.status(400).json({ error: 'path is required' });
    }

    const resolved = resolveSafePath(filePath);
    if (!resolved) {
      return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(resolved).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      return res.status(400).json({ error: 'Only image files can be rotated' });
    }

    const rotation = normalizeOrientation(degrees ?? 90);
    if (rotation === 0) {
      return res.status(400).json({ error: 'degrees must be 90, 180, or 270' });
    }

    await rotateImageFile(resolved, rotation);
    res.json({ success: true, path: filePath, degrees: rotation });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to rotate image' });
  }
});

router.get('/file/*filepath', (req, res) => {
  const filename = req.params.filepath;
  const filePath = resolveSafePath(filename);

  if (!filePath) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  // Range support is required for MP4s with moov-at-end (screenrecord output)
  res.sendFile(filePath, { acceptRanges: true }, (err) => {
    if (err && !res.headersSent) {
      res.status(err.statusCode || 500).json({ error: err.message || 'Failed to send file' });
    }
  });
});

module.exports = router;
