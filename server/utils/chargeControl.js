const { adbShell } = require('../androidCamera');

const TOGGLE_PATHS = [
  { path: '/sys/class/power_supply/battery/charging_enabled' },
  { path: '/sys/class/power_supply/battery/battery_charging_enabled' },
  { path: '/sys/class/power_supply/battery/input_suspend' },
  { path: '/sys/class/power_supply/main/charging_enabled' },
  { path: '/sys/class/power_supply/battery/batt_slate_mode', inverted: true },
];

const THRESHOLD_PROFILES = [
  {
    stopPath: '/sys/devices/platform/google,charger/charge_stop_level',
    startPath: '/sys/devices/platform/google,charger/charge_start_level',
  },
];

const capabilityCache = new Map();
let lastStatus = null;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const { normalizeChargeControl } = require('./chargeControlConfig');

function parseBatteryPlugged(dump) {
  const text = dump || '';
  return /AC powered:\s*true/i.test(text)
    || /USB powered:\s*true/i.test(text)
    || /Wireless powered:\s*true/i.test(text);
}

async function adbShellRoot(serial, cmd) {
  const quoted = shellQuote(cmd);
  const attempts = [
    `su -c ${quoted}`,
    `su 0 sh -c ${quoted}`,
    `su root sh -c ${quoted}`,
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      return await adbShell(serial, attempt);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Root shell unavailable');
}

async function readSysfs(serial, filePath, { root = false } = {}) {
  const cmd = `cat ${filePath}`;
  const out = root ? await adbShellRoot(serial, cmd) : await adbShell(serial, cmd);
  return out.trim();
}

async function writeSysfs(serial, filePath, value, { root = true } = {}) {
  const cmd = `echo ${value} > ${filePath}`;
  if (root) {
    await adbShellRoot(serial, cmd);
  } else {
    await adbShell(serial, cmd);
  }
}

async function hasRootShell(serial) {
  try {
    const out = await adbShellRoot(serial, 'id');
    return /uid=0/.test(out);
  } catch {
    return false;
  }
}

function chargingEnabledFromSysfs(capability, rawValue) {
  if (capability.inverted) return rawValue === '0';
  return rawValue === '1';
}

function sysfsValueForCharging(capability, enabled) {
  if (capability.inverted) return enabled ? '0' : '1';
  return enabled ? '1' : '0';
}

async function detectCapability(serial) {
  if (capabilityCache.has(serial)) {
    return capabilityCache.get(serial);
  }

  const rooted = await hasRootShell(serial);

  for (const profile of THRESHOLD_PROFILES) {
    try {
      await readSysfs(serial, profile.stopPath);
      await readSysfs(serial, profile.startPath);
      const capability = { mode: 'threshold', ...profile, writable: rooted };
      capabilityCache.set(serial, capability);
      return capability;
    } catch {
      /* try next profile */
    }
  }

  for (const entry of TOGGLE_PATHS) {
    try {
      const value = await readSysfs(serial, entry.path);
      if (value === '0' || value === '1') {
        const capability = {
          mode: 'toggle',
          path: entry.path,
          inverted: Boolean(entry.inverted),
          writable: rooted,
        };
        capabilityCache.set(serial, capability);
        return capability;
      }
    } catch {
      /* try next path */
    }
  }

  const capability = { mode: 'unsupported', writable: false };
  capabilityCache.set(serial, capability);
  return capability;
}

async function applyThresholdControl(serial, capability, config) {
  await writeSysfs(serial, capability.startPath, config.startAt);
  await writeSysfs(serial, capability.stopPath, config.stopAt);
  return {
    action: 'threshold_set',
    startAt: config.startAt,
    stopAt: config.stopAt,
    mode: 'threshold',
  };
}

async function applyToggleControl(serial, capability, battery, config) {
  const level = battery.level;
  if (level == null) {
    return { action: 'skipped', reason: 'battery_level_unknown', mode: 'toggle' };
  }

  let current;
  try {
    current = await readSysfs(serial, capability.path, { root: true });
  } catch (err) {
    return { action: 'error', reason: err.message, mode: 'toggle' };
  }

  const chargingEnabled = chargingEnabledFromSysfs(capability, current);

  if (!battery.plugged) {
    if (!chargingEnabled) {
      await writeSysfs(serial, capability.path, sysfsValueForCharging(capability, true));
      return { action: 'enabled', reason: 'unplugged_reset', mode: 'toggle', level };
    }
    return { action: 'skipped', reason: 'not_plugged', mode: 'toggle', level };
  }

  if (level >= config.stopAt && chargingEnabled) {
    await writeSysfs(serial, capability.path, sysfsValueForCharging(capability, false));
    return {
      action: 'disabled',
      reason: `battery at ${level}% (stop ${config.stopAt}%)`,
      mode: 'toggle',
      level,
    };
  }

  if (level <= config.startAt && !chargingEnabled) {
    await writeSysfs(serial, capability.path, sysfsValueForCharging(capability, true));
    return {
      action: 'enabled',
      reason: `battery at ${level}% (start ${config.startAt}%)`,
      mode: 'toggle',
      level,
    };
  }

  return {
    action: 'unchanged',
    reason: `battery at ${level}% (range ${config.startAt}-${config.stopAt}%)`,
    mode: 'toggle',
    level,
    chargingEnabled,
  };
}

async function applyChargeControl(serial, rawConfig, { batteryDump = null } = {}) {
  const config = normalizeChargeControl(rawConfig);
  const status = {
    enabled: config.enabled,
    startAt: config.startAt,
    stopAt: config.stopAt,
    supported: false,
    mode: 'unsupported',
    action: 'skipped',
    reason: null,
    plugged: null,
    level: null,
    at: new Date().toISOString(),
  };

  if (!config.enabled) {
    status.reason = 'disabled_in_settings';
    lastStatus = status;
    return status;
  }

  const capability = await detectCapability(serial);
  status.mode = capability.mode;
  status.supported = capability.mode !== 'unsupported' && capability.writable;

  if (!status.supported) {
    status.reason = capability.mode === 'unsupported'
      ? 'Device does not expose a known charge control interface (root may be required)'
      : 'Charge control path is read-only without root';
    lastStatus = status;
    return status;
  }

  let battery = { level: null, plugged: false, charging: false };
  try {
    const dump = batteryDump || await adbShell(serial, 'dumpsys battery');
    const levelMatch = dump.match(/level:\s*(\d+)/i);
    const statusMatch = dump.match(/status:\s*(\d+)/i);
    battery = {
      level: levelMatch ? Number(levelMatch[1]) : null,
      plugged: parseBatteryPlugged(dump),
      charging: statusMatch ? (Number(statusMatch[1]) === 2 || Number(statusMatch[1]) === 5) : false,
    };
  } catch (err) {
    status.action = 'error';
    status.reason = err.message;
    lastStatus = status;
    return status;
  }

  status.plugged = battery.plugged;
  status.level = battery.level;

  if (!battery.plugged && capability.mode === 'toggle') {
    const toggleResult = await applyToggleControl(serial, capability, battery, config);
    lastStatus = { ...status, ...toggleResult };
    return lastStatus;
  }

  if (!battery.plugged) {
    status.reason = 'not_plugged';
    lastStatus = status;
    return status;
  }

  try {
    if (capability.mode === 'threshold') {
      const result = await applyThresholdControl(serial, capability, config);
      lastStatus = { ...status, ...result, supported: true };
      return lastStatus;
    }

    const result = await applyToggleControl(serial, capability, battery, config);
    lastStatus = { ...status, ...result, supported: true };
    return lastStatus;
  } catch (err) {
    status.action = 'error';
    status.reason = err.message;
    lastStatus = status;
    return status;
  }
}

function getLastChargeControlStatus() {
  return lastStatus;
}

function clearCapabilityCache(serial = null) {
  if (serial) capabilityCache.delete(serial);
  else capabilityCache.clear();
}

module.exports = {
  normalizeChargeControl,
  applyChargeControl,
  getLastChargeControlStatus,
  clearCapabilityCache,
  detectCapability,
};
