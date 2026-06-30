const path = require('node:path');
const fs = require('node:fs/promises');
const { ensureConnected, takePhoto, getActiveDevice } = require('./androidCamera');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');

const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_MAX_MINUTES = 30;
const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 600;
const MIN_MAX_MINUTES = 1;
const MAX_MAX_MINUTES = 240;
const MAX_CONSECUTIVE_FAILURES = 5;

let session = null;
let intervalTimer = null;
let maxDurationTimer = null;
let captureInFlight = false;
let nextCaptureAt = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseIntervalSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_SECONDS;
  return clamp(Math.round(parsed), MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
}

function parseMaxMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_MINUTES;
  return clamp(Math.round(parsed), MIN_MAX_MINUTES, MAX_MAX_MINUTES);
}

function makeSessionId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('-');
}

function clearTimers() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (maxDurationTimer) {
    clearTimeout(maxDurationTimer);
    maxDurationTimer = null;
  }
  nextCaptureAt = null;
}

function buildFrame(sessionId, file) {
  if (!sessionId || !file) return null;
  const relativePath = path.posix.join('recordings', sessionId, file);
  return {
    file,
    relativePath,
    url: `/api/file/${encodeURIComponent(relativePath)}`,
  };
}

function getPublicSession() {
  if (!session) return null;
  const { destDir, ...publicSession } = session;
  return {
    ...publicSession,
    frames: session.frames || [],
  };
}

function getBaseStatus() {
  if (!session) {
    return {
      status: 'idle',
      sessionId: null,
      startedAt: null,
      stoppedAt: null,
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      maxMinutes: DEFAULT_MAX_MINUTES,
      intervalMs: DEFAULT_INTERVAL_SECONDS * 1000,
      maxDurationMs: DEFAULT_MAX_MINUTES * 60 * 1000,
      framesCaptured: 0,
      frames: [],
      lastError: null,
      errors: [],
      consecutiveFailures: 0,
      elapsedMs: 0,
      remainingMs: 0,
      nextCaptureInMs: null,
    };
  }

  const now = Date.now();
  const startedAtMs = session.startedAt ? Date.parse(session.startedAt) : now;
  const elapsedMs = Math.max(0, now - startedAtMs);
  const remainingMs = session.status === 'recording'
    ? Math.max(0, session.maxDurationMs - elapsedMs)
    : 0;
  const nextCaptureInMs = session.status === 'recording' && nextCaptureAt
    ? Math.max(0, nextCaptureAt - now)
    : null;

  return {
    ...getPublicSession(),
    elapsedMs,
    remainingMs,
    nextCaptureInMs,
  };
}

async function captureFrame() {
  if (!session || session.status !== 'recording' || captureInFlight) {
    return;
  }

  captureInFlight = true;
  try {
    const { file, localPath } = await takePhoto({
      device: session.device,
      destDir: session.destDir,
    });
    const frame = buildFrame(session.sessionId, file);
    session.frames.push(frame);
    session.framesCaptured += 1;
    session.lastError = null;
    session.consecutiveFailures = 0;
    session.errors = session.errors.slice(-9);
    console.log(`[recording] captured frame ${session.framesCaptured}: ${localPath}`);
  } catch (err) {
    session.consecutiveFailures += 1;
    session.lastError = err.message;
    session.errors = [...session.errors.slice(-9), {
      at: new Date().toISOString(),
      message: err.message,
    }];
    console.error('[recording] capture failed:', err.message);

    if (session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      session.status = 'error';
      session.stoppedAt = new Date().toISOString();
      session.stopReason = 'too_many_failures';
      clearTimers();
    }
  } finally {
    captureInFlight = false;
    if (session?.status === 'recording') {
      nextCaptureAt = Date.now() + session.intervalMs;
    }
  }
}

function scheduleCaptureLoop() {
  nextCaptureAt = Date.now() + session.intervalMs;
  intervalTimer = setInterval(() => {
    captureFrame();
  }, session.intervalMs);
}

async function startRecording({ intervalSeconds, maxMinutes } = {}) {
  if (session?.status === 'recording') {
    throw new Error('A recording session is already in progress.');
  }

  const interval = parseIntervalSeconds(intervalSeconds);
  const maxMins = parseMaxMinutes(maxMinutes);
  const intervalMs = interval * 1000;
  const maxDurationMs = maxMins * 60 * 1000;

  await ensureConnected();

  const activeDevice = getActiveDevice();
  if (!activeDevice) {
    throw new Error('No active device configured. Add and select a device in Phone Configuration.');
  }

  const sessionId = makeSessionId();
  const destDir = path.join(RECORDINGS_DIR, sessionId);
  await fs.mkdir(destDir, { recursive: true });

  clearTimers();
  captureInFlight = false;

  session = {
    status: 'recording',
    sessionId,
    destDir,
    device: activeDevice,
    deviceId: activeDevice.id,
    deviceName: activeDevice.name,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    stopReason: null,
    intervalSeconds: interval,
    maxMinutes: maxMins,
    intervalMs,
    maxDurationMs,
    framesCaptured: 0,
    frames: [],
    lastError: null,
    errors: [],
    consecutiveFailures: 0,
  };

  await captureFrame();
  scheduleCaptureLoop();

  maxDurationTimer = setTimeout(() => {
    if (session?.status === 'recording') {
      session.status = 'stopped';
      session.stoppedAt = new Date().toISOString();
      session.stopReason = 'max_duration';
      clearTimers();
      console.log(`[recording] stopped after max duration (${maxMins} min)`);
    }
  }, maxDurationMs);

  return getStatus();
}

function stopRecording() {
  if (!session || session.status !== 'recording') {
    return getStatus();
  }

  session.status = 'stopped';
  session.stoppedAt = new Date().toISOString();
  session.stopReason = session.stopReason || 'manual';
  clearTimers();
  console.log(`[recording] stopped manually (${session.framesCaptured} frames)`);
  return getStatus();
}

function getStatus() {
  return getBaseStatus();
}

module.exports = {
  startRecording,
  stopRecording,
  getStatus,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_MINUTES,
};
