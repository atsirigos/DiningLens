const { getSettings } = require('./db/settingsStore');
const { getActiveDevice, ensureConnectedForDevice } = require('./androidCamera');
const { applyChargeControl } = require('./utils/chargeControl');

const CHECK_INTERVAL_MS = 30000;

let timer = null;
let running = false;

async function tick() {
  if (running) return;

  const settings = getSettings();
  const config = settings.phone?.chargeControl;
  if (!config?.enabled) return;

  const device = getActiveDevice();
  if (!device) return;

  running = true;
  try {
    const serial = await ensureConnectedForDevice(device);
    await applyChargeControl(serial, config);
  } catch (err) {
    console.warn('[chargeManager] tick failed:', err.message);
  } finally {
    running = false;
  }
}

function startChargeManager() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch(() => {});
  }, CHECK_INTERVAL_MS);
  tick().catch(() => {});
}

function stopChargeManager() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startChargeManager,
  stopChargeManager,
  tickChargeControl: tick,
};
