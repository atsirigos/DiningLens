function clampPercent(value, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(1, parsed));
}

function normalizeChargeControl(raw) {
  const cc = raw || {};
  let stopAt = clampPercent(cc.stopAt, 80);
  let startAt = clampPercent(cc.startAt, 20);
  if (startAt >= stopAt) startAt = Math.max(1, stopAt - 1);

  return {
    enabled: cc.enabled !== false,
    stopAt,
    startAt,
  };
}

module.exports = {
  normalizeChargeControl,
};
