const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_DIR = path.join(__dirname, '..', '..', 'db');
const LEGACY_DB_PATH = path.join(DB_DIR, 'smartdining.db');
const DB_PATH = path.join(DB_DIR, 'dininglens.db');

let db;

function migrateLegacyDatabase() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH) || !fs.existsSync(LEGACY_DB_PATH)) {
    return;
  }

  fs.renameSync(LEGACY_DB_PATH, DB_PATH);

  for (const suffix of ['-wal', '-shm']) {
    const legacySidecar = `${LEGACY_DB_PATH}${suffix}`;
    const newSidecar = `${DB_PATH}${suffix}`;
    if (fs.existsSync(legacySidecar)) {
      fs.renameSync(legacySidecar, newSidecar);
    }
  }
}

function getDb() {
  if (!db) {
    migrateLegacyDatabase();
    fs.mkdirSync(DB_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb, DB_PATH, LEGACY_DB_PATH };
