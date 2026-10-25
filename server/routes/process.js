const path = require('path');
const fs = require('fs');
const express = require('express');
const { analyzeMedia } = require('../utils/aiWrapper');
const { analyzeMealDirectory } = require('../utils/mealConsensus');
const { getSettings } = require('../db/settingsStore');
const { saveMealAnalysis, deleteMealAnalysis } = require('../db/mealAnalysisStore');
const { syncFoodTaxonomy } = require('../utils/foodTaxonomy');
const { warmResultFrameThumbs } = require('../utils/zoneCropThumb');

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
  syncFoodTaxonomy(results);
}

function normalizeMealKey(mealPath) {
  const decoded = decodeURIComponent(String(mealPath || '')).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!/^recordings\/[^/]+$/.test(decoded) || decoded.includes('..')) return null;
  return decoded;
}

function resolveSafeMealDir(mealPath) {
  const key = normalizeMealKey(mealPath);
  if (!key) return null;
  const resolved = path.resolve(DATA_DIR, key);
  const normalizedData = path.resolve(DATA_DIR);
  if (!resolved.startsWith(normalizedData + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;
  return { key, dir: resolved };
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

router.get('/food-taxonomy', async (req, res) => {
  try {
    const taxonomy = await syncFoodTaxonomy(readResults());
    res.json(taxonomy);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to classify foods' });
  }
});

router.post('/process', async (req, res) => {
  const { filename, userContext, frameTimeSec } = req.body || {};

  if (!filename) {
    return res.status(400).json({ error: 'filename is required' });
  }

  const filePath = resolveSafePath(filename);
  if (!filePath) {
    return res.status(404).json({ error: 'File not found' });
  }

  const results = readResults();

  if (results[filename]) {
    saveMealAnalysis(filename, results[filename]);
    return res.json({ cached: true, result: results[filename] });
  }

  try {
    const settings = getSettings();
    const parsedFrameTime = Number(frameTimeSec);
    const result = await analyzeMedia(filePath, settings, userContext, {
      filename,
      ...(Number.isFinite(parsedFrameTime) && parsedFrameTime >= 0
        ? { frameTimeSec: parsedFrameTime }
        : {}),
    });
    result.processedAt = new Date().toISOString();
    result.filename = filename;

    results[filename] = result;
    writeResults(results);
    saveMealAnalysis(filename, result);
    warmResultFrameThumbs(result);

    res.json({ cached: false, result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Processing failed' });
  }
});

router.post('/process-meal', async (req, res) => {
  const { mealPath, userContext } = req.body || {};
  const located = resolveSafeMealDir(mealPath);
  if (!mealPath) {
    return res.status(400).json({ error: 'mealPath is required' });
  }
  if (!located) {
    return res.status(404).json({ error: 'Meal folder not found' });
  }

  const results = readResults();
  if (results[located.key]) {
    saveMealAnalysis(located.key, results[located.key]);
    return res.json({ cached: true, result: results[located.key] });
  }

  try {
    const settings = getSettings();
    const result = await analyzeMealDirectory(located.dir, located.key, settings, userContext);
    result.processedAt = new Date().toISOString();
    result.filename = located.key;

    results[located.key] = result;
    writeResults(results);
    saveMealAnalysis(located.key, result);
    warmResultFrameThumbs(result);

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
  deleteMealAnalysis(filename);
  res.json({ success: true });
});

module.exports = router;
