const path = require('path');
const fs = require('fs');
const express = require('express');
const { analyzeImage } = require('../utils/aiWrapper');
const { getSettings } = require('../db/settingsStore');

const router = express.Router();
const RESULTS_FILE = path.join(__dirname, '..', '..', 'processed', 'results.json');
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function readResults() {
  if (!fs.existsSync(RESULTS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeResults(results) {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf8');
}

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

router.get('/results', (req, res) => {
  try {
    res.json(readResults());
  } catch (err) {
    res.status(500).json({ error: 'Failed to read results' });
  }
});

router.post('/process', async (req, res) => {
  const { filename, userContext } = req.body;

  if (!filename) {
    return res.status(400).json({ error: 'filename is required' });
  }

  const filePath = resolveSafePath(filename);
  if (!filePath) {
    return res.status(404).json({ error: 'File not found' });
  }

  const results = readResults();

  if (results[filename]) {
    return res.json({ cached: true, result: results[filename] });
  }

  try {
    const settings = getSettings();
    const result = await analyzeImage(filePath, settings, userContext);
    result.processedAt = new Date().toISOString();
    result.filename = filename;

    results[filename] = result;
    writeResults(results);

    res.json({ cached: false, result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Processing failed' });
  }
});

router.delete('/process/*filepath', (req, res) => {
  const filename = decodeURIComponent(req.params.filepath);
  const results = readResults();

  if (!results[filename]) {
    return res.status(404).json({ error: 'No cached result for this file' });
  }

  delete results[filename];
  writeResults(results);
  res.json({ success: true });
});

module.exports = router;
