const { getDb } = require('./database');

function migrate() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS api_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      filename TEXT,
      zone_name TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_api_usage_created_at ON api_usage_log(created_at);
  `);
}

function logApiCall(entry) {
  migrate();
  const database = getDb();

  const inputTokens = Number(entry.inputTokens) || 0;
  const outputTokens = Number(entry.outputTokens) || 0;
  const totalTokens = Number(entry.totalTokens) || inputTokens + outputTokens;

  database.prepare(`
    INSERT INTO api_usage_log (
      provider, model, filename, zone_name,
      input_tokens, output_tokens, total_tokens,
      estimated_cost_usd, success, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.provider,
    entry.model,
    entry.filename || null,
    entry.zoneName || null,
    inputTokens,
    outputTokens,
    totalTokens,
    Number(entry.estimatedCostUsd) || 0,
    entry.success === false ? 0 : 1,
    entry.errorMessage || null,
  );
}

function getUsageSummary() {
  migrate();
  const database = getDb();

  const totals = database.prepare(`
    SELECT
      COUNT(*) AS total_calls,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful_calls,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed_calls,
      COALESCE(SUM(estimated_cost_usd), 0) AS total_cost_usd,
      COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens
    FROM api_usage_log
  `).get();

  const byProvider = database.prepare(`
    SELECT
      provider,
      COUNT(*) AS calls,
      COALESCE(SUM(estimated_cost_usd), 0) AS cost_usd
    FROM api_usage_log
    GROUP BY provider
    ORDER BY cost_usd DESC
  `).all();

  const byModel = database.prepare(`
    SELECT
      provider,
      model,
      COUNT(*) AS calls,
      COALESCE(SUM(estimated_cost_usd), 0) AS cost_usd
    FROM api_usage_log
    GROUP BY provider, model
    ORDER BY cost_usd DESC
  `).all();

  const recent = database.prepare(`
    SELECT
      id,
      created_at AS createdAt,
      provider,
      model,
      filename,
      zone_name AS zoneName,
      input_tokens AS inputTokens,
      output_tokens AS outputTokens,
      total_tokens AS totalTokens,
      estimated_cost_usd AS estimatedCostUsd,
      success,
      error_message AS errorMessage
    FROM api_usage_log
    ORDER BY id DESC
    LIMIT 25
  `).all().map((row) => ({
    ...row,
    success: Boolean(row.success),
  }));

  return {
    totalCalls: totals.total_calls || 0,
    successfulCalls: totals.successful_calls || 0,
    failedCalls: totals.failed_calls || 0,
    totalCostUsd: totals.total_cost_usd || 0,
    totalInputTokens: totals.total_input_tokens || 0,
    totalOutputTokens: totals.total_output_tokens || 0,
    byProvider,
    byModel,
    recent,
  };
}

function clearUsageLog() {
  migrate();
  const database = getDb();
  database.prepare('DELETE FROM api_usage_log').run();
}

module.exports = {
  logApiCall,
  getUsageSummary,
  clearUsageLog,
};
