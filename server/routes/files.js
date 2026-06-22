const path = require('path');
const fs = require('fs');
const express = require('express');
const { scanDataFolder } = require('../utils/fileScanner');
const { getSettings } = require('../db/settingsStore');
const { cropZoneFromPhoto } = require('../utils/zoneCropper');

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
  const decoded = decodeURIComponent(filename);
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

router.get('/files', (req, res) => {
  try {
    const files = scanDataFolder(DATA_DIR);
    res.json(files);
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

    const image = await cropZoneFromPhoto(filePath, zoneConfig);
    const buffer = Buffer.from(image.base64, 'base64');
    res.setHeader('Content-Type', image.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to crop zone' });
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
  res.sendFile(filePath);
});

module.exports = router;
