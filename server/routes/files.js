const path = require('path');
const fs = require('fs');
const express = require('express');
const { scanDataFolder } = require('../utils/fileScanner');

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
