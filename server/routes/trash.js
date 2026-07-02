const path = require('path');
const express = require('express');
const {
  listTrash,
  moveToTrash,
  restoreFromTrash,
  emptyTrash,
  deleteFromTrashPermanent,
  resolveTrashFileForServe,
} = require('../utils/trashManager');

const router = express.Router();

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function handleTrashError(err, res) {
  if (err.code === 'NOT_FOUND') {
    return res.status(404).json({ error: err.message });
  }
  if (err.code === 'CONFLICT' || err.code === 'ACTIVE_RECORDING') {
    return res.status(409).json({ error: err.message });
  }
  return res.status(500).json({ error: err.message || 'Trash operation failed' });
}

router.get('/trash', (req, res) => {
  try {
    res.json(listTrash());
  } catch (err) {
    handleTrashError(err, res);
  }
});

router.get('/trash/file/*filepath', (req, res) => {
  const filePath = resolveTrashFileForServe(req.params.filepath);
  if (!filePath) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  res.sendFile(filePath);
});

router.post('/trash', (req, res) => {
  const { path: itemPath } = req.body || {};
  if (!itemPath) {
    return res.status(400).json({ error: 'path is required' });
  }

  try {
    const result = moveToTrash(itemPath);
    res.json(result);
  } catch (err) {
    handleTrashError(err, res);
  }
});

router.post('/trash/restore', (req, res) => {
  const { path: itemPath } = req.body || {};
  if (!itemPath) {
    return res.status(400).json({ error: 'path is required' });
  }

  try {
    const result = restoreFromTrash(itemPath);
    res.json(result);
  } catch (err) {
    handleTrashError(err, res);
  }
});

router.delete('/trash', (req, res) => {
  try {
    res.json(emptyTrash());
  } catch (err) {
    handleTrashError(err, res);
  }
});

router.delete('/trash/*filepath', (req, res) => {
  try {
    const result = deleteFromTrashPermanent(req.params.filepath);
    res.json(result);
  } catch (err) {
    handleTrashError(err, res);
  }
});

module.exports = router;
