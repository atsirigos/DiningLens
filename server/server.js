const path = require('path');
const fs = require('fs');
const os = require('os');
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
const storageRouter = require('./routes/storage');
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
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
  },
}));

app.get('/remote', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'remote.html'));
});
app.use('/captures', express.static(path.join(ROOT, 'captures')));

app.use('/api', filesRouter);
app.use('/api', settingsRouter);
app.use('/api', processRouter);
app.use('/api', usageRouter);
app.use('/api', phoneRouter);
app.use('/api', recordingRouter);
app.use('/api', trashRouter);
app.use('/api', storageRouter);

function lanRemoteUrls(port) {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      const isIpv4 = addr.family === 'IPv4' || addr.family === 4;
      if (!isIpv4 || addr.internal) continue;
      urls.push(`http://${addr.address}:${port}/remote`);
    }
  }
  return urls;
}

app.listen(PORT, () => {
  console.log(`DiningLens server running at http://localhost:${PORT}`);
  for (const url of lanRemoteUrls(PORT)) {
    console.log(`Phone remote: ${url}`);
  }
  startChargeManager();
});
