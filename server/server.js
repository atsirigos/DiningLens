const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const filesRouter = require('./routes/files');
const settingsRouter = require('./routes/settings');
const processRouter = require('./routes/process');
const usageRouter = require('./routes/usage');
const phoneRouter = require('./routes/phone');
const recordingRouter = require('./routes/recording');
const trashRouter = require('./routes/trash');
const { getDb } = require('./db/database');
const { startChargeManager } = require('./chargeManager');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PROCESSED_DIR = path.join(ROOT, 'processed');
const RESULTS_FILE = path.join(PROCESSED_DIR, 'results.json');

function ensureStartup() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(PROCESSED_DIR)) {
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  }
  if (!fs.existsSync(RESULTS_FILE)) {
    fs.writeFileSync(RESULTS_FILE, '{}', 'utf8');
  }
  getDb();
}

ensureStartup();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/captures', express.static(path.join(ROOT, 'captures')));

app.use('/api', filesRouter);
app.use('/api', settingsRouter);
app.use('/api', processRouter);
app.use('/api', usageRouter);
app.use('/api', phoneRouter);
app.use('/api', recordingRouter);
app.use('/api', trashRouter);

app.listen(PORT, () => {
  console.log(`DiningLens server running at http://localhost:${PORT}`);
  startChargeManager();
});
