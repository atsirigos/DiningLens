const { getDb } = require('./database');

function migrate() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS meal_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      result_json TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      frame_time_sec REAL,
      media_type TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_meal_analyses_processed_at
      ON meal_analyses(processed_at);
  `);
}

function saveMealAnalysis(filePath, result) {
  if (!filePath || !result) return;
  migrate();
  const database = getDb();
  const frameTime = Number(result.frameTimeSec);
  database.prepare(`
    INSERT INTO meal_analyses (
      file_path, result_json, processed_at, frame_time_sec, media_type
    ) VALUES (
      @file_path, @result_json, @processed_at, @frame_time_sec, @media_type
    )
    ON CONFLICT(file_path) DO UPDATE SET
      result_json = excluded.result_json,
      processed_at = excluded.processed_at,
      frame_time_sec = excluded.frame_time_sec,
      media_type = excluded.media_type
  `).run({
    file_path: filePath,
    result_json: JSON.stringify(result),
    processed_at: result.processedAt || new Date().toISOString(),
    frame_time_sec: Number.isFinite(frameTime) && frameTime >= 0 ? frameTime : null,
    media_type: result.mediaType || null,
  });
}

function deleteMealAnalysis(filePath) {
  const keys = Array.isArray(filePath) ? filePath : [filePath];
  const cleaned = [...new Set(keys.map((key) => String(key || '').trim()).filter(Boolean))];
  if (!cleaned.length) return;
  migrate();
  const database = getDb();
  const remove = database.prepare(`
    DELETE FROM meal_analyses
    WHERE file_path = @path
       OR file_path = @base
       OR file_path LIKE @suffix
  `);
  const tx = database.transaction((list) => {
    for (const key of list) {
      const base = key.split('/').pop();
      remove.run({
        path: key,
        base,
        suffix: `%/${base}`,
      });
    }
  });
  tx(cleaned);
}

module.exports = {
  saveMealAnalysis,
  deleteMealAnalysis,
};
