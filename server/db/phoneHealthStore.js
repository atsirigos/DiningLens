const { getDb } = require('./database');

const MAX_SAMPLES_PER_DEVICE = 500;

function migrate() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS phone_health_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      battery_level INTEGER,
      temperature_celsius REAL,
      storage_percent INTEGER,
      refresh_interval_sec INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_phone_health_device_fetched
      ON phone_health_samples(device_id, fetched_at);
  `);
}

function normalizeSample(row) {
  return {
    t: row.fetched_at,
    battery: row.battery_level,
    temp: row.temperature_celsius,
    storage: row.storage_percent,
    intervalSec: row.refresh_interval_sec,
  };
}

function recordHealthSample(deviceId, health, refreshIntervalSec = null) {
  if (!deviceId || !health?.fetchedAt) return null;

  migrate();
  const database = getDb();

  const interval = Number(refreshIntervalSec);
  const refreshSec = Number.isFinite(interval) && interval > 0 ? Math.round(interval) : null;

  database.prepare(`
    INSERT INTO phone_health_samples (
      device_id,
      fetched_at,
      battery_level,
      temperature_celsius,
      storage_percent,
      refresh_interval_sec
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    deviceId,
    health.fetchedAt,
    health.battery?.level ?? null,
    health.battery?.temperatureCelsius ?? null,
    health.storage?.usedPercent ?? null,
    refreshSec,
  );

  const overflow = database.prepare(`
    SELECT COUNT(*) AS count FROM phone_health_samples WHERE device_id = ?
  `).get(deviceId).count - MAX_SAMPLES_PER_DEVICE;

  if (overflow > 0) {
    database.prepare(`
      DELETE FROM phone_health_samples
      WHERE id IN (
        SELECT id FROM phone_health_samples
        WHERE device_id = ?
        ORDER BY fetched_at ASC, id ASC
        LIMIT ?
      )
    `).run(deviceId, overflow);
  }

  return getLatestSample(deviceId);
}

function getLatestSample(deviceId) {
  migrate();
  const database = getDb();
  const row = database.prepare(`
    SELECT
      fetched_at,
      battery_level,
      temperature_celsius,
      storage_percent,
      refresh_interval_sec
    FROM phone_health_samples
    WHERE device_id = ?
    ORDER BY fetched_at DESC, id DESC
    LIMIT 1
  `).get(deviceId);

  return row ? normalizeSample(row) : null;
}

function getHealthHistory(deviceId, { limit = 120 } = {}) {
  if (!deviceId) return [];

  migrate();
  const database = getDb();
  const capped = Math.min(Math.max(1, Number(limit) || 120), MAX_SAMPLES_PER_DEVICE);

  const rows = database.prepare(`
    SELECT
      fetched_at,
      battery_level,
      temperature_celsius,
      storage_percent,
      refresh_interval_sec
    FROM (
      SELECT
        fetched_at,
        battery_level,
        temperature_celsius,
        storage_percent,
        refresh_interval_sec,
        id
      FROM phone_health_samples
      WHERE device_id = ?
      ORDER BY fetched_at DESC, id DESC
      LIMIT ?
    )
    ORDER BY fetched_at ASC, id ASC
  `).all(deviceId, capped);

  return rows.map(normalizeSample);
}

function clearHealthHistory(deviceId) {
  if (!deviceId) return 0;

  migrate();
  const database = getDb();
  const result = database.prepare(`
    DELETE FROM phone_health_samples WHERE device_id = ?
  `).run(deviceId);

  return result.changes;
}

module.exports = {
  MAX_SAMPLES_PER_DEVICE,
  recordHealthSample,
  getHealthHistory,
  clearHealthHistory,
};
